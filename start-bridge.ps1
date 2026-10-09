<#
  start-bridge.ps1 — 后台启动统一模型桥服务。
  只会停止明确由 bridge.mjs 启动的旧进程；不会强杀端口上的无关程序。
#>
[CmdletBinding()]
param(
    [int]$Port = 8788,
    [ValidateSet("mimo", "workbuddy", "trae")]
    [string]$Upstream = "mimo",
    [string]$UpstreamUrl = "",
    [string]$UpstreamTokenFile = "",
    [ValidateSet("compatible", "raw")]
    [AllowEmptyString()]
    [string]$ChatMode = "",
    [switch]$Foreground
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dir = $PSScriptRoot
$entry = Join-Path $dir "bridge.mjs"
$pidFile = Join-Path $dir "bridge.pid"

if (-not (Test-Path -LiteralPath $entry)) {
    throw "找不到 bridge.mjs：$entry"
}

function Get-ProcessRecord([int]$ProcessId) {
    return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Test-BridgeProcess($ProcessRecord) {
    if (-not $ProcessRecord) { return $false }
    $commandLine = [string]$ProcessRecord.CommandLine
return ($commandLine -match "(?i)node(?:\.exe)?[`"']?(\s|`$)") -and
           ($commandLine -match '(?i)bridge\.mjs')
}

$occupants = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($occupant in ($occupants | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $record = Get-ProcessRecord -ProcessId $occupant
    if (-not (Test-BridgeProcess $record)) {
        throw "端口 $Port 被非 bridge 进程占用（PID $occupant：$($record.Name)）。不会停止它，请换一个端口。"
    }
    Write-Host "停止旧 bridge 进程 PID $occupant。" -ForegroundColor Yellow
    Stop-Process -Id $occupant -Force
}

if (Test-Path -LiteralPath $pidFile) {
    $oldPid = 0
    [void][int]::TryParse([System.IO.File]::ReadAllText($pidFile), [ref]$oldPid)
    if ($oldPid -gt 0) {
        $record = Get-ProcessRecord -ProcessId $oldPid
        if (Test-BridgeProcess $record) {
            Stop-Process -Id $oldPid -Force
        }
    }
    [System.IO.File]::Delete($pidFile)
}

$logFile = Join-Path $dir "bridge-runtime.log"
$startLog = Join-Path $dir "bridge-start.log"

function Write-StartLog([string]$Message) {
    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "[$stamp] $Message"
    Add-Content -LiteralPath $startLog -Value $line -Encoding UTF8
    Write-Host $line
}

$nodeArgs = @($entry, "--port", "$Port", "--upstream-kind", $Upstream)
if ($UpstreamUrl) { $nodeArgs += @("--engine-url", $UpstreamUrl) }
if ($UpstreamTokenFile) { $nodeArgs += @("--token-file", $UpstreamTokenFile) }
if ($ChatMode) { $nodeArgs += @("--chat-mode", $ChatMode) }

# WorkBuddy 上游：一并拉起 workbuddy2api 网关（已在跑则跳过）
if ($Upstream -eq "workbuddy") {
    $gateDir = if ($env:WORKBUDDY2API_DIR) { $env:WORKBUDDY2API_DIR } else { Join-Path $env:USERPROFILE ".workbuddy2api" }
    $gateExe = Join-Path $gateDir "wb2api.exe"
    $gateUrl = if ($UpstreamUrl) { $UpstreamUrl } else { "http://127.0.0.1:7863" }
    $gateHealthy = $false
    try {
        $probe = Invoke-WebRequest -Uri "$gateUrl/healthz" -TimeoutSec 2 -UseBasicParsing
        $gateHealthy = $true
        Write-Host "workbuddy2api 已在运行。" -ForegroundColor DarkGray
    } catch { $gateHealthy = $false }

    if (-not $gateHealthy) {
        if (Test-Path -LiteralPath $gateExe) {
            Write-Host "启动 workbuddy2api 网关…" -ForegroundColor Cyan
            $gateLogDir = Join-Path $gateDir "data"
            if (-not (Test-Path $gateLogDir)) { New-Item -ItemType Directory -Path $gateLogDir | Out-Null }
            $gatePidFile = Join-Path $gateDir "wb2api.pid"
            Start-Process -FilePath $gateExe `
                -ArgumentList "-config","config.json" `
                -WorkingDirectory $gateDir `
                -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $gateLogDir "server.out.log") `
                -RedirectStandardError (Join-Path $gateLogDir "server.err.log") `
                -PassThru | ForEach-Object {
                    [System.IO.File]::WriteAllText($gatePidFile, [string]$_.Id)
                }
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ([DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 400
                try {
                    Invoke-WebRequest -Uri "$gateUrl/healthz" -TimeoutSec 2 -UseBasicParsing | Out-Null
                    Write-Host "workbuddy2api 已就绪。" -ForegroundColor Green
                    $gateHealthy = $true
                    break
                } catch { }
            }
            if (-not $gateHealthy) {
                Write-Host "workbuddy2api 已拉起但 healthz 未就绪，bridge 可能连不上。" -ForegroundColor Yellow
            }
        } else {
            Write-Host "找不到 workbuddy2api：$gateExe" -ForegroundColor Yellow
            Write-Host "请部署后重试，或设置 WORKBUDDY2API_DIR。" -ForegroundColor Yellow
        }
    }
}

# Trae 上游：一并拉起 trae2api 网关（已在跑则跳过）；API key 走 TW2A_API_KEY 环境变量
if ($Upstream -eq "trae") {
    $traeDir = if ($env:TRAE2API_DIR) { $env:TRAE2API_DIR } else { Join-Path $env:USERPROFILE ".trae2api" }
    $traeExe = Join-Path $traeDir "trae2api.exe"
    $traeUrl = if ($UpstreamUrl) { $UpstreamUrl } else { "http://127.0.0.1:7864" }
    $traeHealthy = $false
    try {
        $probe = Invoke-WebRequest -Uri "$traeUrl/healthz" -TimeoutSec 2 -UseBasicParsing
        $traeHealthy = $true
        Write-Host "trae2api 已在运行。" -ForegroundColor DarkGray
    } catch { $traeHealthy = $false }

    if (-not $traeHealthy) {
        if (Test-Path -LiteralPath $traeExe) {
            # key 优先取 bridge 目录的 trae-api-key.txt（与 bridge 上游凭据同源）
            $keyFile = Join-Path $dir "trae-api-key.txt"
            if (-not $env:TW2A_API_KEY -and (Test-Path -LiteralPath $keyFile)) {
                $env:TW2A_API_KEY = ([System.IO.File]::ReadAllText($keyFile)).Trim()
            }
            if (-not $env:TW2A_API_KEY) {
                Write-Host "未设置 TW2A_API_KEY（也读不到 trae-api-key.txt），网关将以无鉴权模式启动。" -ForegroundColor Yellow
            }
            Write-Host "启动 trae2api 网关…" -ForegroundColor Cyan
            $traeLogDir = Join-Path $traeDir "data"
            if (-not (Test-Path $traeLogDir)) { New-Item -ItemType Directory -Path $traeLogDir | Out-Null }
            $traePidFile = Join-Path $traeDir "trae2api.pid"
            Start-Process -FilePath $traeExe `
                -ArgumentList "-config","config.json" `
                -WorkingDirectory $traeDir `
                -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $traeLogDir "server.out.log") `
                -RedirectStandardError (Join-Path $traeLogDir "server.err.log") `
                -PassThru | ForEach-Object {
                    [System.IO.File]::WriteAllText($traePidFile, [string]$_.Id)
                }
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ([DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 400
                try {
                    Invoke-WebRequest -Uri "$traeUrl/healthz" -TimeoutSec 2 -UseBasicParsing | Out-Null
                    Write-Host "trae2api 已就绪。" -ForegroundColor Green
                    $traeHealthy = $true
                    break
                } catch { }
            }
            if (-not $traeHealthy) {
                Write-Host "trae2api 已拉起但 healthz 未就绪，bridge 可能连不上。" -ForegroundColor Yellow
            }
        } else {
            Write-Host "找不到 trae2api：$traeExe" -ForegroundColor Yellow
            Write-Host "请先部署（clone + go build ./cmd/server）或设置 TRAE2API_DIR。" -ForegroundColor Yellow
        }
    }
}

if ($Foreground) {
    Write-StartLog "foreground start on port $Port upstream=$Upstream chat=$ChatMode"
    & node @nodeArgs 2>&1 | Tee-Object -FilePath $logFile
    return
}

Write-StartLog "background start on port $Port upstream=$Upstream chat=$ChatMode; runtime log -> $logFile"
$process = Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -PassThru
[System.IO.File]::WriteAllText($pidFile, [string]$process.Id)

$healthUrl = "http://127.0.0.1:$Port/health"
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$health = $null

while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { break }
    try {
        $health = (Invoke-WebRequest -Uri $healthUrl -TimeoutSec 3 -UseBasicParsing).Content
        break
    } catch {
        # 服务仍在启动。
    }
}

if ($health) {
    Write-StartLog "bridge started PID $($process.Id): $health"
} else {
    if ($process.HasExited) {
        [System.IO.File]::Delete($pidFile)
        $detail = "bridge 启动失败，进程已退出（ExitCode $($process.ExitCode)）。"
        $errLog = "$logFile.err"
        if (Test-Path -LiteralPath $errLog) {
            $errText = (Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue)
            if ($errText) { $detail += " stderr: " + $errText.Trim() }
        } elseif (Test-Path -LiteralPath $logFile) {
            $outText = (Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue)
            if ($outText) { $detail += " stdout: " + $outText.Trim() }
        }
        Write-StartLog $detail
        throw $detail
    }
    Write-StartLog "bridge process PID $($process.Id) started but health check not ready yet"
    if ($Upstream -eq "workbuddy") {
        Write-Host "请确认 workbuddy2api 已运行，并且 API key 文件可用。" -ForegroundColor Yellow
    } elseif ($Upstream -eq "trae") {
        Write-Host "请确认 trae2api 已运行，并且 trae-api-key.txt 可用。" -ForegroundColor Yellow
    } else {
        Write-Host "请确认 MiMo Desktop 已运行，并已执行 node mint-token.mjs。" -ForegroundColor Yellow
    }
}

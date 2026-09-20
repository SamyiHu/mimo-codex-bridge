<#
  start-bridge.ps1 — 后台启动 MiMo→Codex 桥接服务。
  只会停止明确由 bridge.mjs 启动的旧进程；不会强杀端口上的无关程序。
#>
[CmdletBinding()]
param(
    [int]$Port = 8788,
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

if ($Foreground) {
    & node $entry --port $Port
    return
}

$process = Start-Process -FilePath "node" `
    -ArgumentList @($entry, "--port", "$Port") `
    -WorkingDirectory $dir `
    -WindowStyle Hidden `
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
    Write-Host "bridge 已启动（PID $($process.Id)）：$health" -ForegroundColor Green
} else {
    if ($process.HasExited) {
        [System.IO.File]::Delete($pidFile)
        throw "bridge 启动失败，进程已退出（ExitCode $($process.ExitCode)）。"
    }
    Write-Host "bridge 进程已启动（PID $($process.Id)），但健康检查暂未通过。" -ForegroundColor Yellow
    Write-Host "请确认 MiMo Desktop 已运行，并已执行 node mint-token.mjs。" -ForegroundColor Yellow
}
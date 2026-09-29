<#
  model-bridge.ps1 — 统一模型桥管理入口。
  用法：
    .\model-bridge.ps1 setup
    .\model-bridge.ps1 status
    .\model-bridge.ps1 start|stop|restart
    .\model-bridge.ps1 configure-codex
    .\model-bridge.ps1 restore-codex
    .\model-bridge.ps1 doctor
    .\model-bridge.ps1 logs
    .\model-bridge.ps1 rotate-secret
    .\model-bridge.ps1 live-test [-ShowCommands]
    .\model-bridge.ps1 tools-demo [-OpenReport]
    .\model-bridge.ps1 protocol-live
    .\model-bridge.ps1 native-probe
    .\model-bridge.ps1 install-startup
    .\model-bridge.ps1 remove-startup
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet(
        "setup",
        "help",
        "status",
        "metrics",
        "start",
        "stop",
        "restart",
        "doctor",
        "logs",
        "rotate-secret",
        "live-test",
        "tools-demo",
        "protocol-live",
        "native-probe",
        "configure-codex",
        "restore-codex",
        "repair-token",
        "install-startup",
        "remove-startup"
    )]
    [string]$Command = "status",

    [int]$Port = 8788,
    [int]$LogLines = 100,
    [ValidateSet("mimo", "workbuddy")]
    [string]$Upstream = "mimo",
    [string]$UpstreamUrl = "",
    [string]$UpstreamTokenFile = "",
    [ValidateSet("compatible", "raw")]
    [AllowEmptyString()]
    [string]$ChatMode = "",
    [switch]$ShowCommands,
    [switch]$OpenReport
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dir = $PSScriptRoot
$startScript = Join-Path $dir "start-bridge.ps1"
$stopScript = Join-Path $dir "stop-bridge.ps1"
$secretFile = Join-Path $dir "bridge-secret.txt"
$tokenFile = Join-Path $dir "token.txt"
$debugFile = Join-Path $dir "debug-requests.jsonl"
$taskName = "Codex Model Bridge"

function Start-Bridge {
    $startParams = @{
        Port = $Port
        Upstream = $Upstream
        UpstreamUrl = $UpstreamUrl
        UpstreamTokenFile = $UpstreamTokenFile
    }
    if ($ChatMode) { $startParams.ChatMode = $ChatMode }
    & $startScript @startParams
}

function Invoke-Doctor([switch]$NoLiveRequest) {
    $doctorArgs = @("--port", "$Port", "--upstream-kind", $Upstream)
    if ($UpstreamTokenFile) { $doctorArgs += @("--upstream-token-file", $UpstreamTokenFile) }
    if ($NoLiveRequest) { $doctorArgs += "--no-live-request" }
    & node (Join-Path $dir "doctor.mjs") @doctorArgs
}

function Test-InteractiveWindow {
    try {
        return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    } catch {
        return $true
    }
}

function Wait-IfInteractive {
    if (Test-InteractiveWindow) {
        Write-Host ""
        Write-Host "按任意键关闭窗口..." -ForegroundColor DarkGray
        try { [void][Console]::ReadKey($true) } catch { Start-Sleep -Seconds 3 }
    }
}

function Show-Usage {
    Write-Host "model-bridge.ps1 用法：" -ForegroundColor Cyan
    Write-Host "  .\model-bridge.ps1 setup     仅初始化凭据并启动 bridge（推荐）"
    Write-Host "  .\model-bridge.ps1 start     启动 bridge"
    Write-Host "  .\model-bridge.ps1 status    查看状态"
    Write-Host "  .\model-bridge.ps1 doctor    自动诊断"
    Write-Host "  .\model-bridge.ps1 stop      停止 bridge"
    Write-Host "  .\model-bridge.ps1 configure-codex  可选：只写 Codex provider"
    Write-Host "  .\model-bridge.ps1 setup -Upstream workbuddy -UpstreamUrl http://127.0.0.1:7863 [-ChatMode raw|compatible]"
    Write-Host "  双击「启动模型桥.bat」等价于 setup。模型继续由 cc-switch / 用户配置。"
}

function Get-BridgeSecret {
    if (Test-Path -LiteralPath $secretFile) {
        return (Get-Content -Raw -LiteralPath $secretFile).Trim()
    }
    if (Test-Path -LiteralPath $tokenFile) {
        Write-Host "警告：bridge-secret.txt 不存在，暂时使用旧 token。" -ForegroundColor Yellow
        return (Get-Content -Raw -LiteralPath $tokenFile).Trim()
    }
    throw "找不到 bridge-secret.txt，请先运行 node mint-token.mjs"
}

function Show-BridgeStatus {
    $secret = Get-BridgeSecret
    $headers = @{ Authorization = "Bearer $secret" }
    $uri = "http://127.0.0.1:$Port/status"
    $status = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10
    $status | ConvertTo-Json -Depth 8
}

# 双击 / 无参数启动时：不要默默跑 status 然后红窗退出。
# 先探测 bridge；没起来就直接 start，起来就显示 status。
$bound = $PSBoundParameters.ContainsKey("Command")
if (-not $bound) {
    $probe = $null
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing
    } catch {
        $probe = $null
    }

    if ($probe) {
        Write-Host "bridge 已在运行，显示 status。" -ForegroundColor Green
        $Command = "status"
    } else {
        Write-Host "bridge 未运行，尝试启动..." -ForegroundColor Yellow
        $Command = "start"
    }
}

try {
    switch ($Command) {
        "setup" {
            Write-Host "初始化本地 bridge 凭据（不会修改 Codex 模型配置）..." -ForegroundColor Cyan
            & node (Join-Path $dir "mint-token.mjs")
            if ($LASTEXITCODE -ne 0) { throw "mint-token 失败，ExitCode=$LASTEXITCODE" }
            if ($Upstream -eq "workbuddy" -and $UpstreamTokenFile -and -not (Test-Path -LiteralPath $UpstreamTokenFile)) {
                throw "找不到 WorkBuddy API key 文件：$UpstreamTokenFile"
            }
            Start-Bridge
            Start-Sleep -Milliseconds 300
            Show-BridgeStatus
            Write-Host ""
            Write-Host "bridge 已就绪（upstream=$Upstream）。Codex 的 model / 模型目录仍由 cc-switch 或用户自行配置。" -ForegroundColor Green
            Write-Host "如需直接写入 provider（不改 model），运行：.\model-bridge.ps1 configure-codex" -ForegroundColor DarkGray
        }

        "configure-codex" {
            & (Join-Path $dir "apply-mimo-provider.ps1") -SecretFile $secretFile
            if ($LASTEXITCODE -ne 0) { throw "apply-mimo-provider 失败，ExitCode=$LASTEXITCODE" }
        }

        "restore-codex" {
            & (Join-Path $dir "apply-mimo-provider.ps1") -Restore
            if ($LASTEXITCODE -ne 0) { throw "恢复 Codex 配置失败，ExitCode=$LASTEXITCODE" }
        }

        "repair-token" {
            & node (Join-Path $dir "mint-token.mjs")
            if ($LASTEXITCODE -ne 0) { throw "mint-token 失败，ExitCode=$LASTEXITCODE" }
            & $stopScript -Port $Port
            Start-Bridge
            Show-BridgeStatus
        }

        "status" {
            Show-BridgeStatus
        }

        "metrics" {
            $secret = Get-BridgeSecret
            $headers = @{ Authorization = "Bearer $secret" }
            $uri = "http://127.0.0.1:$Port/metrics"
            Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10 |
                ConvertTo-Json -Depth 8
        }

        "start" {
            Start-Bridge
            if ($LASTEXITCODE -ne 0) { throw "start-bridge.ps1 失败，ExitCode=$LASTEXITCODE" }
            Start-Sleep -Milliseconds 400
            try {
                Show-BridgeStatus
            } catch {
                Write-Host "bridge 脚本已返回，但 /status 仍不可用。请运行 doctor。" -ForegroundColor Yellow
            }
        }

        "stop" {
            & $stopScript -Port $Port
        }

        "restart" {
            & $stopScript -Port $Port
            Start-Bridge
            Start-Sleep -Milliseconds 300
            Show-BridgeStatus
        }

        "doctor" {
            Invoke-Doctor
            if ($LASTEXITCODE -ne 0) { throw "doctor 失败，ExitCode=$LASTEXITCODE" }
        }

        "logs" {
            if (-not (Test-Path -LiteralPath $debugFile)) {
                Write-Host "尚无调试日志。可设置 BRIDGE_DEBUG=1 后重启 bridge。" -ForegroundColor DarkGray
            } else {
                Get-Content -Encoding UTF8 -LiteralPath $debugFile -Tail $LogLines
            }
        }

        "rotate-secret" {
            Write-Host "轮换 bridge secret（MiMo token 保持不变）..." -ForegroundColor Cyan
            & node (Join-Path $dir "mint-token.mjs") --rotate-bridge-secret
            if ($LASTEXITCODE -ne 0) { throw "mint-token 失败" }

            & $dir\apply-mimo-provider.ps1 -SecretFile $secretFile
            if ($LASTEXITCODE -ne 0) { throw "apply-mimo-provider 失败" }

            & $stopScript -Port $Port
            Start-Bridge
            Invoke-Doctor -NoLiveRequest
            if ($LASTEXITCODE -ne 0) { throw "doctor 失败" }
        }

        "native-probe" {
            & node (Join-Path $dir "live-checks\native-responses-probe.mjs")
            if ($LASTEXITCODE -ne 0) { throw "native-probe 失败" }
        }

        "protocol-live" {
            & node (Join-Path $dir "live-checks\protocol-live.mjs")
            if ($LASTEXITCODE -ne 0) { throw "protocol-live 失败" }
        }

        "tools-demo" {
            $demoArgs = @()
            if ($OpenReport) { $demoArgs += "--open-report" }
            & node (Join-Path $dir "live-checks\codex-tools-demo.mjs") @demoArgs
            if ($LASTEXITCODE -ne 0) { throw "tools-demo 失败" }
        }

        "live-test" {
            $liveArgs = @()
            if ($ShowCommands) { $liveArgs += "--show-commands" }
            & node (Join-Path $dir "live-checks\codex-tool.mjs") @liveArgs
            if ($LASTEXITCODE -ne 0) { throw "live-test 失败" }
        }

        "install-startup" {
            $commandLine =
                'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' +
                $startScript +
                '" -Port ' +
                $Port +
                ' -Upstream ' + $Upstream +
                ' -UpstreamUrl "' + $UpstreamUrl + '"' +
                ' -UpstreamTokenFile "' + $UpstreamTokenFile + '"' + $(if ($ChatMode) { ' -ChatMode ' + $ChatMode } else { '' })
            & schtasks.exe /Create /TN $taskName /TR $commandLine /SC ONLOGON /RL LIMITED /F
            if ($LASTEXITCODE -ne 0) { throw "创建自启动任务失败" }
            Write-Host "已创建登录自启动任务：$taskName" -ForegroundColor Green
        }

        "remove-startup" {
            & schtasks.exe /Delete /TN $taskName /F
            if ($LASTEXITCODE -ne 0) {
                Write-Host "没有可删除的自启动任务。" -ForegroundColor DarkGray
            } else {
                Write-Host "已删除自启动任务：$taskName" -ForegroundColor Green
            }
        }

        default {
            Show-Usage
        }
    }

    if (-not $bound) {
        Wait-IfInteractive
    }
} catch {
    Write-Host ""
    Write-Host "[model-bridge] 失败：$($_.Exception.Message)" -ForegroundColor Red
    $startLog = Join-Path $dir "bridge-start.log"
    $runtimeLog = Join-Path $dir "bridge-runtime.log"
    $errLog = Join-Path $dir "bridge-runtime.log.err"
    foreach ($logPath in @($startLog, $errLog, $runtimeLog)) {
        if (Test-Path -LiteralPath $logPath) {
            Write-Host ""
            Write-Host "--- $(Split-Path $logPath -Leaf) ---" -ForegroundColor DarkGray
            Get-Content -LiteralPath $logPath -Tail 30 -ErrorAction SilentlyContinue
        }
    }
    Wait-IfInteractive
    exit 1
}

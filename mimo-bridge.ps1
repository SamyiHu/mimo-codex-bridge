<#
  mimo-bridge.ps1 — 本地管理入口。
  用法：
    .\mimo-bridge.ps1 status
    .\mimo-bridge.ps1 start|stop|restart
    .\mimo-bridge.ps1 doctor
    .\mimo-bridge.ps1 logs
    .\mimo-bridge.ps1 rotate-secret
    .\mimo-bridge.ps1 live-test [-ShowCommands]
    .\mimo-bridge.ps1 tools-demo [-OpenReport]
    .\mimo-bridge.ps1 protocol-live
    .\mimo-bridge.ps1 native-probe
    .\mimo-bridge.ps1 install-startup
    .\mimo-bridge.ps1 remove-startup
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet(
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
        "install-startup",
        "remove-startup"
    )]
    [string]$Command = "status",

    [int]$Port = 8788,
    [int]$LogLines = 100,
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
$taskName = "MiMo Codex Bridge"

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

switch ($Command) {
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
        & $startScript -Port $Port
    }

    "stop" {
        & $stopScript -Port $Port
    }

    "restart" {
        & $stopScript -Port $Port
        & $startScript -Port $Port
        Start-Sleep -Milliseconds 300
        Show-BridgeStatus
    }

    "doctor" {
        & node (Join-Path $dir "doctor.mjs") --port $Port
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
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
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        & $dir\apply-mimo-provider.ps1 -SecretFile $secretFile
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        & $stopScript -Port $Port
        & $startScript -Port $Port
        & node (Join-Path $dir "doctor.mjs") --port $Port --no-live-request
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    "native-probe" {
        & node (Join-Path $dir "live-checks\native-responses-probe.mjs")
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    "protocol-live" {
        & node (Join-Path $dir "live-checks\protocol-live.mjs")
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    "tools-demo" {
        $demoArgs = @()
        if ($OpenReport) { $demoArgs += "--open-report" }
        & node (Join-Path $dir "live-checks\codex-tools-demo.mjs") @demoArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    "live-test" {
        $liveArgs = @()
        if ($ShowCommands) { $liveArgs += "--show-commands" }
        & node (Join-Path $dir "live-checks\codex-tool.mjs") @liveArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    "install-startup" {
        $commandLine =
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' +
            $startScript +
            '" -Port ' +
            $Port
        & schtasks.exe /Create /TN $taskName /TR $commandLine /SC ONLOGON /RL LIMITED /F
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
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
}
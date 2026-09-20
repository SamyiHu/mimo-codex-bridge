<#
  start-bridge.ps1 — 后台启动 MiMo→Codex 桥接服务（隐藏窗口），并做一次健康检查。
  前置：MiMo Desktop 正在运行且已登录。
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
if (-not (Test-Path -LiteralPath $entry)) { throw "找不到 bridge.mjs：$entry" }

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "端口 $Port 已在监听（pid $($existing.OwningProcess)），先停掉旧的。" -ForegroundColor Yellow
    Stop-Process -Id $existing.OwningProcess -Force
    Start-Sleep -Seconds 2
}

if ($Foreground) {
    & node $entry --port $Port
    return
}

Start-Process -FilePath "node" -ArgumentList @($entry, "--port", "$Port") -WorkingDirectory $dir -WindowStyle Hidden
Start-Sleep -Seconds 8
try {
    $h = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 30 -UseBasicParsing).Content
    Write-Host "bridge 已启动：$h" -ForegroundColor Green
} catch {
    Write-Host "启动后健康检查失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "常见原因：MiMo Desktop 没开 / token 没写进对应目录。" -ForegroundColor Yellow
}

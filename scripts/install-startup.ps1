# scripts/install-startup.ps1 — 单独的开机自启安装器。
# 之所以拆出来：往启动目录写 .bat 是杀软行为启发式（PDM/HIPS）的高危特征，
# 主入口 mimo.ps1 不碰它，只在你想装自启时手动跑一次这个脚本。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -Remove
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath("Startup")
$bat = Join-Path $startup "MiMo-Codex-Bridge.bat"

if ($Remove) {
    if (Test-Path -LiteralPath $bat) {
        Remove-Item -LiteralPath $bat -Force
        Write-Host ("已移除开机自启：" + $bat) -ForegroundColor Green
    } else {
        Write-Host "没有找到开机自启项。" -ForegroundColor DarkGray
    }
    return
}

$template = Join-Path $PSScriptRoot "startup-template.bat"
if (-not (Test-Path -LiteralPath $template)) { throw ("找不到模板 " + $template) }
$body = (Get-Content -Raw -LiteralPath $template).Replace("__ROOT__", $root)
[System.IO.File]::WriteAllText($bat, $body, [System.Text.Encoding]::Default)
Write-Host ("已写入开机自启：" + $bat) -ForegroundColor Green
Write-Host "如被杀软拦下，请把本目录加入信任/排除列表后重试。"

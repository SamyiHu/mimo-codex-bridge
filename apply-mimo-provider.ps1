<#
  apply-mimo-provider.ps1 — 把 MiMo 作为一个 provider 写进 Codex 的 config.toml。
  默认只新增/更新 [model_providers.mimo] 一段，不动别的 provider；
  加 -MakeDefault 时再把顶层 model_provider / model 切到 mimo。
  用法（在你自己的 PowerShell 里，不需要管理员）：
      pwsh -File .\apply-mimo-provider.ps1 -ApiKey <bridge-token> -MakeDefault
      pwsh -File .\apply-mimo-provider.ps1 -ApiKey <token-plan-key> -BaseUrl https://token-plan-cn.xiaomimimo.com/v1
  回滚：把生成的 config.toml.bak-<时间戳> 覆盖回 config.toml。
#>
[CmdletBinding()]
param(
    [string]$ApiKey,
    [string]$BaseUrl = "http://127.0.0.1:8788/v1",
    [string]$ConfigPath = "$env:USERPROFILE\.codex\config.toml",
    [string]$OpencodeAuth = "$env:USERPROFILE\.local\share\opencode\auth.json",
    [string]$Model = "xiaomi/mimo-x-pro-preview",
    [switch]$MakeDefault
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host "找不到 $ConfigPath" -ForegroundColor Red
    exit 2
}

if (-not $ApiKey) {
    if (Test-Path -LiteralPath $OpencodeAuth) {
        $ApiKey = (Get-Content -Raw -LiteralPath $OpencodeAuth | ConvertFrom-Json).mimo.key
        Write-Host "已从 opencode auth.json 读取 key（若验证过是 401，请改用 -ApiKey 传新签发的 key）" -ForegroundColor Yellow
    }
}
if (-not $ApiKey) {
    Write-Host "没有拿到 key，请用 -ApiKey 传入。" -ForegroundColor Red
    exit 2
}

$stamp    = Get-Date -Format "yyyyMMdd-HHmmss"
$backup   = "$ConfigPath.bak-$stamp"
Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
Write-Host "已备份: $backup" -ForegroundColor Cyan

$lines  = [System.IO.File]::ReadAllLines($ConfigPath)
$out    = New-Object System.Collections.Generic.List[string]
$skip   = $false
$removed = 0

foreach ($line in $lines) {
    if ($line -match '^\s*\[\s*model_providers\.mimo\s*\]\s*$') { $skip = $true; $removed++; continue }
    if ($skip) {
        if ($line -match '^\s*\[') { $skip = $false } else { continue }
    }
    $out.Add($line)
}

$block = @(
    "",
    "[model_providers.mimo]",
    "name = `"mimo`"",
    "base_url = `"$BaseUrl`"",
    "wire_api = `"responses`"",
    "requires_openai_auth = false",
    "experimental_bearer_token = `"$ApiKey`"",
    ""
)

$text = ($out -join "`r`n").TrimEnd() + "`r`n" + ($block -join "`r`n")
[System.IO.File]::WriteAllText($ConfigPath, $text, (New-Object System.Text.UTF8Encoding($false)))

$check = [System.IO.File]::ReadAllText($ConfigPath)
if ($check -notmatch '(?m)^\s*\[model_providers\.mimo\]\s*$') {
    Write-Host "自检失败：写入后没有找到 [model_providers.mimo]。请用备份还原。" -ForegroundColor Red
    exit 3
}

if ($MakeDefault) {
    $text = [System.IO.File]::ReadAllText($ConfigPath)
    $text = [regex]::Replace($text, '(?m)^\s*model_provider\s*=\s*"[^"]*"', 'model_provider = "mimo"', 1)
    $text = [regex]::Replace($text, '(?m)^\s*model\s*=\s*"[^"]*"', "model = `"$Model`"", 1)
    [System.IO.File]::WriteAllText($ConfigPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已把默认切到 mimo（model = $Model）" -ForegroundColor Green
}

Write-Host ("写入完成（替换了 " + $removed + " 处旧定义）。") -ForegroundColor Green
Write-Host ""
Write-Host "接下来二选一："
Write-Host "  1) 临时用一次，不改默认："
Write-Host "     codex exec -c model_provider=mimo -c model=xiaomi/mimo-x-pro-preview ""say hi in one word"""
Write-Host "  2) 想设成默认：把 config.toml 顶部改成 model_provider = ""mimo"" 和 model = ""mimo-v2.5-pro"""
Write-Host ""
Write-Host "回滚：Copy-Item '$backup' '$ConfigPath' -Force" -ForegroundColor DarkGray

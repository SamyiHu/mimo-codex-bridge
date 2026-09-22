<#
  apply-mimo-provider.ps1 — 把 MiMo 作为 provider 写入 Codex 的 config.toml。
  默认只新增/更新 [model_providers.mimo]；-MakeDefault 时才切换顶层默认模型。
#>
[CmdletBinding()]
param(
    [string]$ApiKey,
    [string]$BaseUrl = "http://127.0.0.1:8788/v1",
    [string]$ConfigPath = "$env:USERPROFILE\.codex\config.toml",
    [string]$SecretFile = "",
    [string]$Model = "mimo-desktop/mimo-pro",
    [switch]$MakeDefault
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $SecretFile) {
    $SecretFile = Join-Path $PSScriptRoot "bridge-secret.txt"
}

function ConvertTo-TomlString([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Set-TopLevelSetting([string]$Text, [string]$Name, [string]$Value) {
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Name) + '[ \t]*=[ \t]*.*$'
    $setting = "$Name = `"$Value`""
    $match = [regex]::Match($Text, $pattern)

    if ($match.Success) {
        return $Text.Substring(0, $match.Index) +
               $setting +
               $Text.Substring($match.Index + $match.Length)
    }

    $section = [regex]::Match($Text, '(?m)^[ \t]*\[')
    if ($section.Success) {
        $head = $Text.Substring(0, $section.Index).TrimEnd()
        $tail = $Text.Substring($section.Index)
        return "$head`r`n$setting`r`n`r`n$tail"
    }

    return $Text.TrimEnd() + "`r`n" + $setting + "`r`n"
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host "找不到 $ConfigPath" -ForegroundColor Red
    exit 2
}

if (-not $ApiKey -and (Test-Path -LiteralPath $SecretFile)) {
    $ApiKey = Get-Content -Raw -LiteralPath $SecretFile
    Write-Host "已从 bridge-secret.txt 读取 bridge secret。" -ForegroundColor Yellow
}

$ApiKey = ([string]$ApiKey).Trim()
if (-not $ApiKey) {
    Write-Host "没有拿到 bridge secret，请运行 node mint-token.mjs，或用 -ApiKey 显式传入。" -ForegroundColor Red
    exit 2
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "$ConfigPath.bak-$stamp"
Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
Write-Host "已备份：$backup" -ForegroundColor Cyan

$lines = [System.IO.File]::ReadAllLines($ConfigPath)
$out = New-Object System.Collections.Generic.List[string]
$skip = $false
$removed = 0

foreach ($line in $lines) {
    if ($line -match '^\s*\[\s*model_providers\.mimo\s*\]\s*$') {
        $skip = $true
        $removed += 1
        continue
    }
    if ($skip) {
        if ($line -match '^\s*\[') {
            $skip = $false
        } else {
            continue
        }
    }
    $out.Add($line)
}

$baseUrlToml = ConvertTo-TomlString $BaseUrl.Trim()
$apiKeyToml = ConvertTo-TomlString $ApiKey
$modelToml = ConvertTo-TomlString $Model.Trim()

# Codex 默认会在 Responses 请求里带 web_search 工具，MiMo 引擎没有这个能力，
# 不显式关掉的话每一轮请求都会被 bridge 判为不支持的协议而失败。
$block = @(
    "",
    "web_search = `"disabled`"",
    "",
    "[model_providers.mimo]",
    "name = `"mimo`"",
    "base_url = `"$baseUrlToml`"",
    "wire_api = `"responses`"",
    "requires_openai_auth = false",
    "experimental_bearer_token = `"$apiKeyToml`"",
    ""
)

$text = ($out -join "`r`n").TrimEnd() + "`r`n" + ($block -join "`r`n")
if ($MakeDefault) {
    $text = Set-TopLevelSetting -Text $text -Name "model_provider" -Value "mimo"
    $text = Set-TopLevelSetting -Text $text -Name "model" -Value $modelToml
}

[System.IO.File]::WriteAllText(
    $ConfigPath,
    $text,
    (New-Object System.Text.UTF8Encoding($false))
)

$check = [System.IO.File]::ReadAllText($ConfigPath)
if ($check -notmatch '(?m)^\s*\[\s*model_providers\.mimo\s*\]\s*$') {
    Write-Host "自检失败：写入后没有找到 [model_providers.mimo]。请从备份恢复。" -ForegroundColor Red
    exit 3
}

if ($MakeDefault) {
    Write-Host "已把默认切换到 mimo（model = $Model）。" -ForegroundColor Green
} else {
    Write-Host "已更新 mimo provider；默认模型没有改变。" -ForegroundColor Green
    Write-Host "临时调用：codex exec -c model_provider=mimo -c model=$Model `"say hi`"" -ForegroundColor DarkGray
}

Write-Host ("完成：替换了 " + $removed + " 处旧的 mimo provider 定义。") -ForegroundColor Green
Write-Host "回滚：Copy-Item '$backup' '$ConfigPath' -Force" -ForegroundColor DarkGray
<#
  apply-mimo-provider.ps1 - 可选的 Codex 直连配置工具。

  默认只写 [model_providers.mimo] 和 web_search，不修改 model、
  model_catalog_json 或其他模型配置；这些继续由用户 / cc-switch 管理。

  可选命令：
    .\apply-mimo-provider.ps1
    .\apply-mimo-provider.ps1 -MakeDefault -Model mimo-desktop/mimo-v2.6-pro
    .\apply-mimo-provider.ps1 -Restore
#>
[CmdletBinding(DefaultParameterSetName = "Install")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Restore")]
    [switch]$Restore,

    [Parameter(ParameterSetName = "Install")]
    [string]$ApiKey,

    [Parameter(ParameterSetName = "Install")]
    [string]$BaseUrl = "http://127.0.0.1:8788/v1",

    [string]$ConfigPath = $(if ($env:CODEX_HOME) {
        Join-Path $env:CODEX_HOME "config.toml"
    } else {
        Join-Path $env:USERPROFILE ".codex\config.toml"
    }),

    [Parameter(ParameterSetName = "Install")]
    [string]$SecretFile = "",

    [Parameter(ParameterSetName = "Install")]
    [string]$Model = "mimo-desktop/mimo-v2.6-pro",

    [Parameter(ParameterSetName = "Install")]
    [switch]$MakeDefault
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $SecretFile) {
    $SecretFile = Join-Path $PSScriptRoot "bridge-secret.txt"
}
$BackupPath = "$ConfigPath.mimo-bridge-original"

function ConvertTo-TomlString([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Set-TopLevelSetting([string[]]$Lines, [string]$Name, [string]$Value) {
    $setting = "$Name = `"$Value`""
    $result = New-Object System.Collections.Generic.List[string]
    $section = ""
    $inserted = $false

    foreach ($line in $Lines) {
        $header = [regex]::Match($line, '^\s*\[([^\]]*)\]\s*$')
        if ($header.Success) {
            if (-not $inserted -and -not $section) {
                $result.Add($setting)
                $result.Add("")
                $inserted = $true
            }
            $section = $header.Groups[1].Value.Trim()
        }

        $pattern = '^[ \t]*' + [regex]::Escape($Name) + '[ \t]*=[ \t]*.*$'
        if (-not $section -and $line -match $pattern) {
            if (-not $inserted) {
                $result.Add($setting)
                $inserted = $true
            }
            continue
        }
        $result.Add($line)
    }

    if (-not $inserted) {
        if ($result.Count -and $result[$result.Count - 1]) { $result.Add("") }
        $result.Add($setting)
    }
    return $result.ToArray()
}

function Remove-MimoProvider([string[]]$Lines) {
    $result = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in $Lines) {
        $header = [regex]::Match($line, '^\s*\[([^\]]*)\]\s*$')
        if ($header.Success) {
            $section = $header.Groups[1].Value.Trim()
            $skip = $section -eq "model_providers.mimo" -or
                $section.StartsWith("model_providers.mimo.")
        }
        if (-not $skip) { $result.Add($line) }
    }
    return $result.ToArray()
}

if ($Restore) {
    if (-not (Test-Path -LiteralPath $BackupPath)) {
        throw "找不到原始配置备份：$BackupPath"
    }
    Copy-Item -LiteralPath $BackupPath -Destination $ConfigPath -Force
    Write-Host "已恢复原始 Codex 配置：$ConfigPath" -ForegroundColor Green
    exit 0
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "找不到 $ConfigPath；请先运行一次 Codex，或显式传入 -ConfigPath。"
}

if (-not $ApiKey -and (Test-Path -LiteralPath $SecretFile)) {
    $ApiKey = (Get-Content -Raw -LiteralPath $SecretFile).Trim()
}
if (-not $ApiKey) {
    throw "没有 bridge secret；请先运行 node mint-token.mjs，或传入 -ApiKey。"
}

if (-not (Test-Path -LiteralPath $BackupPath)) {
    Copy-Item -LiteralPath $ConfigPath -Destination $BackupPath -Force
    Write-Host "已保存原始配置：$BackupPath" -ForegroundColor Cyan
}

$lines = [System.IO.File]::ReadAllLines($ConfigPath)
$lines = Remove-MimoProvider $lines
$lines = Set-TopLevelSetting $lines "web_search" "disabled"
if ($MakeDefault) {
    $lines = Set-TopLevelSetting $lines "model_provider" "mimo"
    $lines = Set-TopLevelSetting $lines "model" (ConvertTo-TomlString $Model.Trim())
}

$baseUrlToml = ConvertTo-TomlString $BaseUrl.Trim().TrimEnd('/')
$apiKeyToml = ConvertTo-TomlString $ApiKey
$block = @(
    "",
    "[model_providers.mimo]",
    "name = `"mimo`"",
    "base_url = `"$baseUrlToml`"",
    "wire_api = `"responses`"",
    "requires_openai_auth = false",
    "experimental_bearer_token = `"$apiKeyToml`"",
    ""
)
$text = (($lines -join "`r`n").TrimEnd() + "`r`n" + ($block -join "`r`n"))
[System.IO.File]::WriteAllText(
    $ConfigPath,
    $text,
    (New-Object System.Text.UTF8Encoding($false))
)

$check = [System.IO.File]::ReadAllText($ConfigPath)
if ($check -notmatch '(?m)^\s*\[\s*model_providers\.mimo\s*\]\s*$') {
    throw "自检失败：写入后没有找到 [model_providers.mimo]。"
}

if ($MakeDefault) {
    Write-Host "已写入 mimo provider，并把默认模型切换为 $Model。" -ForegroundColor Green
} else {
    Write-Host "已写入 mimo provider；model / 模型目录保持不变。" -ForegroundColor Green
}
Write-Host "恢复：powershell -File '$PSCommandPath' -Restore" -ForegroundColor DarkGray

<#
  stop-bridge.ps1 — 停止本项目的桥接服务。
  只操作 PID 文件记录的 bridge.mjs 进程，或经命令行身份确认的端口占用进程。
#>
[CmdletBinding()]
param([int]$Port = 8788)
$ErrorActionPreference = "Stop"

$dir = $PSScriptRoot
$pidFile = Join-Path $dir "bridge.pid"

function Get-ProcessRecord([int]$ProcessId) {
    return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Test-BridgeProcess($ProcessRecord) {
    if (-not $ProcessRecord) { return $false }
    $commandLine = [string]$ProcessRecord.CommandLine
return ($commandLine -match "(?i)node(?:\.exe)?[`"']?(\s|`$)") -and
           ($commandLine -match '(?i)bridge\.mjs')
}

$stopped = @()

if (Test-Path -LiteralPath $pidFile) {
    $recordedPid = 0
    [void][int]::TryParse([System.IO.File]::ReadAllText($pidFile), [ref]$recordedPid)
    if ($recordedPid -gt 0) {
        $record = Get-ProcessRecord -ProcessId $recordedPid
        if (Test-BridgeProcess $record) {
            Stop-Process -Id $recordedPid -Force
            $stopped += $recordedPid
        }
    }
    [System.IO.File]::Delete($pidFile)
}

$occupants = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($occupantPid in ($occupants | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($stopped -contains $occupantPid) { continue }
    $record = Get-ProcessRecord -ProcessId $occupantPid
    if (-not (Test-BridgeProcess $record)) {
        throw "端口 $Port 当前由非 bridge 进程占用（PID $occupantPid：$($record.Name)），不会停止它。"
    }
    Stop-Process -Id $occupantPid -Force
    $stopped += $occupantPid
}

if ($stopped.Count) {
    Write-Host ("已停止 bridge 进程 PID：" + ($stopped -join ", ")) -ForegroundColor Green
} else {
    Write-Host "没有发现正在运行的 bridge 进程。" -ForegroundColor DarkGray
}
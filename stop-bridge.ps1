<#
  stop-bridge.ps1 — 停掉桥接服务。
#>
[CmdletBinding()]
param([int]$Port = 8788)
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
    Write-Host "已停止 pid $($conn.OwningProcess)（端口 $Port）" -ForegroundColor Green
} else {
    Write-Host "端口 $Port 上没有在跑的服务。" -ForegroundColor DarkGray
}

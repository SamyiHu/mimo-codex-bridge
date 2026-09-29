<#
  mimo-bridge.ps1 — compatibility wrapper.
  Canonical entry point: model-bridge.ps1
#>
$target = Join-Path $PSScriptRoot "model-bridge.ps1"
& $target @args
exit $LASTEXITCODE

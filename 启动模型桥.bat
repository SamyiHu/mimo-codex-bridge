@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 18+ is required.
  pause
  exit /b 1
)

if /I "%~1"=="workbuddy" (
  if /I "%~2"=="raw" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-bridge.ps1" setup -Port 8788 -Upstream workbuddy -UpstreamUrl http://127.0.0.1:7863 -ChatMode raw
  ) else if /I "%~2"=="compatible" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-bridge.ps1" setup -Port 8788 -Upstream workbuddy -UpstreamUrl http://127.0.0.1:7863 -ChatMode compatible
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-bridge.ps1" setup -Port 8788 -Upstream workbuddy -UpstreamUrl http://127.0.0.1:7863
  )
) else if /I "%~1"=="mimo" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-bridge.ps1" setup -Port 8788 -Upstream mimo
) else if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-bridge.ps1" setup -Port 8788
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0model-bridge.ps1" %*
)
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [FAILED] Model bridge could not start. See the message above.
) else (
  echo.
  echo [OK] Model bridge is running. Codex model selection was not changed.
)

pause
exit /b %EXIT_CODE%

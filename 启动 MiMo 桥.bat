@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 18+ is required.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mimo-bridge.ps1" setup -Port 8788
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [FAILED] MiMo bridge could not start. See the message above.
) else (
  echo.
  echo [OK] MiMo bridge is running. Codex model selection was not changed.
)

pause
exit /b %EXIT_CODE%

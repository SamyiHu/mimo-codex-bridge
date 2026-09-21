@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  MiMo Codex Bridge - Start
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node.exe not found. Install Node.js 18+.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bridge.ps1" -Port 8788
set "START_EC=%ERRORLEVEL%"

echo.
echo start-bridge exit code: %START_EC%
echo.

echo --- health ---
curl.exe -sS --max-time 5 http://127.0.0.1:8788/health
echo.
echo.

if exist "%~dp0bridge-start.log" (
  echo --- bridge-start.log ---
  powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0bridge-start.log' -Tail 40"
  echo.
)

if exist "%~dp0bridge-runtime.log" (
  echo --- bridge-runtime.log ---
  powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0bridge-runtime.log' -Tail 40"
  echo.
)

if exist "%~dp0bridge-runtime.log.err" (
  echo --- bridge-runtime.log.err ---
  powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0bridge-runtime.log.err' -Tail 40"
  echo.
)

if "%START_EC%"=="0" (
  echo [OK] If health shows ok:true, Codex can use MiMo now.
) else (
  echo [FAIL] Start script returned an error. See logs above.
)

echo.
echo Press any key to close...
pause >nul
exit /b %START_EC%

@echo off
setlocal
cd /d "%~dp0"
node "%~dp0scripts\mimo.mjs" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [exit %RC%] see the message above.
  pause
)
exit /b %RC%

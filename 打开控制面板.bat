@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 需要 Node.js 18+
  pause
  exit /b 1
)

start "" http://127.0.0.1:8791
node panel.mjs

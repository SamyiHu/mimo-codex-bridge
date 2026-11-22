@echo off
rem Compatibility launcher: forwards to mimo.cmd (the only entry point).
rem ASCII only on purpose - cmd renders non-ASCII from .bat as mojibake.
cd /d "%~dp0"
call "%~dp0mimo.cmd" start %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo [exit %RC%] see the message above.
  if not "%MIMO_NO_PAUSE%"=="1" pause
)
exit /b %RC%

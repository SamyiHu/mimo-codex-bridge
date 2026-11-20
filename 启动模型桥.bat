@echo off
rem Ìû/¨MiMo e + §6b
cd /d "%~dp0"
call "%~dp0mimo.cmd" start %*
if errorlevel 1 pause

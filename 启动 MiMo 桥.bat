@echo off
setlocal
call "%~dp0启动模型桥.bat" %*
exit /b %ERRORLEVEL%

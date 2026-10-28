@echo off
REM Start the always-fresh Zio TV playlist server.
REM Add the printed URLs in TiviMate/Televizo (device must be on same Wi-Fi).
cd /d "%~dp0.."
set "ZIO_PORT=8888"
node src\index.js serve
pause

@echo off
REM Keep the playlist files refreshed on disk every 30 minutes.
cd /d "%~dp0.."
set "ZIO_INTERVAL_MS=1800000"
node src\watch.js
pause

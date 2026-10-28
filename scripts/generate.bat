@echo off
REM Generate all 4 playlist .m3u files into the playlists folder once.
cd /d "%~dp0.."
node src\index.js generate
pause

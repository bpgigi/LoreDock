@echo off
chcp 65001 >nul
setlocal
if exist "%~dp0release\win-unpacked\LoreDock.exe" (
  start "" "%~dp0release\win-unpacked\LoreDock.exe"
  exit /b 0
)
echo 尚未找到桌面程序，请先按 docs\DESKTOP.md 完成打包。
pause
exit /b 1

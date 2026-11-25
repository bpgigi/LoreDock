@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title LoreDock
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\loredock.ps1" -Action Start %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
endlocal

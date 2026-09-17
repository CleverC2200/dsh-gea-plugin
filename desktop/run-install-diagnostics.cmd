@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-install-diagnostics.ps1"
if errorlevel 1 (
  echo Collection could not finish. Please send a screenshot of this window.
  pause
  exit /b 1
)
echo.
echo Please send the GEA-report ZIP generated beside this tool.
pause

@echo off
chcp 65001 >nul 2>&1
title AIEfficiency - Stop Services

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%stop.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo.
  echo [OK] Stop script completed.
) else (
  echo.
  echo [ERROR] Stop script failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%

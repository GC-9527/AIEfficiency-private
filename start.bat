@echo off
chcp 65001 >nul 2>&1
title AIEfficiency - Start And Diagnose

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%start.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Startup failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%

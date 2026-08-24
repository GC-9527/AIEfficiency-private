@echo off
chcp 65001 >nul 2>&1
title AIEfficiency - Install Service Control

set "ROOT=%~dp0"
node "%ROOT%scripts\install-service-control.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] AIEfficiency Service Control launcher installed on this user's Desktop.
  echo [INFO] If this project folder is moved, run this installer again.
) else (
  echo [ERROR] Failed to install service control launcher. Exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

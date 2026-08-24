@echo off
chcp 65001 >nul 2>&1
title AIEfficiency - Package Service Control

set "ROOT=%~dp0"
cd /d "%ROOT%service-control-electron"

if not exist node_modules (
  npm install --no-audit --no-fund
  if errorlevel 1 exit /b 1
)

set "CSC_IDENTITY_AUTO_DISCOVERY=false"
npm run dist:win
set "EXIT_CODE=%ERRORLEVEL%"
set "CSC_IDENTITY_AUTO_DISCOVERY="

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Installer output: %ROOT%service-control-electron\dist
) else (
  echo [ERROR] Packaging failed with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

@echo off
setlocal
chcp 65001 >nul 2>&1
title AIEfficiency - Release Builder

set "ROOT=%~dp0"
set "BUILD_SCRIPT=%ROOT%scripts\build.ps1"

if not exist "%BUILD_SCRIPT%" (
  echo.
  echo [ERROR] Build script not found:
  echo         %BUILD_SCRIPT%
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BUILD_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Build command finished successfully.
) else (
  echo [ERROR] Build command failed with exit code %EXIT_CODE%.
)

rem No arguments normally means the file was opened interactively. Keep the
rem window visible so the user can read the summary or failure instructions.
if "%~1"=="" pause
exit /b %EXIT_CODE%

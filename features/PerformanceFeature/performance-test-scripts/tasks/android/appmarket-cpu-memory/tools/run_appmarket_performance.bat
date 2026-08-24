@echo off
setlocal
cd /d "%~dp0.."
set "HAS_ARGS=0"
if not "%~1"=="" set "HAS_ARGS=1"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0..\runner.py" %*
) else (
  where python >nul 2>nul
  if not %errorlevel%==0 (
    echo Python 3 was not found. Install Python 3 or add it to PATH.
    pause
    exit /b 2
  )
  python "%~dp0..\runner.py" %*
)

set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo AppMarket performance run finished.
) else if "%RC%"=="130" (
  echo AppMarket performance run was cancelled.
) else (
  echo AppMarket performance run failed with exit code %RC%.
)
if "%HAS_ARGS%"=="0" pause
exit /b %RC%

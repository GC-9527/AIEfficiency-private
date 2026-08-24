@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PKG=com.appmarket.automotive"
set "CMP=com.appmarket.automotive/.activities.SplashActivity"
set "ADB=adb"
set "SERIAL="
set "MODE=kill"
set "NO_PAUSE="

if /I "%~1"=="nopause" set "NO_PAUSE=1"
if /I "%~2"=="nopause" set "NO_PAUSE=1"
if /I "%~3"=="nopause" set "NO_PAUSE=1"

if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="start" (
  set "MODE=start"
) else if not "%~1"=="" (
  if /I not "%~1"=="nopause" set "SERIAL=%~1"
)

if /I "%~2"=="start" set "MODE=start"

if not "%SERIAL%"=="" set "ADB=adb -s %SERIAL%"

where adb >nul 2>nul
if errorlevel 1 (
  echo [ERROR] adb not found in PATH.
  goto :end_fail
)

echo [INFO] Package : %PKG%
echo [INFO] Activity: %CMP%
if not "%SERIAL%"=="" echo [INFO] Serial  : %SERIAL%
echo.

%ADB% get-state >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No adb device is available, or multiple devices need a serial.
  echo         Usage: %~nx0 [serial] [start] [nopause]
  goto :end_fail
)

echo [INFO] Device:
%ADB% shell "getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release"
echo.

echo [INFO] Checking su 0 ...
%ADB% shell su 0 id >nul 2>nul
if errorlevel 1 (
  echo [WARN] su 0 is not available. Hard kill may fail; force-stop will still run.
) else (
  echo [INFO] su 0 OK.
)
echo.

call :show_pid "Before"

echo [INFO] Hard stopping app-market ...
%ADB% shell "am force-stop %PKG%; if pidof %PKG% >/dev/null 2>&1; then P=$(pidof %PKG%); echo kill-pass1 pid=$P; su 0 kill -9 $P; fi; sleep 1; if pidof %PKG% >/dev/null 2>&1; then P=$(pidof %PKG%); echo kill-pass2 pid=$P; su 0 kill -9 $P; fi; am force-stop %PKG%"
echo.

call :show_pid "After"

if defined APP_PID_AFTER (
  echo [WARN] %PKG% is still alive or restarted by system: !APP_PID_AFTER!
  echo [WARN] This usually means the persistent/system process was immediately relaunched.
  echo [WARN] Try running with "start" mode to trigger cold-start immediately after kill.
) else (
  echo [OK] %PKG% has no running pid now.
)

if /I "%MODE%"=="start" (
  echo.
  echo [INFO] Starting cold launch immediately ...
  %ADB% shell "am start -W -c android.intent.category.LAUNCHER -a android.intent.action.MAIN -n %CMP%"
  echo.
  call :show_pid "Started"
)

goto :end_ok

:show_pid
set "LABEL=%~1"
set "PID_LINE="
for /f "usebackq delims=" %%P in (`%ADB% shell pidof %PKG% 2^>nul`) do set "PID_LINE=%%P"
if /I "%LABEL%"=="After" set "APP_PID_AFTER=%PID_LINE%"
if "%PID_LINE%"=="" (
  echo [INFO] %LABEL% pid: none
) else (
  echo [INFO] %LABEL% pid: %PID_LINE%
)
exit /b 0

:usage
echo Usage:
echo   %~nx0
echo   %~nx0 start
echo   %~nx0 SERIAL
echo   %~nx0 SERIAL start
echo.
echo Examples:
echo   %~nx0 172.16.130.149:5566
echo   %~nx0 172.16.130.149:5566 start
echo.
echo Default mode only kills %PKG%.
echo "start" mode kills it and immediately launches %CMP%.
goto :end_ok

:end_fail
echo.
if not "%NO_PAUSE%"=="1" pause
exit /b 1

:end_ok
echo.
if not "%NO_PAUSE%"=="1" pause
exit /b 0

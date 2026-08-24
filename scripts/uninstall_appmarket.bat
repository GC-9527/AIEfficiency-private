@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem =====================================================================
rem One-click Android app uninstall/delete script for Windows.
rem
rem Default target:
rem   com.appmarket.automotive
rem
rem To reuse this script for another app:
rem   1) Change PACKAGE below, or
rem   2) Run: uninstall_appmarket.bat your.package.name
rem
rem Notes about encoding:
rem   This batch file intentionally uses ASCII-only console text to avoid
rem   Windows CMD garbled characters on different code pages.
rem =====================================================================

set "PACKAGE=com.appmarket.automotive"
if not "%~1"=="" set "PACKAGE=%~1"

set "SCRIPT_NAME=%~nx0"
set "TMP_DIR=%TEMP%\app_uninstall_%RANDOM%_%RANDOM%"
set "SERIAL="
set "USER_IDS="
set "CURRENT_USER="
set "APK_PATHS="
set "ROOT_MODE=none"
set "ADB="

title Uninstall Android App - %PACKAGE%

echo.
echo ============================================================
echo  Android App Uninstall/Delete Tool
echo ============================================================
echo  Package : %PACKAGE%
echo  Script  : %SCRIPT_NAME%
echo.
echo  This tool will:
echo    1. Check adb and connected device
echo    2. Detect Android users
echo    3. Read package apk path by adb shell pm path
echo    4. Try normal adb uninstall / pm uninstall
echo    5. If still installed and root is available, remove apk files
echo.

for /f "delims=" %%A in ('where adb.exe 2^>nul') do (
  if not defined ADB set "ADB=%%A"
)
if not defined ADB (
  echo [ERROR] adb was not found in PATH.
  echo         Please install Android platform-tools and add adb.exe to PATH.
  goto :Fail
)
echo [OK] adb: %ADB%

if not exist "%TMP_DIR%" mkdir "%TMP_DIR%" >nul 2>nul

echo [Step] Starting adb server...
"%ADB%" start-server >nul 2>nul

call :PickDevice
if not defined SERIAL goto :Fail

echo.
echo [OK] Selected device: %SERIAL%

call :DetectUsers
call :DetectRoot

echo.
echo [Step] Reading package path...
call :LoadPackagePaths
if not defined APK_PATHS (
  echo [INFO] Package is not installed or package path is not visible:
  echo        %PACKAGE%
  echo.
  echo adb devices:
  "%ADB%" devices
  goto :Success
)

echo [OK] Found package apk path(s):
for %%P in (%APK_PATHS%) do echo      %%P

echo.
echo [Summary]
echo   Device serial : %SERIAL%
echo   Package       : %PACKAGE%
echo   Android users : %USER_IDS%
echo   Current user  : %CURRENT_USER%
echo   Root mode     : %ROOT_MODE%
echo.
choice /C YN /N /M "Continue uninstall/delete this package? [Y/N] "
if errorlevel 2 (
  echo.
  echo [CANCELLED] No changes were made.
  goto :Finish
)

echo.
echo [Step] Trying adb uninstall commands...
call :TryAdbUninstall

echo.
echo [Step] Checking package after adb uninstall...
call :LoadPackagePaths
if not defined APK_PATHS (
  echo [SUCCESS] Package is no longer visible to package manager.
  goto :MaybeReboot
)

echo [WARN] Package is still visible after adb uninstall.
echo        This is common for system/priv-app packages.
echo.

if /I "%ROOT_MODE%"=="none" (
  echo [ERROR] Device is not root and su is not available.
  echo         Cannot remove system apk files with rm.
  echo.
  echo Remaining package path(s):
  for %%P in (%APK_PATHS%) do echo      %%P
  goto :Fail
)

echo [Step] Trying root rm fallback...
call :TryRootRemove

echo.
echo [Step] Running pm uninstall again after rm...
call :TryAdbUninstall

echo.
echo [Step] Final package check...
call :LoadPackagePaths
if not defined APK_PATHS (
  echo [SUCCESS] Package is removed from package manager.
  goto :MaybeReboot
)

echo [WARN] Package is still reported by package manager:
for %%P in (%APK_PATHS%) do echo      %%P
echo.
echo The apk files may already be deleted, but Android package manager may
echo keep stale state until reboot on some car devices.
goto :MaybeReboot

:Success
echo.
echo [DONE]
goto :Finish

:Fail
echo.
echo [FAILED] Please review the messages above.
goto :Finish

:MaybeReboot
echo.
choice /C YN /N /M "Reboot device now to finish cleanup? [Y/N] "
if errorlevel 2 goto :Success
echo.
echo [Step] Rebooting device...
"%ADB%" -s "%SERIAL%" reboot
goto :Success

:Finish
echo.
if exist "%TMP_DIR%" rd /s /q "%TMP_DIR%" >nul 2>nul
echo Press any key to close this window...
pause >nul
exit /b

rem ---------------------------------------------------------------------
rem Select one online adb device.
rem ---------------------------------------------------------------------
:PickDevice
set "DEVICE_COUNT=0"
echo [Step] Checking adb devices...
for /f "skip=1 tokens=1,2" %%A in ('"%ADB%" devices') do (
  if "%%B"=="device" (
    set /a DEVICE_COUNT+=1
    set "DEV_!DEVICE_COUNT!=%%A"
  )
)

if "%DEVICE_COUNT%"=="0" (
  echo [ERROR] No online adb device found.
  echo.
  echo Current adb devices:
  "%ADB%" devices
  echo.
  echo Tips:
  echo   - Connect USB/network adb
  echo   - Accept USB debugging authorization on the car device
  echo   - Make sure device state is "device", not "offline" or "unauthorized"
  exit /b 1
)

if "%DEVICE_COUNT%"=="1" (
  set "SERIAL=!DEV_1!"
  exit /b 0
)

echo [INFO] Multiple online devices found:
for /l %%I in (1,1,%DEVICE_COUNT%) do echo   [%%I] !DEV_%%I!
echo.
set /p "PICK=Select device number: "
if not defined PICK (
  echo [ERROR] No device selected.
  exit /b 1
)

set "SERIAL="
for /f "tokens=2 delims==" %%S in ('set DEV_%PICK% 2^>nul') do set "SERIAL=%%S"
if not defined SERIAL (
  echo [ERROR] Invalid selection: %PICK%
  exit /b 1
)
exit /b 0

rem ---------------------------------------------------------------------
rem Detect Android users and keep user ids in USER_IDS.
rem ---------------------------------------------------------------------
:DetectUsers
set "USER_IDS="
set "CURRENT_USER="
echo.
echo [Step] Detecting Android users...
"%ADB%" -s "%SERIAL%" shell pm list users > "%TMP_DIR%\users.txt" 2>nul
type "%TMP_DIR%\users.txt"

for /f "delims=" %%C in ('"%ADB%" -s "%SERIAL%" shell am get-current-user 2^>nul') do set "CURRENT_USER=%%C"

for /f "tokens=2 delims={:" %%U in ('type "%TMP_DIR%\users.txt" ^| findstr /R "UserInfo"') do (
  set "USER_IDS=!USER_IDS! %%U"
)
if not defined USER_IDS set "USER_IDS=0"
if not defined CURRENT_USER set "CURRENT_USER=unknown"
echo [OK] User ids:%USER_IDS%
echo [OK] Current user: %CURRENT_USER%
exit /b 0

rem ---------------------------------------------------------------------
rem Detect root. ROOT_MODE = adb | su | none
rem ---------------------------------------------------------------------
:DetectRoot
set "ROOT_MODE=none"
set "ID_LINE="
echo.
echo [Step] Checking root...
for /f "delims=" %%L in ('"%ADB%" -s "%SERIAL%" shell id 2^>nul') do set "ID_LINE=%%L"
echo     shell id: !ID_LINE!
echo !ID_LINE! | findstr /I "uid=0" >nul 2>nul
if not errorlevel 1 (
  set "ROOT_MODE=adb"
  echo [OK] adb shell is already root.
  exit /b 0
)

echo [Step] Trying adb root...
"%ADB%" -s "%SERIAL%" root > "%TMP_DIR%\adb_root.txt" 2>&1
type "%TMP_DIR%\adb_root.txt"
timeout /t 3 /nobreak >nul
"%ADB%" -s "%SERIAL%" wait-for-device >nul 2>nul

set "ID_LINE="
for /f "delims=" %%L in ('"%ADB%" -s "%SERIAL%" shell id 2^>nul') do set "ID_LINE=%%L"
echo     shell id after adb root: !ID_LINE!
echo !ID_LINE! | findstr /I "uid=0" >nul 2>nul
if not errorlevel 1 (
  set "ROOT_MODE=adb"
  echo [OK] adb root is available.
  exit /b 0
)

echo [Step] Trying su -c id...
set "SU_ID="
for /f "delims=" %%L in ('"%ADB%" -s "%SERIAL%" shell su -c id 2^>nul') do set "SU_ID=%%L"
echo     su id: !SU_ID!
echo !SU_ID! | findstr /I "uid=0" >nul 2>nul
if not errorlevel 1 (
  set "ROOT_MODE=su"
  echo [OK] su root is available.
  exit /b 0
)

echo [WARN] Root is not available. System apk rm fallback will be skipped.
exit /b 0

rem ---------------------------------------------------------------------
rem Load package apk paths into APK_PATHS.
rem Use pm path first. Also try cmd package path and path command fallback.
rem ---------------------------------------------------------------------
:LoadPackagePaths
set "APK_PATHS="
set "PATH_FILE=%TMP_DIR%\pkg_paths.txt"

"%ADB%" -s "%SERIAL%" shell pm path "%PACKAGE%" > "%PATH_FILE%" 2>&1
findstr /B /C:"package:" "%PATH_FILE%" >nul 2>nul
if errorlevel 1 (
  "%ADB%" -s "%SERIAL%" shell cmd package path "%PACKAGE%" > "%PATH_FILE%" 2>&1
)
findstr /B /C:"package:" "%PATH_FILE%" >nul 2>nul
if errorlevel 1 (
  rem Some customized devices may provide "path <package>".
  "%ADB%" -s "%SERIAL%" shell path "%PACKAGE%" > "%PATH_FILE%" 2>&1
)

for /f "usebackq delims=" %%L in ("%PATH_FILE%") do (
  set "LINE=%%L"
  if /I "!LINE:~0,8!"=="package:" (
    set "ONE=!LINE:~8!"
    set "APK_PATHS=!APK_PATHS! !ONE!"
  )
)
exit /b 0

rem ---------------------------------------------------------------------
rem Try non-root uninstall paths.
rem ---------------------------------------------------------------------
:TryAdbUninstall
echo     adb uninstall %PACKAGE%
"%ADB%" -s "%SERIAL%" uninstall "%PACKAGE%"

for %%U in (%USER_IDS%) do (
  echo.
  echo     pm clear --user %%U %PACKAGE%
  "%ADB%" -s "%SERIAL%" shell pm clear --user %%U "%PACKAGE%"
  echo     pm uninstall --user %%U %PACKAGE%
  "%ADB%" -s "%SERIAL%" shell pm uninstall --user %%U "%PACKAGE%"
  echo     cmd package uninstall --user %%U %PACKAGE%
  "%ADB%" -s "%SERIAL%" shell cmd package uninstall --user %%U "%PACKAGE%"
)
exit /b 0

rem ---------------------------------------------------------------------
rem Root rm fallback. Remove apk parent directory and package data.
rem ---------------------------------------------------------------------
:TryRootRemove
echo     adb remount
"%ADB%" -s "%SERIAL%" remount

set "RM_SCRIPT=mount -o rw,remount / 2>/dev/null; mount -o rw,remount /system 2>/dev/null;"
for %%P in (%APK_PATHS%) do (
  set "RM_SCRIPT=!RM_SCRIPT! p='%%P'; d=${p%%/*}; echo Removing $d; rm -rf $d;"
)
set "RM_SCRIPT=!RM_SCRIPT! rm -rf /data/data/%PACKAGE% /data/user/*/%PACKAGE% /data/user_de/*/%PACKAGE% /data/app/*%PACKAGE%*; sync"

echo     root command:
echo     !RM_SCRIPT!
echo.

if /I "%ROOT_MODE%"=="adb" (
  "%ADB%" -s "%SERIAL%" shell "!RM_SCRIPT!"
) else (
  "%ADB%" -s "%SERIAL%" shell su -c "!RM_SCRIPT!"
)
exit /b 0

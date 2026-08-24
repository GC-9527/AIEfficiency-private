@echo off
chcp 65001 >nul 2>&1
:: 把 ..\gateway 同步到 gateway-bundled\，跳过 node_modules / 数据库 / 个人配置
:: 用法：双击或 cd desktop && sync-gateway.bat

setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "SRC=%SCRIPT_DIR%..\gateway"
set "DEST=%SCRIPT_DIR%gateway-bundled"

if not exist "%SRC%" (
    echo [ERROR] 源不存在: %SRC%
    exit /b 1
)
if not exist "%DEST%" (
    echo [ERROR] 目标不存在: %DEST%
    exit /b 1
)

echo 同步 gateway -^> gateway-bundled ...

:: robocopy 是 Windows 内置工具
:: /MIR 镜像，/XD 排除目录，/XF 排除文件
robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NJH /NJS /NP ^
    /XD node_modules .tmp knowledge scripts ^
    /XF data.db data.db-shm data.db-wal config.json
set EXITCODE=%ERRORLEVEL%

:: robocopy 退出码 0~7 都是成功；>=8 才是错误
if %EXITCODE% LSS 8 (
    echo 同步完成。
    echo.
    echo 下一步：
    echo   1. cd %SCRIPT_DIR%
    echo   2. npx electron-builder --win   ^&^&  REM 重新打包
    exit /b 0
) else (
    echo [ERROR] robocopy 失败，退出码 %EXITCODE%
    exit /b %EXITCODE%
)

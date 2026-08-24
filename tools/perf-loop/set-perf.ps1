<#
.SYNOPSIS
  开/关 avatr 应用市场性能采集（debug.appmarket.perf 最高优先级覆盖，没装 app-mock 也能开）。

.DESCRIPTION
  setprop debug.appmarket.perf 1|0 → force-stop 应用 →（可选）冷启动。
  量产包 PerfTracker.DEFAULT_ENABLED=false 默认不采集；本属性**凌驾默认与 mock 下发**，
  Dev / Prod release 均支持、即时生效、可反复改（改后必须 force-stop 让下次冷启动重读）。
  台架走 run-perf-loop scrape（读 logcat）只需开采集，不必设上报地址；
  如要应用自身 HTTP 上报：-Endpoint <url> → 写 debug.appmarket.perf.endpoint。

.PARAMETER On       开采集（不传开关时的默认）
.PARAMETER Off      关采集
.PARAMETER Endpoint 上报地址（可选）；传空不改
.PARAMETER Serial   adb 序列号（多设备时指定，单设备可省）
.PARAMETER Launch   设置后立即冷启动应用

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File set-perf.ps1 -On -Launch
  powershell -ExecutionPolicy Bypass -File set-perf.ps1 -Off -Launch
  powershell -ExecutionPolicy Bypass -File set-perf.ps1 -On -Endpoint http://192.168.10.110:3001/api/performance/ingest -Launch
#>
[CmdletBinding()]
param(
    [switch]$On,
    [switch]$Off,
    [string]$Endpoint = "",
    [string]$Serial = "",
    [switch]$Launch
)

$ErrorActionPreference = "Continue"
$pkg = "com.appmarket.automotive"
$adb = (Get-Command adb -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$sArg = @(); if (-not [string]::IsNullOrWhiteSpace($Serial)) { $sArg = @("-s", $Serial) }

& $adb @sArg root 2>$null | Out-Null
Start-Sleep -Milliseconds 800

# 默认开；-Off 优先关
$enable = if ($Off) { "0" } else { "1" }
& $adb @sArg shell "setprop debug.appmarket.perf $enable" 2>$null
if (-not [string]::IsNullOrWhiteSpace($Endpoint)) {
    & $adb @sArg shell "setprop debug.appmarket.perf.endpoint '$Endpoint'" 2>$null
}

$now = (& $adb @sArg shell "getprop debug.appmarket.perf" | Out-String).Trim()
$ep = (& $adb @sArg shell "getprop debug.appmarket.perf.endpoint" | Out-String).Trim()
$state = if ($now -eq "1") { "开" } elseif ($now -eq "0") { "关" } else { "未知" }
Write-Host "debug.appmarket.perf = '$now'（$state）" -ForegroundColor Green
if ($ep) { Write-Host "debug.appmarket.perf.endpoint = '$ep'" -ForegroundColor Green }

& $adb @sArg shell am force-stop $pkg 2>$null | Out-Null
Write-Host "已 force-stop $pkg（下次冷启动生效）" -ForegroundColor DarkGray

if ($Launch) {
    & $adb @sArg shell "monkey -p $pkg -c android.intent.category.LAUNCHER 1" 2>$null | Out-Null
    Write-Host "已冷启动应用" -ForegroundColor Cyan
}

Write-Host "验证：adb logcat -s APP_MKT_PERF:* 冷启动后看 'PerfTracker.init ... enabled=true' 及 metric[...] 行" -ForegroundColor DarkGray

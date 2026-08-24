<#
.SYNOPSIS
  给 avatr8678 应用市场设置"国家码"——写运行时覆盖属性 debug.appmarket.region（真机，不经 mock app）。

.DESCRIPTION
  - 配合 Avatr8678PlatformBridge：region() 最高优先读 debug.appmarket.region；非空即用。
  - debug.* root 可**反复 setprop、即时生效**（不像 ro.* 一个 boot 只能设一次）；改国家码无需重启/重打包。
  - debug.* 重启会丢 → 重启后回落到 App 内置 MODEL_REGION_DEFAULT(E15-EU-Left→SA)；想恢复覆盖重跑本脚本即可。
  - 改国家码：`-CountryCode US` / `SA` / `CN` …

.PARAMETER Serial       adb 序列号（多设备必填，如 192.168.20.116:5566）
.PARAMETER CountryCode  国家码，默认 SA；改这里即改
.PARAMETER Prop         覆盖属性 key，默认 debug.appmarket.region（与 bridge 约定一致）
.PARAMETER Clear        清除覆盖（setprop 为空），让 App 回落到内置默认/真机 sysprop
.PARAMETER RestartApp   设完后 force-stop 并拉起应用市场，使其重新读取

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -Serial 192.168.20.116:5566 -CountryCode SA -RestartApp
  powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -Serial 192.168.20.116:5566 -CountryCode US -RestartApp
  powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -Serial 192.168.20.116:5566 -Clear -RestartApp
#>
[CmdletBinding()]
param(
    [string]$Serial = "",
    [string]$CountryCode = "SA",
    [string]$Prop = "debug.appmarket.region",
    [switch]$Clear,
    [string]$Package = "com.appmarket.automotive",
    [switch]$RestartApp
)
$ErrorActionPreference = "Stop"
$ADB = (Get-Command adb -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
function Adb([string[]]$a) {
    $full = @(); if ($Serial) { $full += @("-s", $Serial) }; $full += $a
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { return (& $ADB @full | Out-String).Trim() } finally { $ErrorActionPreference = $prev }
}

$val = if ($Clear) { '""' } else { $CountryCode }
Write-Host "=== set-car-region: $Prop = $val ===" -ForegroundColor Cyan
Adb @("root") | Out-Null
Start-Sleep -Milliseconds 800
if ($Clear) { Adb @("shell", "setprop", $Prop, "") | Out-Null } else { Adb @("shell", "setprop", $Prop, $CountryCode) | Out-Null }
$now = Adb @("shell", "getprop", $Prop)
$expect = if ($Clear) { "" } else { $CountryCode }
if ($now -eq $expect) {
    Write-Host "✅ $Prop = '$now'" -ForegroundColor Green
} else {
    Write-Host "❌ 写入未生效：$Prop = '$now'（期望 '$expect'）。检查是否 root / SELinux 是否放行 debug.* 。" -ForegroundColor Red
}

if ($RestartApp) {
    Write-Host "重启应用市场以重新读取国家码…" -ForegroundColor Yellow
    Adb @("shell", "am", "force-stop", $Package) | Out-Null
    Adb @("shell", "monkey", "-p", $Package, "-c", "android.intent.category.LAUNCHER", "1") | Out-Null
    Write-Host "已拉起。" -ForegroundColor Green
}
Write-Host "提示：debug.* 重启后丢失；App 内置默认 MODEL_REGION_DEFAULT(E15-EU-Left→SA) 兜底，需改默认见 Avatr8678PlatformBridge。" -ForegroundColor DarkGray

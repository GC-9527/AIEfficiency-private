<#
.SYNOPSIS
  长时（如连续 2 天）Monkey 压测期间，持续把车机 logcat + Monkey 报告**无损归档**到
  AIEfficiency 工程的 perf-logs/ 目录，按"设备名_序列号_IP"区分，轮转压缩，便于溯源与优化。

.DESCRIPTION
  采集策略（应对大数据量 + 不丢日志）：
  - **持续流式**抓 `adb logcat -b all`（不是定时 dump，避免环形缓冲在 Monkey 高频事件下滚动丢日志）。
  - 每 -RotateMin 分钟**轮转**一次：停流→把刚写满的原始文件压成 zip 进 archive/→重开新流（间隙 <1s）。
  - 启动时把设备 logcat 缓冲调大（-BufferMB），进一步降低轮转间隙丢日志概率。
  - 每次轮转顺带把 perf-loop/reports/ 下**新增的 Monkey 轮次**复制进设备的 monkey/ 目录。
  - 结构化性能数据（①②③/metrics/crash/anr）由 PerfTracker 实时 HTTP 上报入库，**不在本脚本范围**，
    本脚本只管"原始日志 + Monkey 报告"的归档。

  目录结构（perf-logs/ 已 gitignore，不入库）：
    perf-logs/<model>_<serial>_<ip>/
      device.json                 设备与会话元信息
      raw/logcat-<ts>.log         当前正在写的流（轮转后删除）
      archive/logcat-<ts>.log.zip 轮转压缩后的历史日志
      monkey/round_xxx/           各轮 Monkey 报告快照

.PARAMETER Serial       adb 序列号（多设备必填；单设备可省）
.PARAMETER OutRoot      归档根目录，默认 AIEfficiency/perf-logs
.PARAMETER RotateMin    轮转间隔（分钟），默认 30
.PARAMETER DurationHours 自动停止时长（小时），默认 48（两天）；0=直到手动 Ctrl-C
.PARAMETER BufferMB     设备端 logcat 缓冲大小（MB），默认 16
.PARAMETER Once         只抓一次当前缓冲(dump)并压缩后退出（用于快速验证，无需长跑）

.EXAMPLE
  # 连跑两天，每 30 分钟轮转归档
  pwsh ./backup-device-logs.ps1 -Serial 99271FFBA000R8
  # 快速验证一次
  pwsh ./backup-device-logs.ps1 -Serial 99271FFBA000R8 -Once
#>
[CmdletBinding()]
param(
    [string]$Serial = "",
    [string]$OutRoot = "",
    [int]$RotateMin = 30,
    [double]$DurationHours = 48,
    [int]$BufferMB = 16,
    [switch]$Once
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($OutRoot)) {
    # tools/perf-loop -> 上两级是 AIEfficiency 根
    $OutRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) "perf-logs"
}
$ReportsDir = Join-Path $ScriptDir "reports"

$AdbExe = (Get-Command adb -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
function AdbArgs { $a = @(); if ($Serial) { $a += @("-s", $Serial) }; return $a }
function AdbText([string[]]$cmd) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { return (& $AdbExe ((AdbArgs) + $cmd) | Out-String).Trim() } finally { $ErrorActionPreference = $prev }
}
function Sanitize([string]$s) { return ($s -replace '[^A-Za-z0-9._-]', '_').Trim('_') }
function Stamp { return (Get-Date).ToString("yyyyMMdd-HHmmss") }

# --- 设备识别：名字 + 序列号 + IP ---
$model = AdbText @("shell", "getprop", "ro.product.model"); if (-not $model) { $model = "device" }
$serialActual = AdbText @("get-serialno"); if (-not $serialActual) { $serialActual = if ($Serial) { $Serial } else { "unknown" } }
# IP：优先 wlan0；网络 adb 时序列号本身含 ip:port
$ipRaw = AdbText @("shell", "ip", "-f", "inet", "addr", "show", "wlan0")
$ipMatch = [regex]::Match($ipRaw, 'inet (\d+\.\d+\.\d+\.\d+)')
$ip = if ($ipMatch.Success) { $ipMatch.Groups[1].Value } elseif ($serialActual -match '^(\d+\.\d+\.\d+\.\d+):\d+$') { $Matches[1] } else { "noip" }

$deviceKey = (Sanitize $model) + "_" + (Sanitize $serialActual) + "_" + (Sanitize $ip)
$devDir = Join-Path $OutRoot $deviceKey
$rawDir = Join-Path $devDir "raw"
$archiveDir = Join-Path $devDir "archive"
$monkeyDir = Join-Path $devDir "monkey"
foreach ($d in @($devDir, $rawDir, $archiveDir, $monkeyDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# 设备元信息
@{
    model = $model; serial = $serialActual; ip = $ip
    host = $env:COMPUTERNAME; startTime = (Get-Date).ToString("o")
    rotateMin = $RotateMin; durationHours = $DurationHours; bufferMB = $BufferMB
} | ConvertTo-Json | Set-Content -Path (Join-Path $devDir "device.json") -Encoding utf8

Write-Host "=== backup-device-logs ===" -ForegroundColor Cyan
Write-Host "设备: $model | $serialActual | $ip"
Write-Host "归档到: $devDir"

# 调大设备 logcat 缓冲，降低轮转间隙丢日志概率
try { & $AdbExe ((AdbArgs) + @("logcat", "-G", "${BufferMB}M")) | Out-Null; Write-Host "logcat 缓冲已设为 ${BufferMB}M" } catch { Write-Host "设缓冲失败(忽略): $($_.Exception.Message)" -ForegroundColor DarkYellow }

function Compress-One([string]$logFile) {
    if (-not (Test-Path $logFile)) { return }
    if ((Get-Item $logFile).Length -eq 0) { Remove-Item $logFile -Force; return }
    $zip = Join-Path $archiveDir ((Split-Path -Leaf $logFile) + ".zip")
    Compress-Archive -Path $logFile -DestinationPath $zip -Force
    Remove-Item $logFile -Force
    Write-Host ("  归档 " + (Split-Path -Leaf $zip) + " (" + [math]::Round((Get-Item $zip).Length / 1MB, 2) + " MB)") -ForegroundColor Green
}

function Sweep-Monkey {
    if (-not (Test-Path $ReportsDir)) { return }
    Get-ChildItem $ReportsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $dest = Join-Path $monkeyDir $_.Name
        if (-not (Test-Path $dest)) { Copy-Item $_.FullName $dest -Recurse -Force }
    }
}

# --- Once 模式：dump 当前缓冲一次后退出（快速验证） ---
if ($Once) {
    $f = Join-Path $rawDir ("logcat-" + (Stamp) + ".log")
    AdbText @("logcat", "-b", "all", "-d", "-v", "threadtime") | Set-Content -Path $f -Encoding utf8
    Compress-One $f
    Sweep-Monkey
    Write-Host "Once 完成。" -ForegroundColor Cyan
    return
}

# --- 持续流式 + 定时轮转 ---
$endTime = if ($DurationHours -gt 0) { (Get-Date).AddHours($DurationHours) } else { [datetime]::MaxValue }
$proc = $null
try {
    while ((Get-Date) -lt $endTime) {
        $cur = Join-Path $rawDir ("logcat-" + (Stamp) + ".log")
        $argLine = ((AdbArgs) + @("logcat", "-b", "all", "-v", "threadtime")) -join " "
        $proc = Start-Process -FilePath $AdbExe -ArgumentList $argLine -RedirectStandardOutput $cur -NoNewWindow -PassThru
        Write-Host ("[" + (Get-Date).ToString("HH:mm:ss") + "] 开始流式抓取 → " + (Split-Path -Leaf $cur)) -ForegroundColor Yellow

        $sleepSec = [Math]::Min($RotateMin * 60, [Math]::Max(1, ($endTime - (Get-Date)).TotalSeconds))
        Start-Sleep -Seconds $sleepSec

        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        Start-Sleep -Milliseconds 300
        Compress-One $cur
        Sweep-Monkey
    }
    Write-Host "已到 -DurationHours 时长，结束。" -ForegroundColor Cyan
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    # 收尾：把最后一段也归档
    Get-ChildItem $rawDir -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { Compress-One $_.FullName }
    Sweep-Monkey
    Write-Host "收尾归档完成。归档目录: $archiveDir" -ForegroundColor Cyan
}

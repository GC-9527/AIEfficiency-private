<#
.SYNOPSIS
  应用市场性能压测闭环（工程 C，Step 5）：build → install → 冷启动 → Monkey 压测
  → 抓 PerfTracker logcat → 解析①②③/内存/Crash/ANR → 按 round 标记上报 AIEfficiency。

.DESCRIPTION
  与车机端 PerfTracker（TAG=APP_MKT_PERF）配合：脚本不依赖 mock app 的 HTTP 上报配置，
  而是直接 scrape logcat（PerfTracker 已把 cold_start/metric/event 打到 logcat），
  解析后由脚本自己 POST 到 /api/performance/ingest（带 round_NNN），落库供面板「轮次对比」。

  每轮产物存 tools/perf-loop/reports/round_NNN/：monkey.log、logcat.txt、round.json、summary.md

.PARAMETER Channel    渠道 flavor（demo/seres/avatr8678/...），默认 demo
.PARAMETER Env        环境维度（Dev/Prod/Stage），默认 Dev
.PARAMETER BuildType  debug/release，默认 debug
.PARAMETER Events     每轮 Monkey 事件数，默认 5000
.PARAMETER Rounds     连续跑几轮(每轮=冷启动测①②③ + Monkey 压测 + 抓数 + 带 round 上报)，默认 1
.PARAMETER DurationHours 按时长跑(小时)：>0 时忽略 -Rounds，一直循环跑到该时长(如 48=两天)，默认 0
.PARAMETER Gateway    AIEfficiency 网关地址，默认 http://localhost:3001
.PARAMETER Serial     adb 设备序列号（多设备时指定）
.PARAMETER NoBuild    跳过 assemble/install（用已装好的包）
.PARAMETER DryRun     只打印将要执行的命令，不真正执行（无需设备）
.PARAMETER SelfTest   用内嵌样本验证 logcat 解析逻辑后退出（无需设备/网络）

.EXAMPLE
  pwsh ./run-perf-loop.ps1 -Channel demo -Env Dev -Events 10000
  pwsh ./run-perf-loop.ps1 -SelfTest
  pwsh ./run-perf-loop.ps1 -DryRun -Channel seres
#>
[CmdletBinding()]
param(
    [string]$Channel = "demo",
    [ValidateSet("Dev", "Prod", "Stage")][string]$Env = "Dev",
    [ValidateSet("debug", "release")][string]$BuildType = "debug",
    [int]$Events = 5000,
    [int]$Rounds = 1,
    [double]$DurationHours = 0,
    [string]$Gateway = "http://localhost:3001",
    [string]$Package = "com.appmarket.automotive",
    [string]$Serial = "",
    [switch]$NoBuild,
    [switch]$DropCaches,
    [switch]$Reboot,
    [int]$RebootSettleSec = 45,
    [switch]$DryRun,
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
$PerfTag = "APP_MKT_PERF"

# 工程 A（应用市场）仓库路径：默认相对推断，可用环境变量 APPMARKET_DIR 覆盖。
$AppMarketDir = $env:APPMARKET_DIR
if ([string]::IsNullOrWhiteSpace($AppMarketDir)) {
    $AppMarketDir = "D:\workspace\xsProjects\202605\AISdkV4\2026AppMarketAIV5"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReportsDir = Join-Path $ScriptDir "reports"

# ---------------------------------------------------------------------------
# 解析：把 PerfTracker 的 logcat + Monkey 输出解析为一轮结构化结果
# ---------------------------------------------------------------------------
function Parse-PerfData {
    param([string]$Logcat, [string]$MonkeyOut)

    $result = [ordered]@{
        stage1Ms = 0; stage2Ms = 0; stage3Ms = 0; totalMs = 0; coldToLoadingMs = 0
        metrics = @(); events = @(); crashCount = 0; anrCount = 0
    }

    # 优先：纯 ASCII scrape 行（流式抓取编码无损）——cold_start_scrape s1=.. s2=.. s3=.. total=.. loading=..
    $ms = [regex]::Match($Logcat, 'cold_start_scrape s1=(\d+) s2=(\d+) s3=(\d+) total=(\d+) loading=(\d+)')
    if ($ms.Success) {
        $result.stage1Ms = [int]$ms.Groups[1].Value
        $result.stage2Ms = [int]$ms.Groups[2].Value
        $result.stage3Ms = [int]$ms.Groups[3].Value
        $result.totalMs = [int]$ms.Groups[4].Value
        $result.coldToLoadingMs = [int]$ms.Groups[5].Value
    } else {
        # 兜底：旧 ①②③ 行（需 UTF-8 无损）。cold_start done: ①=802 ②=1519 ③=236 total=2557ms 测试口径(→模板loading)=2880ms
        $m = [regex]::Match($Logcat, 'cold_start done: ①=(\d+) ②=(\d+) ③=(\d+) total=(\d+)ms')
        if ($m.Success) {
            $result.stage1Ms = [int]$m.Groups[1].Value
            $result.stage2Ms = [int]$m.Groups[2].Value
            $result.stage3Ms = [int]$m.Groups[3].Value
            $result.totalMs = [int]$m.Groups[4].Value
        }
        $mc = [regex]::Match($Logcat, '测试口径\(→模板loading\)=(\d+)ms')
        if ($mc.Success) { $result.coldToLoadingMs = [int]$mc.Groups[1].Value }
    }

    # metric[network] net:... = 433ms   /  metric[memory] mem:pssMb = 185ms
    $metrics = @()
    foreach ($mm in [regex]::Matches($Logcat, 'metric\[(\w+)\] (.+?) = (\d+)ms')) {
        $metrics += [ordered]@{ type = $mm.Groups[1].Value; name = $mm.Groups[2].Value.Trim(); cost = [int]$mm.Groups[3].Value }
    }
    $result.metrics = $metrics

    # event[crash] ... / event[anr] ...  （PerfTracker.recordEvent 的 logcat）
    $events = @()
    foreach ($em in [regex]::Matches($Logcat, 'event\[(crash|anr)\] (.+)')) {
        $type = $em.Groups[1].Value
        $events += [ordered]@{ type = $type; detail = $em.Groups[2].Value.Trim(); ts = 0 }
        if ($type -eq "crash") { $result.crashCount++ } else { $result.anrCount++ }
    }
    $result.events = $events

    # Monkey 自报的崩溃/ANR（与 logcat 取并集的兜底；Monkey 在 // CRASH / // NOT RESPONDING 处标记）
    $monkeyCrash = ([regex]::Matches($MonkeyOut, '//\s*CRASH')).Count
    $monkeyAnr = ([regex]::Matches($MonkeyOut, 'NOT RESPONDING')).Count
    if ($monkeyCrash -gt $result.crashCount) { $result.crashCount = $monkeyCrash }
    if ($monkeyAnr -gt $result.anrCount) { $result.anrCount = $monkeyAnr }

    return $result
}

function Invoke-SelfTest {
    $sampleLog = @"
01-01 00:00:01.000  1000  1000 I APP_MKT_PERF: PerfTracker.init flavor=demoDev
01-01 00:00:03.500  1000  1000 I APP_MKT_PERF: cold_start done: ①=802 ②=1519 ③=236 total=2557ms 测试口径(→模板loading)=2880ms
01-01 00:00:03.501  1000  1000 I APP_MKT_PERF: cold_start_scrape s1=802 s2=1519 s3=236 total=2557 loading=2880
01-01 00:00:03.600  1000  1050 I APP_MKT_PERF: metric[network] net:/api/home code=200 ok=true = 433ms
01-01 00:00:10.000  1000  1050 I APP_MKT_PERF: metric[memory] mem:pssMb = 185ms
01-01 00:01:05.000  1000  1050 I APP_MKT_PERF: metric[fg] cpu:fgPeak = 78ms
01-01 00:01:05.000  1000  1050 I APP_MKT_PERF: metric[fg] mem:fgPeakPss = 312ms
01-01 00:00:20.000  1000  1050 W APP_MKT_PERF: event[crash] java.lang.NullPointerException at Foo.bar
01-01 00:00:25.000  1000  1050 W APP_MKT_PERF: event[anr] main thread blocked >5000ms
"@
    $sampleMonkey = "Events injected: 5000`n// CRASH: com.appmarket.automotive`n## Network stats:`nMonkey finished"
    $r = Parse-PerfData -Logcat $sampleLog -MonkeyOut $sampleMonkey
    $script:stFail = $false
    function Assert($cond, $msg) { if (-not $cond) { Write-Host "  ✗ $msg" -ForegroundColor Red; $script:stFail = $true } else { Write-Host "  ✓ $msg" -ForegroundColor Green } }
    Write-Host "SelfTest: 解析样本 logcat" -ForegroundColor Cyan
    Assert ($r.stage1Ms -eq 802) "stage1=802 (got $($r.stage1Ms))"
    Assert ($r.stage2Ms -eq 1519) "stage2=1519 (got $($r.stage2Ms))"
    Assert ($r.stage3Ms -eq 236) "stage3=236 (got $($r.stage3Ms))"
    Assert ($r.totalMs -eq 2557) "total=2557 (got $($r.totalMs))"
    Assert ($r.coldToLoadingMs -eq 2880) "coldToLoadingMs=2880 (got $($r.coldToLoadingMs))"
    Assert ($r.metrics.Count -eq 4) "metrics=4 (got $($r.metrics.Count))"
    Assert ($r.events.Count -eq 2) "events=2 (got $($r.events.Count))"
    Assert ($r.crashCount -eq 1) "crash=1 (got $($r.crashCount))"
    Assert ($r.anrCount -eq 1) "anr=1 (got $($r.anrCount))"
    if ($script:stFail) { Write-Host "SelfTest FAILED" -ForegroundColor Red; exit 1 }
    Write-Host "SelfTest PASSED" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# adb / gradlew 封装（DryRun 时仅打印）
# ---------------------------------------------------------------------------
# 显式数组传参（不用 ValueFromRemainingArguments——它会吞掉 -p/-v 这类 - 前缀 token）。
function Adb {
    param([string[]]$ArgList)
    $full = @()
    if (-not [string]::IsNullOrWhiteSpace($Serial)) { $full += @("-s", $Serial) }
    $full += $ArgList
    if ($DryRun) { Write-Host "  [dry] adb $($full -join ' ')" -ForegroundColor DarkGray; return "" }
    # 必须显式解析外部 adb 可执行文件：函数名 Adb 与命令 adb 大小写不敏感会冲突，
    # 直接 `& adb` 会递归调用本函数（call depth overflow），故缓存 Application 路径调用。
    if (-not $script:AdbExe) {
        $script:AdbExe = (Get-Command adb -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    # 不重定向 stderr：PS5.1 下 `2>&1` 会把原生命令 stderr 每行包成 ErrorRecord，
    # 配合 ErrorActionPreference=Stop 会误判为终止错误（monkey 把 args 写到 stderr）。
    # 只取 stdout（logcat/monkey 的有用输出都在 stdout）；局部放宽 EAP 兜底。
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = (& $script:AdbExe @full | Out-String)
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    return $out
}

function Next-Round {
    if (-not (Test-Path $ReportsDir)) { return "round_001" }
    $max = 0
    Get-ChildItem $ReportsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $mm = [regex]::Match($_.Name, '^round_(\d+)$')
        if ($mm.Success) { $n = [int]$mm.Groups[1].Value; if ($n -gt $max) { $max = $n } }
    }
    return "round_{0:D3}" -f ($max + 1)
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
if ($SelfTest) { Invoke-SelfTest }

$flavor = "$Channel$Env"                                  # 如 demoDev
$btCap = $BuildType.Substring(0, 1).ToUpper() + $BuildType.Substring(1)
$chCap = $Channel.Substring(0, 1).ToUpper() + $Channel.Substring(1)
$variantTask = "assemble$chCap$Env$btCap"                 # 如 assembleDemoDevDebug

Write-Host "=== perf-loop | flavor=$flavor buildType=$BuildType events/轮=$Events rounds=$Rounds ===" -ForegroundColor Cyan

# ① 构建 + 安装（仅一次，多轮共用同一包）
if (-not $NoBuild) {
    Write-Host "① build $variantTask" -ForegroundColor Yellow
    $gradlew = Join-Path $AppMarketDir "gradlew.bat"
    if ($DryRun) {
        Write-Host "  [dry] $gradlew -p $AppMarketDir :app-market:$variantTask" -ForegroundColor DarkGray
    } else {
        & $gradlew -p $AppMarketDir ":app-market:$variantTask" --console=plain
        if ($LASTEXITCODE -ne 0) { throw "gradle 构建失败 ($variantTask)" }
    }
    $apkDir = Join-Path $AppMarketDir "sample\app-market\build\outputs\apk\$flavor\$BuildType"
    if ($DryRun) {
        Write-Host "  [dry] adb install -r <newest apk in $apkDir>" -ForegroundColor DarkGray
    } else {
        $apk = Get-ChildItem $apkDir -Filter *.apk -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $apk) { throw "找不到 APK：$apkDir" }
        Write-Host "  install $($apk.Name)"
        # -d 允许版本降级（设备常装着比源码更新的版本码，否则 INSTALL_FAILED_VERSION_DOWNGRADE）。
        # install 失败必须立即终止——否则会带病继续在旧包上跑，采到无效数据。
        $instOut = Adb @("install", "-r", "-d", $apk.FullName)
        if ($instOut -notmatch "Success") { throw "APK 安装失败：$instOut" }
    }
}

# 设备信息（仅一次）
$deviceModel = (Adb @("shell", "getprop", "ro.product.model")).Trim()
$deviceBrand = (Adb @("shell", "getprop", "ro.product.manufacturer")).Trim()
# App 版本（versionName/versionCode）从设备已装包读取——scrape 路径上报需带版本，面板才能按版本分组对比。
$appVersion = ""
$appVersionCode = 0
if (-not $DryRun) {
    $pkgInfo = Adb @("shell", "dumpsys", "package", $Package)
    $vn = [regex]::Match($pkgInfo, 'versionName=(\S+)'); if ($vn.Success) { $appVersion = $vn.Groups[1].Value }
    $vc = [regex]::Match($pkgInfo, 'versionCode=(\d+)'); if ($vc.Success) { $appVersionCode = [int]$vc.Groups[1].Value }
}
Write-Host "  device=$deviceBrand $deviceModel  app=$appVersion ($appVersionCode)" -ForegroundColor DarkGray
if ([string]::IsNullOrWhiteSpace($Serial)) { $deviceId = "$deviceBrand-$deviceModel" } else { $deviceId = $Serial }

# Monkey 参数对齐手动命令（全 ignore + monitor-native + pct 分布 + -v -v）。$Events 为每轮事件数。
$monkeyFlags = @(
    "--throttle", "300",
    "--ignore-crashes", "--ignore-timeouts", "--ignore-security-exceptions",
    "--ignore-native-crashes", "--monitor-native-crashes",
    "--pct-touch", "75", "--pct-trackball", "5", "--pct-syskeys", "0",
    "--pct-nav", "0", "--pct-majornav", "0", "--pct-appswitch", "15",
    "--pct-flip", "0", "--pct-anyevent", "0", "--pct-pinchzoom", "5", "--pct-permission", "0",
    "-v", "-v"
)

# 多轮循环：每轮 = 冷启动测①②③ → Monkey 压测 → 抓 logcat 解析 → 带 round 上报 → 归档
# -DurationHours>0 时按时长跑(忽略 -Rounds)，到点自动停；否则跑 -Rounds 轮。
$endTime = if ($DurationHours -gt 0) { (Get-Date).AddHours($DurationHours) } else { $null }
$r = 0
while ($true) {
    if ($endTime) { if ((Get-Date) -ge $endTime) { break } } else { if ($r -ge $Rounds) { break } }
    $r++
    $round = Next-Round
    $roundDir = Join-Path $ReportsDir $round
    if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $roundDir | Out-Null }
    if ($endTime) {
        $remain = [math]::Round(($endTime - (Get-Date)).TotalHours, 1)
        Write-Host "===== [第 $r 轮 | 剩 ${remain}h] $round (events=$Events) =====" -ForegroundColor Cyan
    } else {
        Write-Host "===== [第 $r/$Rounds 轮] $round (events=$Events) =====" -ForegroundColor Cyan
    }

    # ② 冷启动 + 流式录制 logcat
    # 关键：部分车机（如 C518）`logcat -c` 有时序 bug，-c 后 -d 会丢启动早期行（PerfTracker.init/cold_start
    # 抓不到）。改为**启动前就开流式录制**（Start-Process 直跑 adb logcat，可 kill），确定性抓到冷启动。
    # cold_start 数据走纯 ASCII 的 `cold_start_scrape` 行，故 Start-Process 重定向的编码不影响解析。
    Write-Host "② cold start (streaming logcat)" -ForegroundColor Yellow
    if (-not $script:AdbExe) { $script:AdbExe = (Get-Command adb -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    if ($Reboot -and -not $DryRun) {
        # -Reboot：每轮重启车机再冷启动——最贴近测试「重启车机后，系统加载稳定后点击图标」口径
        # （比 drop_caches 更真实、无 thrash）。重启后等 boot_completed + 系统稳定 RebootSettleSec 秒。
        Write-Host "  reboot device ..." -ForegroundColor Yellow
        $sArg = @(); if (-not [string]::IsNullOrWhiteSpace($Serial)) { $sArg = @("-s", $Serial) }
        & $script:AdbExe @sArg reboot 2>$null | Out-Null
        Start-Sleep -Seconds 5
        & $script:AdbExe @sArg "wait-for-device" 2>$null | Out-Null
        $bootDeadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $bootDeadline) {
            Start-Sleep -Seconds 3
            $bc = (& $script:AdbExe @sArg shell getprop sys.boot_completed 2>$null | Out-String).Trim()
            if ($bc -eq "1") { break }
        }
        Write-Host "  boot_completed, settle ${RebootSettleSec}s ..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $RebootSettleSec
        # 车机可能开机自启应用市场——先 force-stop 保证抓到的是干净新进程冷启动（mock 也重读 perf 开关）。
        & $script:AdbExe @sArg shell am force-stop $Package 2>$null | Out-Null
        & $script:AdbExe @sArg shell am force-stop com.appmarket.automotive.mock 2>$null | Out-Null
        Start-Sleep -Seconds 2
    } else {
        Adb @("shell", "am", "force-stop", $Package) | Out-Null
        Adb @("shell", "am", "force-stop", "com.appmarket.automotive.mock") | Out-Null  # 让 mock 重读 perf 开关
        # -DropCaches：清文件页缓存模拟"真冷启动"（force-stop 只杀进程、页缓存仍热会让 ① 虚低）。需 root。
        # 比逐轮 reboot 快、各轮一致（但清全系统缓存有 thrash 可能偏高），适合 A/B 对比。
        if ($DropCaches -and -not $DryRun) {
            Adb @("shell", "sync; echo 3 > /proc/sys/vm/drop_caches") | Out-Null
            Write-Host "  drop_caches done (cold)" -ForegroundColor DarkGray
            Start-Sleep -Seconds 1
        }
    }
    if (-not $script:AdbExe) { $script:AdbExe = (Get-Command adb -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    $logFile = Join-Path $roundDir "logcat.txt"
    $logProc = $null
    if (-not $DryRun) {
        Start-Sleep -Seconds 2
        Adb @("logcat", "-c") | Out-Null  # 尽力清旧缓冲（C518 上不可靠但无害）
        $logArgs = @()
        if (-not [string]::IsNullOrWhiteSpace($Serial)) { $logArgs += @("-s", $Serial) }
        $logArgs += @("logcat", "-v", "time", "-s", "${PerfTag}:*", "AndroidRuntime:E", "ActivityManager:E")
        $logProc = Start-Process -FilePath $script:AdbExe -ArgumentList $logArgs -RedirectStandardOutput $logFile -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 1
    } else {
        Write-Host "  [dry] (stream) adb logcat -v time -s ${PerfTag}:* ... > $logFile" -ForegroundColor DarkGray
    }
    Adb @("shell", "monkey", "-p", $Package, "-c", "android.intent.category.LAUNCHER", "1") | Out-Null
    if (-not $DryRun) {
        # 等冷启动**收尾**再开 Monkey：固定 sleep 不可靠（drop_caches 冷启动慢且波动，Monkey 过早乱点会
        # 打断到达 HomeActivity 的流程→③ 不触发→抓不到 cold_start）。轮询流式文件出现 cold_start_scrape，
        # 最多等 25s；超时也继续（该轮可能无①②③，但 fg/runtime 仍采）。
        $deadline = (Get-Date).AddSeconds(25)
        $got = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 800
            if ((Test-Path $logFile) -and (Select-String -Path $logFile -SimpleMatch "cold_start_scrape" -Quiet -ErrorAction SilentlyContinue)) { $got = $true; break }
        }
        if ($got) { Write-Host "  cold_start captured" -ForegroundColor DarkGray }
        else { Write-Host "  warn: cold_start 未在 25s 内收尾，继续（本轮可能无①②③）" -ForegroundColor Yellow }
        Start-Sleep -Seconds 1
    }

    # ③ Monkey 压测（参数同手动命令）
    Write-Host "③ monkey x$Events" -ForegroundColor Yellow
    $monkeyOut = Adb (@("shell", "monkey", "-p", $Package) + $monkeyFlags + @("$Events"))
    if (-not $DryRun) { Set-Content -Path (Join-Path $roundDir "monkey.log") -Value $monkeyOut -Encoding utf8 }

    # ④ 停止流式录制并读取（PerfTracker + 系统崩溃/ANR 已实时落 logFile）
    Write-Host "④ stop logcat stream + read" -ForegroundColor Yellow
    if ($DryRun) { Write-Host "DryRun：已打印第 1 轮命令，结束（不实际采集/上报/多轮）。" -ForegroundColor Cyan; exit 0 }
    if ($logProc) {
        Start-Sleep -Seconds 1
        Stop-Process -Id $logProc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    $logcat = if (Test-Path $logFile) { Get-Content $logFile -Raw -Encoding UTF8 } else { "" }

    # ⑤ 解析 + 上报
    Write-Host "⑤ parse + ingest -> $Gateway" -ForegroundColor Yellow
    $parsed = Parse-PerfData -Logcat $logcat -MonkeyOut $monkeyOut
    $payload = [ordered]@{
        sessionId    = [guid]::NewGuid().ToString()
        scenario     = "cold_start"
        flavor       = $flavor
        appVersion   = $appVersion
        appVersionCode = $appVersionCode
        deviceModel  = $deviceModel
        deviceBrand  = $deviceBrand
        deviceId     = $deviceId
        round        = $round
        startup      = [ordered]@{ stage1Ms = $parsed.stage1Ms; stage2Ms = $parsed.stage2Ms; stage3Ms = $parsed.stage3Ms; totalMs = $parsed.totalMs; coldToLoadingMs = $parsed.coldToLoadingMs }
        metrics      = $parsed.metrics
        events       = $parsed.events
    }
    $json = $payload | ConvertTo-Json -Depth 6
    Set-Content -Path (Join-Path $roundDir "round.json") -Value $json -Encoding utf8

    try {
        $resp = Invoke-RestMethod -Uri "$Gateway/api/performance/ingest" -Method Post -Body $json -ContentType "application/json"
        Write-Host "  ingest ok: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
        Write-Host "  ingest 失败（数据已存本地 round.json）：$($_.Exception.Message)" -ForegroundColor Red
    }

    # ⑥ 本轮摘要（含测试口径冷启动 + 前台 CPU/内存峰值，前台峰值从 type=fg 指标取最大值）
    # metrics 是 [ordered]hashtable，Measure-Object -Property 取不到 key，需先 ForEach 取值再 Measure。
    $fgMetrics = @($parsed.metrics | Where-Object { $_.type -eq "fg" })
    $fgCpuPeak = (@($fgMetrics | Where-Object { $_.name -eq "cpu:fgPeak" } | ForEach-Object { $_.cost }) | Measure-Object -Maximum).Maximum
    $fgMemPeak = (@($fgMetrics | Where-Object { $_.name -eq "mem:fgPeakPss" } | ForEach-Object { $_.cost }) | Measure-Object -Maximum).Maximum
    if (-not $fgCpuPeak) { $fgCpuPeak = "—" } else { $fgCpuPeak = "${fgCpuPeak}%" }
    if (-not $fgMemPeak) { $fgMemPeak = "—" } else { $fgMemPeak = "${fgMemPeak}MB" }
    $summary = @"
# $round 摘要

- flavor: $flavor  buildType: $BuildType  events: $Events
- 设备: $deviceBrand $deviceModel
- 冷启动(内部口径): ①$($parsed.stage1Ms)ms ②$($parsed.stage2Ms)ms ③$($parsed.stage3Ms)ms  总计 $($parsed.totalMs)ms
- 测试验收口径冷启动(点击图标→模板页loading): $($parsed.coldToLoadingMs)ms  (目标 <2000ms，测试实测基线 2510ms)
- 前台使用峰值: CPU $fgCpuPeak  内存 $fgMemPeak
- Crash: $($parsed.crashCount)   ANR: $($parsed.anrCount)
- 细分指标: $($parsed.metrics.Count) 条

> 产物: monkey.log / logcat.txt / round.json
> 面板「轮次对比/总览」可查看本轮（GET /api/performance/rounds、/stats）。
"@
    Set-Content -Path (Join-Path $roundDir "summary.md") -Value $summary -Encoding utf8
    Write-Host "=== $round 完成 ===" -ForegroundColor Cyan
}

if ($endTime) { Write-Host "=== 时长跑结束：共完成 $r 轮（$DurationHours 小时）===" -ForegroundColor Cyan }
else { Write-Host "=== 全部 $Rounds 轮完成 ===" -ForegroundColor Cyan }

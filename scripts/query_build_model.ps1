# Build.MODEL Property Diagnostic and Backup Script
# For Huawei/HarmonyOS AAOS (e.g. AITO S9)
# Usage: powershell -ExecutionPolicy Bypass -File query_build_model.ps1 [SERIAL]

param([string]$Serial = "")

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackupDir = Join-Path $PSScriptRoot "build_model_backup_$Timestamp"

function Adb-Cmd {
    if ($Serial -ne "") {
        $result = & adb -s $Serial @args 2>$null
    } else {
        $result = & adb @args 2>$null
    }
    return $result
}

function Adb-Shell {
    param([string]$Cmd)
    if ($Serial -ne "") {
        $result = & adb -s $Serial shell $Cmd 2>$null
    } else {
        $result = & adb shell $Cmd 2>$null
    }
    return $result
}

function Title  { param([string]$T) Write-Host "`n====== $T ======" -ForegroundColor Cyan }
function Info   { param([string]$M) Write-Host "[INFO]  $M" -ForegroundColor Green }
function Warn   { param([string]$M) Write-Host "[WARN]  $M" -ForegroundColor Yellow }
function Err    { param([string]$M) Write-Host "[ERROR] $M" -ForegroundColor Red }

# ============================================================
Title "Step 1: Device Connection Check"
# ============================================================

$devState = Adb-Cmd get-state
if ($LASTEXITCODE -ne 0 -or -not $devState) {
    Err "No device connected. Please check:"
    Write-Host "  - USB cable"
    Write-Host "  - USB debugging enabled"
    Write-Host "  - ADB driver installed"
    Adb-Cmd devices -l
    exit 1
}
$deviceInfo = (Adb-Cmd devices -l) | Where-Object { $_ -match "\sdevice\s" } | Select-Object -First 1
Info "Connected: $deviceInfo"

# ============================================================
Title "Step 2: Device Info"
# ============================================================

$Model      = (Adb-Shell "getprop ro.product.model") -join "" | ForEach-Object { $_.Trim() }
$Brand      = (Adb-Shell "getprop ro.product.brand") -join "" | ForEach-Object { $_.Trim() }
$DevName    = (Adb-Shell "getprop ro.product.device") -join "" | ForEach-Object { $_.Trim() }
$AndroidVer = (Adb-Shell "getprop ro.build.version.release") -join "" | ForEach-Object { $_.Trim() }
$BuildId    = (Adb-Shell "getprop ro.build.display.id") -join "" | ForEach-Object { $_.Trim() }

Write-Host "  Brand:       $Brand"
Write-Host "  Model:       $Model"
Write-Host "  Device:      $DevName"
Write-Host "  Android:     $AndroidVer"
Write-Host "  Build ID:    $BuildId"

$hasNonAscii = $Model -match '[^\x00-\x7F]'
if ($hasNonAscii) {
    Warn "Build.MODEL contains non-ASCII chars: `"$Model`""
    Warn "This will cause Amazon Music HTTP Header failures!"
} else {
    Info "Build.MODEL is pure ASCII: `"$Model`""
}

# ============================================================
Title "Step 3: All model-related properties"
# ============================================================

$allProps = Adb-Shell "getprop"
$allProps | Where-Object { $_ -match "model" } | ForEach-Object {
    $line = $_.Trim()
    if ($line -match '[^\x00-\x7F]') {
        Write-Host "  $line  <-- non-ASCII!" -ForegroundColor Red
    } else {
        Write-Host "  $line"
    }
}

# ============================================================
Title "Step 4: model in each partition build.prop"
# ============================================================

$PropFiles = @(
    "/system/build.prop",
    "/vendor/build.prop",
    "/vendor/odm/etc/build.prop",
    "/odm/etc/build.prop",
    "/product/etc/build.prop",
    "/system_ext/etc/build.prop",
    "/cust/build.prop",
    "/hw_product/build.prop",
    "/preload/build.prop",
    "/default.prop",
    "/prop.default",
    "/vendor/default.prop"
)

foreach ($f in $PropFiles) {
    $result = Adb-Shell "grep -i model $f 2>/dev/null"
    if ($result) {
        Write-Host "  $f" -ForegroundColor Green
        $result | ForEach-Object { Write-Host "    $($_.Trim())" }
    }
}

# ============================================================
Title "Step 5: Huawei/HarmonyOS special paths"
# ============================================================

Info "Searching Huawei-specific partitions..."

$hwPaths = @("/cust/", "/hw_product/", "/preload/", "/version/", "/patch_hw/")
foreach ($p in $hwPaths) {
    $check = Adb-Shell "ls $p 2>/dev/null"
    if ($check) {
        Info "Found Huawei partition: $p"
        $propFiles2 = Adb-Shell "find $p -name '*.prop' -o -name '*.cfg' 2>/dev/null"
        $propFiles2 | Select-Object -First 20 | ForEach-Object { Write-Host "    $($_.Trim())" }
    }
}

# ============================================================
Title "Step 6: Search for Chinese device name"
# ============================================================

Info "Searching for non-ASCII device name in key partitions..."

$cnResult = Adb-Shell "grep -rl '享界' /system/ /vendor/ /odm/ /product/ /cust/ /hw_product/ 2>/dev/null"
if ($cnResult) {
    Info "Found files containing Chinese device name:"
    $cnResult | ForEach-Object {
        $file = $_.Trim()
        Write-Host "  [FOUND] $file" -ForegroundColor Red
        $content = Adb-Shell "grep '享界' '$file' 2>/dev/null"
        $content | ForEach-Object { Write-Host "    $($_.Trim())" }
    }
} else {
    Warn "Not found in standard partitions."
    Info "Searching init scripts for product.model..."
    $initResult = Adb-Shell "grep -rl 'product.model' /vendor/etc/init/ /system/etc/init/ /odm/etc/init/ 2>/dev/null"
    if ($initResult) {
        $initResult | ForEach-Object {
            $file = $_.Trim()
            Write-Host "  [init] $file"
            $content = Adb-Shell "grep 'product.model' '$file' 2>/dev/null"
            $content | ForEach-Object { Write-Host "    $($_.Trim())" }
        }
    }
}

# ============================================================
Title "Step 7: Check persist properties"
# ============================================================

$persistModel = $allProps | Where-Object { $_ -match "persist.*model" }
if ($persistModel) {
    Info "Found persist model properties:"
    $persistModel | ForEach-Object { Write-Host "  $($_.Trim())" }
} else {
    Info "No persist model override found."
}

# ============================================================
Title "Step 8: Backup"
# ============================================================

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

Info "Exporting all properties..."
$allProps | Out-File -FilePath (Join-Path $BackupDir "all_properties.txt") -Encoding UTF8

Info "Backing up build.prop files..."
foreach ($f in $PropFiles) {
    $safeName = $f.TrimStart("/").Replace("/", "_")
    $outPath = Join-Path $BackupDir $safeName
    $content = Adb-Shell "cat $f 2>/dev/null"
    if ($content) {
        $content | Out-File -FilePath $outPath -Encoding UTF8
        $size = (Get-Item $outPath).Length
        if ($size -gt 0) {
            Write-Host "  [OK] $f => $safeName" -ForegroundColor Green
        } else {
            Remove-Item $outPath -Force
        }
    }
}

Info "Listing all .prop files on device..."
$propList = Adb-Shell "find / -name '*.prop' 2>/dev/null"
if ($propList) {
    $propList | Out-File -FilePath (Join-Path $BackupDir "all_prop_files_list.txt") -Encoding UTF8
}

# ============================================================
Title "Step 9: Summary"
# ============================================================

Write-Host ""
Write-Host "  Current Build.MODEL:  $Model"
Write-Host "  Backup directory:     $BackupDir\"
Write-Host ""

Get-ChildItem $BackupDir | ForEach-Object {
    $sizeKB = [math]::Round($_.Length / 1KB, 1)
    Write-Host ("  {0,-40} {1,8} KB" -f $_.Name, $sizeKB)
}

Write-Host ""
Write-Host "  --------------------------------------------------"
if ($hasNonAscii) {
    Write-Host "  [RESULT] Build.MODEL contains non-ASCII, NEED FIX!" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Fix commands (requires root):"
    Write-Host "    adb root"
    Write-Host "    adb remount"
    Write-Host '    adb shell "sed -i ''s/OLD_NAME/NEW_NAME/g'' <file_path>"'
    Write-Host "    adb reboot"
} else {
    Write-Host "  [RESULT] Build.MODEL is pure ASCII, no fix needed." -ForegroundColor Green
}
Write-Host "  --------------------------------------------------"
Write-Host ""
Info "Diagnostic complete!"

param(
    [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$STATE_PATH = Join-Path $ROOT "docs\tempFiles\service-control-state.json"
$ports = @(3000, 3001, 3002)

function ConvertTo-Map($obj) {
    $map = @{}
    if ($null -eq $obj) { return $map }
    foreach ($prop in $obj.PSObject.Properties) {
        $map[$prop.Name] = $prop.Value
    }
    return $map
}

function Read-ControlState {
    if (-not (Test-Path -LiteralPath $STATE_PATH)) { return @{} }
    try {
        return ConvertTo-Map (Get-Content -LiteralPath $STATE_PATH -Raw | ConvertFrom-Json)
    } catch {
        return @{}
    }
}

function Get-StateInt([hashtable]$State, [string]$Key) {
    if (-not $State.ContainsKey($Key) -or $null -eq $State[$Key]) { return 0 }
    try { return [int]$State[$Key] } catch { return 0 }
}

function Save-ControlState([hashtable]$State) {
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $STATE_PATH))) { return }
    $State["status"] = "stopped"
    $State["phase"] = "stopped"
    $State["message"] = "Services stopped by stop.bat"
    $State["gatewayPid"] = $null
    $State["webPid"] = $null
    $State["panelUrl"] = $null
    $State["gatewayUrl"] = $null
    $State["updatedAt"] = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    ([pscustomobject]$State | ConvertTo-Json -Depth 8) |
        Set-Content -LiteralPath $STATE_PATH -Encoding UTF8
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-ElevatedSelf {
    $script = $PSCommandPath
    if (-not $script) { $script = $MyInvocation.MyCommand.Path }
    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$script`"",
        "-Elevated"
    )
    try {
        $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs -Wait -PassThru
        return [int]$proc.ExitCode
    } catch {
        Write-Host "[ERROR] UAC elevation was cancelled or failed: $($_.Exception.Message)" -ForegroundColor Red
        return 1223
    }
}

function Stop-PortProcess {
    param([int]$Port)

    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) {
        Write-Host "[SKIP] Port $Port is not listening" -ForegroundColor DarkGray
        return
    }

    $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -ne 0 }
    foreach ($pidToStop in $processIds) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.Name } else { "PID $pidToStop" }
        Write-Host "[..] Stopping port $Port -> $name ($pidToStop)" -ForegroundColor Yellow
        & taskkill.exe /PID $pidToStop /T /F | Write-Host
        Start-Sleep -Milliseconds 300

        $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $pidToStop }
        if ($stillListening) {
            throw "Failed to stop PID $pidToStop on port $Port"
        }
        Write-Host "[OK] Port $Port stopped" -ForegroundColor Green
    }
}

function Stop-StateProcess {
    param(
        [int]$ProcessId,
        [int]$ExpectedPort,
        [string]$Label
    )

    if ($ProcessId -le 0) { return }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $proc) { return }

    $text = "$($proc.CommandLine) $($proc.ExecutablePath)"
    $looksRepoOwned = $text.IndexOf($ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $ownsExpectedPort = $false
    if ($ExpectedPort -gt 0) {
        $ownsExpectedPort = @(Get-NetTCPConnection -LocalPort $ExpectedPort -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $ProcessId }).Count -gt 0
    }
    $looksLegacyGateway = $ownsExpectedPort -and ($text -match "(^|\s)server\.js(\s|$)")

    if (-not $looksRepoOwned -and -not $looksLegacyGateway) {
        Write-Host "[SKIP] State PID $ProcessId for $Label does not look like this repo" -ForegroundColor DarkGray
        return
    }

    Write-Host "[..] Stopping $Label from control state -> $($proc.Name) ($ProcessId)" -ForegroundColor Yellow
    & taskkill.exe /PID $ProcessId /T /F | Write-Host
    Start-Sleep -Milliseconds 300
}

Write-Host "[AIEfficiency] Stopping services..." -ForegroundColor Cyan

if (-not (Test-IsAdministrator)) {
    Write-Host "[INFO] Administrator permission is required to stop elevated processes." -ForegroundColor Yellow
    Write-Host "[INFO] Requesting UAC elevation. Click Yes in the Windows prompt." -ForegroundColor Yellow
    exit (Start-ElevatedSelf)
}

foreach ($port in $ports) {
    Stop-PortProcess -Port $port
}

$state = Read-ControlState
if ($state.Count -gt 0) {
    Stop-StateProcess -ProcessId (Get-StateInt $state "webPid") -ExpectedPort (Get-StateInt $state "webPort") -Label "web"
    Stop-StateProcess -ProcessId (Get-StateInt $state "gatewayPid") -ExpectedPort (Get-StateInt $state "gatewayPort") -Label "gateway"
    Save-ControlState $state
}

Write-Host "[OK] All target services stopped" -ForegroundColor Green
exit 0

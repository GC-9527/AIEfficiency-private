param(
    [int]$GatewayPort = 3001,
    [int]$WebPort = 3000,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$GW = Join-Path $ROOT "gateway"
$WEB = Join-Path $ROOT "web-dashboard"
$APPMARKET_MCP = Join-Path $ROOT "mcp-servers\devServer"
$LOG_DIR = Join-Path $ROOT "docs\tempFiles\startup-logs"
$started = @()

function Write-Step($text) { Write-Host "[..] $text" -ForegroundColor Yellow }
function Write-Ok($text) { Write-Host "[OK] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[WARN] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "[ERROR] $text" -ForegroundColor Red }

function Get-ListenOwners([int]$Port) {
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -and $_ -ne 0 })
}

function Get-ProcInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-RepoProcess($proc) {
    if (-not $proc) { return $false }
    $text = "$($proc.CommandLine) $($proc.ExecutablePath)"
    return $text.IndexOf($ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Show-PortOwners([int]$Port) {
    $owners = Get-ListenOwners $Port
    if ($owners.Count -eq 0) {
        Write-Host "  port ${Port}: free" -ForegroundColor DarkGray
        return
    }
    foreach ($pidToShow in $owners) {
        $proc = Get-ProcInfo $pidToShow
        $name = if ($proc) { $proc.Name } else { "unknown" }
        $cmd = if ($proc -and $proc.CommandLine) { $proc.CommandLine } else { "(command line hidden or elevated)" }
        Write-Host "  port ${Port}: PID $pidToShow $name" -ForegroundColor Yellow
        Write-Host "    $cmd" -ForegroundColor DarkGray
    }
}

function Stop-RepoProcessOnPort([int]$Port) {
    $owners = Get-ListenOwners $Port
    foreach ($pidToStop in $owners) {
        $proc = Get-ProcInfo $pidToStop
        if (-not (Test-RepoProcess $proc)) { continue }
        Write-Step "Stopping previous AIEfficiency process on port $Port (PID $pidToStop)"
        & taskkill.exe /PID $pidToStop /T /F | Out-Host
        Start-Sleep -Milliseconds 500
    }
}

function Find-FreePort([int[]]$Candidates) {
    foreach ($port in $Candidates) {
        if ((Get-ListenOwners $port).Count -eq 0) { return $port }
    }
    return $null
}

function Resolve-Port([string]$Name, [int]$Preferred, [int[]]$Fallbacks) {
    Write-Step "Checking $Name port $Preferred"
    Show-PortOwners $Preferred
    Stop-RepoProcessOnPort $Preferred
    if ((Get-ListenOwners $Preferred).Count -eq 0) { return $Preferred }

    Write-Warn "$Name port $Preferred is still occupied. It may belong to another project or an elevated process."
    $free = Find-FreePort $Fallbacks
    if (-not $free) { throw "No free $Name port found in: $($Fallbacks -join ', ')" }
    Write-Warn "$Name will use fallback port $free"
    return $free
}

function Wait-HttpOk([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Tail-File([string]$Path, [int]$Lines = 40) {
    if (Test-Path -LiteralPath $Path) {
        Write-Host "---- $Path" -ForegroundColor DarkGray
        Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host $_ -ForegroundColor DarkGray
        }
    }
}

function Start-LoggedProcess($FilePath, $ArgumentList, $WorkingDirectory, $Stdout, $Stderr) {
    $proc = Start-Process -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $Stdout `
        -RedirectStandardError $Stderr `
        -PassThru
    $script:started += $proc
    return $proc
}

function Ensure-Dependencies([string]$Dir, [string]$Name, [string[]]$RequiredPackages = @()) {
    $nodeModules = Join-Path $Dir "node_modules"
    $ready = Test-Path -LiteralPath $nodeModules
    foreach ($packagePath in $RequiredPackages) {
        if (-not (Test-Path -LiteralPath (Join-Path $nodeModules $packagePath))) {
            $ready = $false
        }
    }
    if ($ready) {
        Write-Ok "$Name dependencies found"
        return
    }
    Write-Step "Installing $Name dependencies with npm install"
    Push-Location $Dir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed in $Dir" }
    } finally {
        Pop-Location
    }
}

function Stop-StartedProcesses {
    foreach ($proc in $script:started) {
        if ($proc -and -not $proc.HasExited) {
            try { & taskkill.exe /PID $proc.Id /T /F | Out-Null } catch {}
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $gwOut = Join-Path $LOG_DIR "gateway_$stamp.out.log"
    $gwErr = Join-Path $LOG_DIR "gateway_$stamp.err.log"
    $webOut = Join-Path $LOG_DIR "web_$stamp.out.log"
    $webErr = Join-Path $LOG_DIR "web_$stamp.err.log"

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host " AIEfficiency Start And Diagnose" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "Repo: $ROOT" -ForegroundColor DarkGray
    Write-Host ""

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js not found. Install Node.js 20+ first." }
    Write-Ok "Node $(node -v) -> $($node.Source)"

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm not found. Reinstall Node.js and make sure npm is in PATH." }
    Write-Ok "npm $(npm -v)"

    if (-not (Test-Path -LiteralPath $GW)) { throw "Missing gateway directory: $GW" }
    if (-not (Test-Path -LiteralPath $WEB)) { throw "Missing web-dashboard directory: $WEB" }
    if (-not (Test-Path -LiteralPath $APPMARKET_MCP)) { throw "Missing AppMarket MCP directory: $APPMARKET_MCP" }

    Ensure-Dependencies $GW "gateway" @("@modelcontextprotocol\sdk\package.json", "zod\package.json")
    Ensure-Dependencies $WEB "web-dashboard"
    Ensure-Dependencies $APPMARKET_MCP "AppMarket read-only MCP" @("@modelcontextprotocol\sdk\package.json", "zod\package.json")

    $gatewayPortCandidates = @($GatewayPort) + (3002..3009)
    $webPortCandidates = @($WebPort) + (3010..3020)
    $GatewayPort = Resolve-Port "gateway" $GatewayPort $gatewayPortCandidates
    $WebPort = Resolve-Port "web" $WebPort $webPortCandidates

    Write-Step "Starting gateway on port $GatewayPort"
    $oldPort = $env:PORT
    $env:PORT = [string]$GatewayPort
    try {
        $gwProc = Start-LoggedProcess "node" @("server.js") $GW $gwOut $gwErr
    } finally {
        if ($null -eq $oldPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $oldPort }
    }

    if (-not (Wait-HttpOk "http://127.0.0.1:${GatewayPort}/api/health" 25)) {
        Write-Err "Gateway did not become healthy at http://127.0.0.1:${GatewayPort}/api/health"
        Tail-File $gwErr
        Tail-File $gwOut
        throw "Gateway startup failed"
    }
    Write-Ok "Gateway ready: http://127.0.0.1:${GatewayPort}"

    Write-Step "Starting Vite web server on port $WebPort"
    $oldGatewayUrl = $env:VITE_GATEWAY_URL
    $env:VITE_GATEWAY_URL = "http://127.0.0.1:${GatewayPort}"
    try {
        $webArgs = @("/d", "/s", "/c", "npm run dev -- --host 0.0.0.0 --port $WebPort --strictPort")
        $webProc = Start-LoggedProcess $env:ComSpec $webArgs $WEB $webOut $webErr
    } finally {
        if ($null -eq $oldGatewayUrl) { Remove-Item Env:VITE_GATEWAY_URL -ErrorAction SilentlyContinue } else { $env:VITE_GATEWAY_URL = $oldGatewayUrl }
    }

    if (-not (Wait-HttpOk "http://127.0.0.1:${WebPort}" 25)) {
        Write-Err "Vite did not respond at http://127.0.0.1:${WebPort}"
        Write-Warn "Common causes: npm dependency install failed, port occupied, Vite crashed, or another project is using the port."
        Tail-File $webErr
        Tail-File $webOut
        throw "Web startup failed"
    }
    Write-Ok "Web panel ready: http://127.0.0.1:${WebPort}"

    $openUrl = "http://127.0.0.1:${WebPort}/?gateway=http://127.0.0.1:${GatewayPort}"
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host " Gateway: $([string]::Format('http://127.0.0.1:{0}', $GatewayPort))" -ForegroundColor White
    Write-Host " Panel:   $openUrl" -ForegroundColor White
    Write-Host " Note:    If localhost fails, use 127.0.0.1 above." -ForegroundColor Yellow
    Write-Host " Logs:    $LOG_DIR" -ForegroundColor DarkGray
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""

    if (-not $NoBrowser) {
        Write-Step "Opening browser"
        Start-Process $openUrl | Out-Null
    }

    Write-Host "Keep this window open while using the app." -ForegroundColor Yellow
    Write-Host "Press Enter here to stop the services started by this script." -ForegroundColor Yellow
    [void][Console]::ReadLine()
    Stop-StartedProcesses
    Write-Ok "Stopped services started by this script"
    exit 0
} catch {
    Write-Err $_.Exception.Message
    Write-Host ""
    Write-Host "Troubleshooting tips:" -ForegroundColor Yellow
    Write-Host "  1. If a port is occupied by an elevated process, run stop.bat and approve UAC." -ForegroundColor Yellow
    Write-Host "  2. Check logs under docs\\tempFiles\\startup-logs." -ForegroundColor Yellow
    Write-Host "  3. If another project uses 3000 or 3010, use the Panel URL printed by this script." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

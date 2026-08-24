[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("all", "web", "backend", "desktop", "service-control", "cloud")]
    [string]$Target,

    [switch]$SkipInstall,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputRoot = Join-Path $RepoRoot "dist"
$Interactive = [string]::IsNullOrWhiteSpace($Target)
$StartedAt = Get-Date
$TranscriptStarted = $false
$script:NpmCommand = $null
$script:Artifacts = New-Object System.Collections.ArrayList
$script:GatewayBundleBuilt = $false
$LogPath = $null

function Write-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " AIEfficiency Release Builder" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " Repository : $RepoRoot" -ForegroundColor DarkGray
    Write-Host " Output     : $OutputRoot" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "[..] $Text" -ForegroundColor Yellow
}

function Write-Ok([string]$Text) {
    Write-Host "[OK] $Text" -ForegroundColor Green
}

function Write-Info([string]$Text) {
    Write-Host "[INFO] $Text" -ForegroundColor Cyan
}

function Write-Warn([string]$Text) {
    Write-Host "[WARN] $Text" -ForegroundColor Yellow
}

function Select-BuildTarget {
    Write-Banner
    Write-Host "Choose what to build:" -ForegroundColor White
    Write-Host ""
    Write-Host "  [1] Full release (recommended)" -ForegroundColor Green
    Write-Host "      Web + backend + desktop + service control + cloud"
    Write-Host "  [2] Web dashboard"
    Write-Host "  [3] Gateway backend"
    Write-Host "  [4] Desktop application"
    Write-Host "  [5] Service Control application"
    Write-Host "  [6] Cloud deployment package"
    Write-Host "  [0] Exit"
    Write-Host ""

    $Choice = Read-Host "Selection [1]"
    if ([string]::IsNullOrWhiteSpace($Choice)) { $Choice = "1" }

    switch ($Choice.Trim()) {
        "1" { return "all" }
        "2" { return "web" }
        "3" { return "backend" }
        "4" { return "desktop" }
        "5" { return "service-control" }
        "6" { return "cloud" }
        "0" { return $null }
        default { throw "Unknown selection '$Choice'. Run build.bat and choose 0-6." }
    }
}

function Assert-PathInsideRepo([string]$Path) {
    $FullRepo = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\') + '\'
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $FullPath.StartsWith($FullRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the repository: $FullPath"
    }
}

function Reset-GeneratedDirectory([string]$Path) {
    Assert-PathInsideRepo $Path
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Sync-Directory([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Source directory not found: $Source"
    }

    Assert-PathInsideRepo $Destination
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy.exe $Source $Destination /MIR /R:2 /W:1 /COPY:DAT /DCOPY:DAT /NFL /NDL /NJH /NJS /NP
    $Code = $LASTEXITCODE
    $global:LASTEXITCODE = 0
    if ($Code -ge 8) {
        throw "Failed to copy '$Source' to '$Destination' (robocopy exit code $Code)."
    }
}

function Copy-RequiredFile([string]$Source, [string]$DestinationDirectory) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required file not found: $Source"
    }
    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    Copy-Item -LiteralPath $Source -Destination $DestinationDirectory -Force
}

function Invoke-CheckedCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [string]$Description
    )

    Write-Step $Description
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        $Code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($Code -ne 0) {
        throw "$Description failed with exit code $Code."
    }
    Write-Ok $Description
}

function Invoke-ElectronBuilderWithRetry {
    param(
        [string]$Builder,
        [string]$WorkingDirectory,
        [string]$OutputDirectory,
        [string]$Description
    )

    $MaxAttempts = 2
    for ($Attempt = 1; $Attempt -le $MaxAttempts; $Attempt++) {
        $StepDescription = if ($Attempt -eq 1) {
            $Description
        } else {
            "$Description (retry $Attempt of $MaxAttempts)"
        }
        Write-Step $StepDescription

        $Code = 1
        Push-Location $WorkingDirectory
        try {
            & $Builder --win
            $Code = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        if ($Code -eq 0) {
            Write-Ok $Description
            return
        }
        if ($Attempt -eq $MaxAttempts) {
            throw "$Description failed with exit code $Code after $MaxAttempts attempts."
        }

        Write-Warn "$Description failed with exit code $Code. Retrying after cleaning the build output."
        Start-Sleep -Seconds 2
        Reset-GeneratedDirectory $OutputDirectory
    }
}

function Ensure-NodeProject([string]$Directory, [string]$Name) {
    $PackageJson = Join-Path $Directory "package.json"
    if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
        throw "$Name package.json not found: $PackageJson"
    }

    $Modules = Join-Path $Directory "node_modules"
    if (Test-Path -LiteralPath $Modules -PathType Container) {
        Write-Ok "$Name dependencies found"
        return
    }

    if ($SkipInstall) {
        throw "$Name dependencies are missing and -SkipInstall was specified: $Modules"
    }

    $LockFile = Join-Path $Directory "package-lock.json"
    if (Test-Path -LiteralPath $LockFile -PathType Leaf) {
        Invoke-CheckedCommand $script:NpmCommand @("ci", "--no-audit", "--no-fund") $Directory "Install $Name dependencies (npm ci)"
    } else {
        Invoke-CheckedCommand $script:NpmCommand @("install", "--no-audit", "--no-fund") $Directory "Install $Name dependencies (npm install)"
    }
}

function Register-Artifact([string]$Name, [string]$Path) {
    $Existing = @($script:Artifacts | Where-Object { $_.Path -eq $Path })
    if ($Existing.Count -gt 0) { return }
    [void]$script:Artifacts.Add([pscustomobject]@{ Name = $Name; Path = $Path })
}

function Get-PathStats([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $Item = Get-Item -LiteralPath $Path
        return [pscustomobject]@{ Files = 1; Bytes = $Item.Length }
    }

    $Measure = Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    $Bytes = if ($null -eq $Measure.Sum) { 0 } else { [long]$Measure.Sum }
    return [pscustomobject]@{ Files = [int]$Measure.Count; Bytes = $Bytes }
}

function New-ZipFromDirectory([string]$Source, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Force
    }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $Source,
        $Destination,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
}

function Prepare-ReleaseResources([string]$DestinationRoot) {
    $Helper = Join-Path $RepoRoot "scripts\prepare-release-resources.mjs"
    Invoke-CheckedCommand (Get-Command node).Source @($Helper, $DestinationRoot) $RepoRoot "Prepare sanitized release resources"
}

function Test-ReleaseResources([string]$Root) {
    $Helper = Join-Path $RepoRoot "scripts\prepare-release-resources.mjs"
    Invoke-CheckedCommand (Get-Command node).Source @($Helper, "--verify", $Root) $RepoRoot "Verify sanitized release resources"
}

function Remove-BlockedReleaseFiles([string]$Root) {
    $BlockedExtensions = @(
        ".7z", ".gz", ".jar", ".jks", ".key", ".keystore", ".p12",
        ".mobileprovision", ".pem", ".pfx", ".rar", ".tar", ".tgz", ".zip"
    )
    $BlockedNames = @(".env", "credentials.json", "id_ed25519", "id_rsa", "service-account.json")
    $BlockedDirectories = @("__tests__", "fixture", "fixtures", "test", "tests")
    Get-ChildItem -LiteralPath $Root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $BlockedDirectories -contains $_.Name.ToLowerInvariant() } |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
            Assert-PathInsideRepo $_.FullName
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $BlockedExtensions -contains $_.Extension.ToLowerInvariant() -or
            $BlockedNames -contains $_.Name.ToLowerInvariant() -or
            $_.Name.ToLowerInvariant().StartsWith(".env.") -or
            ($_.FullName -match '[\\/]node_modules[\\/]' -and
                $_.Name -match '(^|[._-])(test|tests|spec)([._-]|$)')
        } |
        Remove-Item -Force
}

function Copy-GatewaySource([string]$DestinationRoot, [switch]$IncludeNodeModules) {
    $GatewaySource = Join-Path $RepoRoot "gateway"
    $GatewayDestination = Join-Path $DestinationRoot "gateway"
    New-Item -ItemType Directory -Force -Path $GatewayDestination | Out-Null

    foreach ($Name in @(
        "package.json",
        "package-lock.json",
        "server.js",
        "config.example.json",
        "buried-point-db.example.json"
    )) {
        Copy-RequiredFile (Join-Path $GatewaySource $Name) $GatewayDestination
    }

    Sync-Directory (Join-Path $GatewaySource "routes") (Join-Path $GatewayDestination "routes")
    Sync-Directory (Join-Path $GatewaySource "services") (Join-Path $GatewayDestination "services")
    Sync-Directory (Join-Path $RepoRoot "mcp-servers\devServer") (Join-Path $GatewayDestination "mcp-servers\devServer")

    $DbDestination = Join-Path $GatewayDestination "db"
    New-Item -ItemType Directory -Force -Path $DbDestination | Out-Null
    Copy-RequiredFile (Join-Path $GatewaySource "db\sqlite.js") $DbDestination

    if ($IncludeNodeModules) {
        Sync-Directory (Join-Path $GatewaySource "node_modules") (Join-Path $GatewayDestination "node_modules")
    }

    Remove-BlockedReleaseFiles $GatewayDestination

    Prepare-ReleaseResources $DestinationRoot
}

function Build-Web {
    $WebDir = Join-Path $RepoRoot "web-dashboard"
    Ensure-NodeProject $WebDir "Web dashboard"
    Invoke-CheckedCommand $script:NpmCommand @("run", "build") $WebDir "Build web dashboard"

    $Source = Join-Path $WebDir "dist"
    if (-not (Test-Path -LiteralPath (Join-Path $Source "index.html") -PathType Leaf)) {
        throw "Web build did not produce dist\index.html."
    }

    $Destination = Join-Path $OutputRoot "web-dashboard"
    Reset-GeneratedDirectory $Destination
    Sync-Directory $Source $Destination
    Register-Artifact "Web dashboard" $Destination
}

function Build-GatewaySourceBundle {
    if ($script:GatewayBundleBuilt) { return }

    $Stage = Join-Path $OutputRoot (".gateway-stage-" + [Guid]::NewGuid().ToString("N"))
    $ZipPath = Join-Path $OutputRoot "gateway-bundle.zip"
    try {
        Reset-GeneratedDirectory $Stage
        Copy-GatewaySource $Stage
        Write-Step "Create portable gateway source bundle"
        New-ZipFromDirectory $Stage $ZipPath
        Write-Ok "Create portable gateway source bundle"
    } finally {
        if (Test-Path -LiteralPath $Stage) {
            Remove-Item -LiteralPath $Stage -Recurse -Force
        }
    }

    $script:GatewayBundleBuilt = $true
    Register-Artifact "Gateway source bundle" $ZipPath
}

function Build-Backend {
    $GatewayDir = Join-Path $RepoRoot "gateway"
    Ensure-NodeProject $GatewayDir "Gateway"
    Invoke-CheckedCommand (Get-Command node).Source @("--check", "server.js") $GatewayDir "Validate gateway entry point"

    $Destination = Join-Path $OutputRoot "backend"
    Reset-GeneratedDirectory $Destination
    Write-Step "Assemble self-contained gateway backend"
    Copy-GatewaySource $Destination -IncludeNodeModules

    $RuntimeDir = Join-Path $Destination "node-runtime"
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $RuntimeDir "node.exe") -Force
    [ordered]@{
        platform = "win32"
        arch = $env:PROCESSOR_ARCHITECTURE
        version = (& node --version)
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir "runtime.json") -Encoding UTF8

    @'
@echo off
setlocal
cd /d "%~dp0gateway"
if not exist "%~dp0node-runtime\node.exe" (
  echo [ERROR] Bundled Node.js runtime is missing.
  pause
  exit /b 1
)
"%~dp0node-runtime\node.exe" server.js
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
'@ | Set-Content -LiteralPath (Join-Path $Destination "start-backend.bat") -Encoding ASCII

    @'
AIEfficiency Gateway backend

Run start-backend.bat to start the gateway with the bundled Node.js runtime.
Local config, credentials, secrets, databases, logs, and feedback attachments are
intentionally excluded. Configure the new installation after its first start.
'@ | Set-Content -LiteralPath (Join-Path $Destination "README.txt") -Encoding ASCII

    Write-Ok "Assemble self-contained gateway backend"
    Build-GatewaySourceBundle
    Register-Artifact "Gateway backend" $Destination
}

function Build-ElectronPackage {
    param(
        [string]$ProjectName,
        [string]$ProjectDirectory,
        [string]$DestinationName,
        [switch]$CleanWithNpm
    )

    Ensure-NodeProject $ProjectDirectory $ProjectName
    Invoke-CheckedCommand $script:NpmCommand @("run", "prepare-gateway") $ProjectDirectory "Prepare $ProjectName gateway resources"
    Invoke-CheckedCommand $script:NpmCommand @("run", "prepare-node-runtime") $ProjectDirectory "Prepare $ProjectName Node.js runtime"
    Invoke-CheckedCommand $script:NpmCommand @("run", "prepare-release-resources") $ProjectDirectory "Prepare $ProjectName sanitized release resources"

    $ProjectDist = Join-Path $ProjectDirectory "dist"
    if ($CleanWithNpm) {
        Invoke-CheckedCommand $script:NpmCommand @("run", "clean-dist") $ProjectDirectory "Clean $ProjectName build output"
    } else {
        Reset-GeneratedDirectory $ProjectDist
    }

    $Builder = Join-Path $ProjectDirectory "node_modules\.bin\electron-builder.cmd"
    if (-not (Test-Path -LiteralPath $Builder -PathType Leaf)) {
        throw "$ProjectName electron-builder was not found: $Builder"
    }

    $PreviousSigning = $env:CSC_IDENTITY_AUTO_DISCOVERY
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    try {
        Invoke-ElectronBuilderWithRetry $Builder $ProjectDirectory $ProjectDist "Package $ProjectName for Windows"
    } finally {
        if ($null -eq $PreviousSigning) {
            Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
        } else {
            $env:CSC_IDENTITY_AUTO_DISCOVERY = $PreviousSigning
        }
    }

    $Installer = @(Get-ChildItem -LiteralPath $ProjectDist -File -Filter "*.exe" -ErrorAction SilentlyContinue)
    if ($Installer.Count -eq 0) {
        throw "$ProjectName packaging did not produce a top-level Windows installer."
    }

    $Destination = Join-Path $OutputRoot $DestinationName
    Reset-GeneratedDirectory $Destination
    Sync-Directory $ProjectDist $Destination
    foreach ($DebugMetadata in @("builder-debug.yml", "builder-effective-config.yaml")) {
        $DebugPath = Join-Path $Destination $DebugMetadata
        if (Test-Path -LiteralPath $DebugPath) {
            Remove-Item -LiteralPath $DebugPath -Force
        }
    }
    Register-Artifact $ProjectName $Destination
}

function Test-DesktopReleasePreflight {
    $DesktopDirectory = Join-Path $RepoRoot "desktop"
    Ensure-NodeProject $DesktopDirectory "Desktop"
    Ensure-NodeProject (Join-Path $RepoRoot "gateway") "Gateway"
    Invoke-CheckedCommand $script:NpmCommand @("run", "preflight") $DesktopDirectory "Run Desktop release preflight"
}

function Build-Desktop {
    Build-ElectronPackage "Desktop" (Join-Path $RepoRoot "desktop") "desktop"
}

function Build-ServiceControl {
    $ServiceControlDirectory = Join-Path $RepoRoot "service-control-electron"
    Ensure-NodeProject $ServiceControlDirectory "Service Control"
    Invoke-CheckedCommand $script:NpmCommand @("test") $ServiceControlDirectory "Run Service Control release preflight"
    Build-ElectronPackage "Service Control" (Join-Path $RepoRoot "service-control-electron") "service-control" -CleanWithNpm
}

function Build-Cloud {
    Build-GatewaySourceBundle

    $CloudSource = Join-Path $RepoRoot "cloud"
    $Destination = Join-Path $OutputRoot "cloud"
    Reset-GeneratedDirectory $Destination
    Write-Step "Assemble cloud deployment package"

    foreach ($Name in @("package.json", "server.js", "Dockerfile")) {
        Copy-RequiredFile (Join-Path $CloudSource $Name) $Destination
    }
    Copy-Item -LiteralPath (Join-Path $OutputRoot "gateway-bundle.zip") -Destination $Destination -Force
    Sync-Directory (Join-Path $OutputRoot "web-dashboard") (Join-Path $Destination "dist")
    Prepare-ReleaseResources $Destination

    $GatewayVersion = (Get-Content -Raw (Join-Path $RepoRoot "gateway\package.json") | ConvertFrom-Json).version
    Set-Content -LiteralPath (Join-Path $Destination "gateway-bundle-version.txt") -Value $GatewayVersion -Encoding ASCII

    $DesktopOutput = Join-Path $OutputRoot "desktop"
    $DesktopInstaller = @(Get-ChildItem -LiteralPath $DesktopOutput -File -Filter "*.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    if ($DesktopInstaller.Count -gt 0) {
        Copy-Item -LiteralPath $DesktopInstaller[0].FullName -Destination (Join-Path $Destination "desktop-setup.exe") -Force
    } else {
        Write-Warn "No desktop installer was available to embed in the cloud package."
    }

    @'
node_modules
desktop-setup.exe
'@ | Set-Content -LiteralPath (Join-Path $Destination ".dockerignore") -Encoding ASCII

    Invoke-CheckedCommand $script:NpmCommand @("install", "--omit=dev", "--no-audit", "--no-fund") $Destination "Install cloud production dependencies"
    Remove-BlockedReleaseFiles (Join-Path $Destination "node_modules")
    Invoke-CheckedCommand (Get-Command node).Source @("--check", "server.js") $Destination "Validate cloud entry point"
    Write-Ok "Assemble cloud deployment package"
    Register-Artifact "Cloud deployment" $Destination
}

function Test-AllReleaseResources {
    Test-ReleaseResources (Join-Path $OutputRoot "backend")
    Test-ReleaseResources (Join-Path $OutputRoot "desktop\win-unpacked\resources")
    Test-ReleaseResources (Join-Path $OutputRoot "service-control\win-unpacked\resources")
    Test-ReleaseResources (Join-Path $OutputRoot "cloud")
}

function Write-BuildManifest {
    $Commit = "unknown"
    $Git = Get-Command git -ErrorAction SilentlyContinue
    if ($Git) {
        $Value = & $Git.Source -C $RepoRoot rev-parse --short HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $Value) { $Commit = $Value.Trim() }
        $global:LASTEXITCODE = 0
    }

    $Outputs = @()
    foreach ($Artifact in $script:Artifacts) {
        $Stats = Get-PathStats $Artifact.Path
        $Outputs += [ordered]@{
            name = $Artifact.Name
            path = $Artifact.Path.Substring($RepoRoot.Length).TrimStart('\')
            files = $Stats.Files
            bytes = $Stats.Bytes
        }
    }

    $Manifest = [ordered]@{
        target = $Target
        generatedAt = (Get-Date).ToString("o")
        durationSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 1)
        gitCommit = $Commit
        node = (& node --version)
        npm = (& $script:NpmCommand --version)
        outputs = $Outputs
    }
    $Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputRoot "build-manifest.json") -Encoding UTF8
}

function Write-Summary {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host " Build completed" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    foreach ($Artifact in $script:Artifacts) {
        $Stats = Get-PathStats $Artifact.Path
        $SizeMb = [math]::Round($Stats.Bytes / 1MB, 1)
        $Relative = $Artifact.Path.Substring($RepoRoot.Length).TrimStart('\')
        Write-Host ("  {0,-24} {1,8} MB  {2}" -f $Artifact.Name, $SizeMb, $Relative) -ForegroundColor White
    }
    Write-Host ""
    Write-Host " Output: $OutputRoot" -ForegroundColor Cyan
    Write-Host " Time:   $([math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 1)) seconds" -ForegroundColor DarkGray
    Write-Host ""
}

$ExitCode = 0
try {
    if ($Interactive) {
        $SelectedTarget = Select-BuildTarget
        if ($null -eq $SelectedTarget) { exit 0 }
        $Target = $SelectedTarget

        Write-Host ""
        Write-Warn "Release builds may install missing dependencies and take several minutes."
        $Continue = Read-Host "Continue? [Y/n]"
        if ($Continue -match "^[Nn]") { exit 0 }
    } else {
        Write-Banner
    }

    foreach ($RequiredDirectory in @("web-dashboard", "gateway", "desktop", "service-control-electron", "cloud")) {
        $RequiredPath = Join-Path $RepoRoot $RequiredDirectory
        if (-not (Test-Path -LiteralPath $RequiredPath -PathType Container)) {
            throw "Required project directory not found: $RequiredPath"
        }
    }

    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $NodeCommand) { throw "Node.js was not found. Install Node.js 20 or newer first." }
    $Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $Npm) { $Npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $Npm) { throw "npm was not found. Reinstall Node.js and make sure npm is in PATH." }
    $script:NpmCommand = $Npm.Source

    if ($Target -eq "all") {
        Reset-GeneratedDirectory $OutputRoot
    } else {
        New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    }
    $LogDirectory = Join-Path $RepoRoot "docs\tempFiles\build-logs"
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    $LogPath = Join-Path $LogDirectory ("build-{0}-{1}.log" -f $Target, (Get-Date -Format "yyyyMMdd-HHmmss"))
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Ok "Node.js $(& node --version)"
    Write-Ok "npm $(& $script:NpmCommand --version)"
    Write-Info "Target: $Target"
    Write-Info "Log: $LogPath"

    if ($Target -eq "all" -or $Target -eq "desktop") {
        Test-DesktopReleasePreflight
    }

    switch ($Target) {
        "all" {
            Build-Web
            Build-Backend
            Build-Desktop
            Build-ServiceControl
            Build-Cloud
            Test-AllReleaseResources
        }
        "web" { Build-Web }
        "backend" { Build-Backend }
        "desktop" {
            Build-Web
            Ensure-NodeProject (Join-Path $RepoRoot "gateway") "Gateway"
            Build-Desktop
        }
        "service-control" {
            Build-Web
            Ensure-NodeProject (Join-Path $RepoRoot "gateway") "Gateway"
            Build-ServiceControl
        }
        "cloud" {
            Build-Web
            Build-Cloud
        }
    }

    Write-BuildManifest
    Write-Summary

    if ($Interactive -and -not $NoOpen) {
        $Open = Read-Host "Open the output folder? [Y/n]"
        if ($Open -notmatch "^[Nn]") {
            Start-Process explorer.exe -ArgumentList @($OutputRoot) | Out-Null
        }
    }
} catch {
    $ExitCode = 1
    Write-Host ""
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "The build stopped at the failed step; later modules were not packaged." -ForegroundColor Yellow
    if ($LogPath) {
        Write-Host "Build log: $LogPath" -ForegroundColor Yellow
    }
} finally {
    if ($TranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
}

exit $ExitCode

[CmdletBinding()]
param(
  [switch]$Quick,
  [switch]$SkipBugAgent,
  [switch]$SkipBuild,
  [ValidateSet("gateway", "web")]
  [string]$Only
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodeScript = Join-Path $root "scripts\acceptance.mjs"
$argsList = @()

if ($Quick) { $argsList += "--quick" }
if ($SkipBugAgent) { $argsList += "--skip-bug-agent" }
if ($SkipBuild) { $argsList += "--skip-build" }
if ($Only) { $argsList += @("--only", $Only) }

& node $nodeScript @argsList
exit $LASTEXITCODE

<#
.SYNOPSIS
  Deploys Secure Box to Firebase Hosting (Windows PowerShell 5.1+ or PowerShell 7).

.DESCRIPTION
  Writes public/assets/config.json, builds the app (npm ci, npm run build) and runs
  "firebase deploy --only hosting" to publish dist/ with the security
  headers from firebase.json. Settings are remembered in deploy.settings.json.

  IMPORTANT: keep using the SAME Google OAuth client ID once you have vaults (it is remembered
  in deploy.settings.json), with the Firebase addresses added to it. Google Drive only shows Secure Box the
  files created through that client's Google Cloud project, so a client from another project
  would not see existing vaults. Any Firebase project can host the files; adding Firebase to
  that same Google Cloud project keeps everything in one place.

.EXAMPLE
  .\deploy-firebase.ps1 -Project my-cloud-project-id -GoogleClientId 1234-abc.apps.googleusercontent.com
  First deployment.

.EXAMPLE
  .\deploy-firebase.ps1
  Re-deploys with the remembered settings.

.EXAMPLE
  .\deploy-firebase.ps1 -MicrosoftClientId 00000000-0000-0000-0000-000000000000
  Adds Microsoft sign-in (OneDrive): the Application (client) ID of your Microsoft app registration.
#>
[CmdletBinding()]
param(
  [string]$Project,
  [string]$GoogleClientId,
  [string]$MicrosoftClientId,
  [int]$AutoLockMinutes,
  [int]$SessionHours
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$SettingsPath = Join-Path $Root 'deploy.settings.json'
$ConfigPath = Join-Path $Root 'public\assets\config.json'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Stop-Deploy([string]$Text) {
  Write-Host ''
  Write-Host "ERROR: $Text" -ForegroundColor Red
  exit 1
}

# --- Remembered settings ------------------------------------------------------------
$saved = [ordered]@{}
if (Test-Path $SettingsPath) {
  $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json
  foreach ($property in $json.PSObject.Properties) { $saved[$property.Name] = $property.Value }
}
function Select-Setting($Value, [string]$Name, $Default) {
  if ($Value) { return $Value }
  if ($saved.Contains($Name) -and $saved[$Name]) { return $saved[$Name] }
  return $Default
}

$Project         = Select-Setting $Project 'FirebaseProject' ''
$GoogleClientId  = Select-Setting $GoogleClientId 'GoogleClientId' ''
$MicrosoftClientId = Select-Setting $MicrosoftClientId 'MicrosoftClientId' ''
$AutoLockMinutes = [int](Select-Setting $AutoLockMinutes 'AutoLockMinutes' 10)
$SessionHours    = [int](Select-Setting $SessionHours 'SessionHours' 8)

if (-not $Project) {
  Stop-Deploy "First deployment needs -Project (your Firebase / Google Cloud project ID). Example:`n       .\deploy-firebase.ps1 -Project my-project-id -GoogleClientId 1234-abc.apps.googleusercontent.com"
}
if ($Project -notmatch '^[a-z][a-z0-9-]{4,29}$') { Stop-Deploy "'$Project' does not look like a Firebase project ID." }
if ($GoogleClientId -notmatch '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$') {
  Stop-Deploy "Pass -GoogleClientId with your Google OAuth client ID (NNNN-xxxx.apps.googleusercontent.com)."
}

if ($MicrosoftClientId -and $MicrosoftClientId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
  Stop-Deploy 'Pass -MicrosoftClientId with the Application (client) ID of your Microsoft app registration (a GUID).'
}

$firebase = Get-Command firebase.cmd -ErrorAction SilentlyContinue
if (-not $firebase) { $firebase = Get-Command firebase -ErrorAction SilentlyContinue }
if (-not $firebase) {
  Stop-Deploy ("The Firebase CLI is not installed. Install it and sign in once:`n" +
    "         npm install -g firebase-tools`n" +
    "         firebase login")
}

# --- Config + deploy -----------------------------------------------------------------
$saved['FirebaseProject'] = $Project
$saved['GoogleClientId'] = $GoogleClientId
if ($MicrosoftClientId) { $saved['MicrosoftClientId'] = $MicrosoftClientId }
$saved['AutoLockMinutes'] = $AutoLockMinutes
$saved['SessionHours'] = $SessionHours
[System.IO.File]::WriteAllText($SettingsPath, ($saved | ConvertTo-Json) + "`n", $Utf8NoBom)

Write-Step 'Writing public/assets/config.json'
$config = [ordered]@{ googleClientId = $GoogleClientId }
if ($MicrosoftClientId) { $config['microsoftClientId'] = $MicrosoftClientId }
$config['autoLockMinutes'] = $AutoLockMinutes
$config['sessionHours'] = $SessionHours
[System.IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json) + "`n", $Utf8NoBom)

# --- Build: exactly the locked dependencies, no install scripts, then the build check ----------
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) { Stop-Deploy 'Node.js (with npm) is needed to build Secure Box: install Node.js 22 or newer, then run this again.' }
Push-Location $Root
try {
  Write-Step 'Installing the locked dependencies (npm ci)'
  & $npm.Source ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "npm ci failed (exit code $LASTEXITCODE)." }
  Write-Step 'Building (vite build, then the build check)'
  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "The build or its check failed (exit code $LASTEXITCODE): nothing was deployed." }
} finally {
  Pop-Location
}

Write-Step "Deploying dist/ to Firebase Hosting (project $Project)"
Push-Location $Root
try {
  & $firebase.Source deploy --only hosting --project $Project --non-interactive
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($code -ne 0) {
  Stop-Deploy ("firebase deploy failed (exit code $code). If it says you are not signed in, run 'firebase.cmd login'.`n" +
    "       If it says the site does not exist, open Hosting in the Firebase console, click Get started once, and try again.")
}

# --- Hosting site name (it is often, but not always, the project ID) -------------------
function Get-HostingSite {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $firebase.Source hosting:sites:list --project $Project --json --non-interactive 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $sites = @((($raw -join "`n") | ConvertFrom-Json).result.sites)
    $site = @($sites | Where-Object { $_.type -eq 'DEFAULT_SITE' }) + $sites | Select-Object -First 1
    if ($site) { return ($site.name -split '/')[-1] }
    return $null
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $previous
  }
}
$Site = Get-HostingSite
if (-not $Site) {
  $Site = $Project
  Write-Host "  (Could not look up the Hosting site name; assuming '$Site'. Firebase printed the exact Hosting URL above.)" -ForegroundColor Yellow
}

# --- Summary ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Secure Box is deployed to Firebase Hosting.' -ForegroundColor Green
Write-Host ''
Write-Host "  App URL:  https://$Site.web.app/   (also https://$Site.firebaseapp.com/)" -ForegroundColor White
Write-Host ''
Write-Host '  Add these to the Google OAuth client you already use (Google Auth Platform > Clients):'
Write-Host "    Client ID:                      $GoogleClientId"
Write-Host "    Authorized JavaScript origins:  https://$Site.web.app   and   https://$Site.firebaseapp.com"
Write-Host "    Authorized redirect URIs:       https://$Site.web.app/index.html   and   https://$Site.firebaseapp.com/index.html"
Write-Host '    (If the console asks you to add the domain to the authorized domains list first, add'
Write-Host "     $Site.web.app and $Site.firebaseapp.com under Google Auth Platform > Branding.)"
Write-Host ''
Write-Host '  Your data stays where it is: in each person''s Google Drive or OneDrive, or on their device.'
Write-Host '  Use one address consistently: each address keeps its own settings and device vault in the browser.'
Write-Host ''

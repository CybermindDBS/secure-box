<#
.SYNOPSIS
  Deploys Secure Box to Firebase Hosting (Windows PowerShell 5.1+ or PowerShell 7).

.DESCRIPTION
  Writes public/assets/config.json, builds the app (npm ci, npm run build) and runs
  "firebase deploy --only hosting" to publish dist/ with the security
  headers from firebase.json. Settings are remembered in deploy.settings.json.

  IMPORTANT: keep using the SAME Google Cloud project and the SAME Microsoft app registration once
  people have vaults (both are remembered in deploy.settings.json). Google Drive shows Secure Box
  only the files its own Google Cloud project made, and OneDrive only its app registration's
  folder, so switching either hides every vault already made (nothing is deleted). A new OAuth
  client in the same Google project is fine. This script refuses a switch unless you pass
  -NewCloudApps. Any Firebase project can host the files; adding Firebase to that same Google
  Cloud project keeps everything in one place.

.EXAMPLE
  .\deploy-firebase.ps1 -Project my-cloud-project-id -GoogleClientId 1234-abc.apps.googleusercontent.com
  First deployment.

.EXAMPLE
  .\deploy-firebase.ps1
  Re-deploys with the remembered settings.

.EXAMPLE
  .\deploy-firebase.ps1 -MicrosoftClientId 00000000-0000-0000-0000-000000000000
  Adds Microsoft sign-in (OneDrive): the Application (client) ID of your Microsoft app registration.

.EXAMPLE
  .\deploy-firebase.ps1 -GoogleClientId 5678-xyz.apps.googleusercontent.com -NewCloudApps
  Switches on purpose to a client in another Google Cloud project (or -MicrosoftClientId to another
  app registration). Keep the old one working: it becomes Secure Box's previous connection, and
  Secure Box offers to bring each vault over from it.

.EXAMPLE
  .\deploy-firebase.ps1 -ForgetPreviousCloudApps
  Ends that, once everyone's vault has been brought over.

.EXAMPLE
  .\deploy-firebase.ps1 -AndroidPackage io.github.example.securebox -AndroidFingerprint AB:CD:...:EF
  Lets the site vouch for the Android app (android\build-android.ps1 prints this line): it publishes
  /.well-known/assetlinks.json, so Chrome opens the app full screen without an address bar. Run it
  again with -AndroidFingerprint for Google Play's app signing key; each fingerprint is remembered.
#>
[CmdletBinding()]
param(
  [string]$Project,
  [string]$GoogleClientId,
  [string]$MicrosoftClientId,
  [int]$AutoLockMinutes,
  [int]$SessionHours,
  [string]$AndroidPackage,
  [string[]]$AndroidFingerprint,
  [switch]$NewCloudApps,
  [switch]$ForgetPreviousCloudApps
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$SettingsPath = Join-Path $Root 'deploy.settings.json'
$ConfigPath = Join-Path $Root 'public\assets\config.json'
$AssetLinksPath = Join-Path $Root 'public\.well-known\assetlinks.json'
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

# --- The Android app the site vouches for (/.well-known/assetlinks.json) ----------------------
# Its package name, and the SHA-256 fingerprints of the keys it's signed with: your upload key,
# and Google Play's app signing key. Fingerprints given are added to the remembered ones.
$AndroidPackage = Select-Setting $AndroidPackage 'AndroidPackage' ''
if ($AndroidPackage -and $AndroidPackage -notmatch '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$') {
  Stop-Deploy "'$AndroidPackage' is not an Android package name (like io.github.example.securebox)."
}
$fingerprints = @()
if ($saved.Contains('AndroidFingerprints') -and $saved['AndroidFingerprints']) { $fingerprints += @($saved['AndroidFingerprints'] | ForEach-Object { [string]$_ }) }
foreach ($given in @($AndroidFingerprint | Where-Object { $_ })) {
  $text = ($given -replace '\s', '').ToUpperInvariant()
  if ($text -match '^[0-9A-F]{64}$') { $text = ($text -split '(..)' | Where-Object { $_ }) -join ':' }
  if ($text -notmatch '^([0-9A-F]{2}:){31}[0-9A-F]{2}$') {
    Stop-Deploy "'$given' is not a SHA-256 certificate fingerprint (32 pairs of hex digits, like AB:CD:...)."
  }
  if ($fingerprints -notcontains $text) { $fingerprints += $text }
}
if ($fingerprints.Count -and -not $AndroidPackage) { Stop-Deploy 'Pass -AndroidPackage too: the package name of the Android app those keys sign.' }

# --- Guard: the Google project and the Microsoft app decide what Secure Box can see ----------
# Google Drive shows Secure Box only the files its own Google Cloud project made (the number a
# client ID starts with), and OneDrive only its app registration's folder. Switching either hides
# every vault people already have there, though nothing is deleted. Switching on purpose keeps the
# old one as Secure Box's previous connection, from which it brings each vault over.
function Get-ProjectNumber([string]$Id) { return ($Id -split '-')[0] }
$oldGoogle = if ($saved.Contains('GoogleClientId')) { [string]$saved['GoogleClientId'] } else { '' }
$oldMicrosoft = if ($saved.Contains('MicrosoftClientId')) { [string]$saved['MicrosoftClientId'] } else { '' }
$googleSwitch = [bool]($oldGoogle -and ((Get-ProjectNumber $oldGoogle) -ne (Get-ProjectNumber $GoogleClientId)))
$microsoftSwitch = [bool]($oldMicrosoft -and $MicrosoftClientId -and ($oldMicrosoft -ne $MicrosoftClientId))
if (($googleSwitch -or $microsoftSwitch) -and -not $NewCloudApps) {
  $why = @()
  if ($googleSwitch) {
    $why += "-GoogleClientId is in another Google Cloud project ($(Get-ProjectNumber $GoogleClientId)) than the one this site uses ($(Get-ProjectNumber $oldGoogle)).`n       Google Drive shows Secure Box only the files its own project made."
  }
  if ($microsoftSwitch) {
    $why += "-MicrosoftClientId is another Microsoft app registration than the one this site uses ($oldMicrosoft).`n       OneDrive gives each app registration a folder of its own."
  }
  Stop-Deploy (($why -join "`n       ") +
    "`n       Every vault people already have there would look gone to Secure Box, though nothing is deleted." +
    "`n       Keep the one in use (a new OAuth client in the same Google project is fine). To switch on purpose," +
    "`n       keep the old one working and run this again with -NewCloudApps: Secure Box then offers to bring" +
    "`n       each vault over from it.")
}
if ($googleSwitch) { $saved['PreviousGoogleClientId'] = $oldGoogle }
if ($microsoftSwitch) { $saved['PreviousMicrosoftClientId'] = $oldMicrosoft }
if ($ForgetPreviousCloudApps) {
  $saved.Remove('PreviousGoogleClientId')
  $saved.Remove('PreviousMicrosoftClientId')
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
if ($AndroidPackage) { $saved['AndroidPackage'] = $AndroidPackage }
if ($fingerprints.Count) { $saved['AndroidFingerprints'] = @($fingerprints) }
[System.IO.File]::WriteAllText($SettingsPath, ($saved | ConvertTo-Json) + "`n", $Utf8NoBom)

Write-Step 'Writing public/assets/config.json'
$config = [ordered]@{ googleClientId = $GoogleClientId }
if ($MicrosoftClientId) { $config['microsoftClientId'] = $MicrosoftClientId }
# Secure Box's previous connections, while vaults are brought over from them (see the guard above).
if ($saved.Contains('PreviousGoogleClientId') -and $saved['PreviousGoogleClientId']) { $config['previousGoogleClientId'] = [string]$saved['PreviousGoogleClientId'] }
if ($saved.Contains('PreviousMicrosoftClientId') -and $saved['PreviousMicrosoftClientId']) { $config['previousMicrosoftClientId'] = [string]$saved['PreviousMicrosoftClientId'] }
$config['autoLockMinutes'] = $AutoLockMinutes
$config['sessionHours'] = $SessionHours
[System.IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json) + "`n", $Utf8NoBom)

# The Android app's Digital Asset Links: Chrome opens it full screen only for an app this lists.
if ($AndroidPackage -and $fingerprints.Count) {
  Write-Step 'Writing public/.well-known/assetlinks.json (the Android app)'
  $links = @(
    [ordered]@{
      relation = @('delegate_permission/common.handle_all_urls')
      target   = [ordered]@{ namespace = 'android_app'; package_name = $AndroidPackage; sha256_cert_fingerprints = @($fingerprints) }
    }
  )
  New-Item -ItemType Directory -Force -Path (Split-Path $AssetLinksPath) | Out-Null
  [System.IO.File]::WriteAllText($AssetLinksPath, (ConvertTo-Json -InputObject $links -Depth 5) + "`n", $Utf8NoBom)
} elseif (Test-Path $AssetLinksPath) {
  Remove-Item $AssetLinksPath
}

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

# --- The Android app: is the live assetlinks.json the one just written? ------------------------
if ($AndroidPackage -and $fingerprints.Count) {
  $url = "https://$Site.web.app/.well-known/assetlinks.json"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $live = Invoke-RestMethod -Uri $url -Headers @{ 'Cache-Control' = 'no-cache' } -UseBasicParsing
    $statements = @($live | ForEach-Object { $_ }) # Windows PowerShell hands a JSON array over as one object
    $target = @($statements | Where-Object { $_.target -and $_.target.package_name -eq $AndroidPackage } | ForEach-Object { $_.target })
    $listed = @($target | ForEach-Object { @($_.sha256_cert_fingerprints) })
    $missing = @($fingerprints | Where-Object { $listed -notcontains $_ })
    if ($target.Count -and -not $missing.Count) {
      Write-Host "  Android app $AndroidPackage`: the site vouches for it ($($fingerprints.Count) signing key$(if ($fingerprints.Count -ne 1) { 's' }))." -ForegroundColor White
    } else {
      Write-Host "  WARNING: $url doesn't list the Android app as just written. Check it in a browser." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  WARNING: couldn't read $url ($($_.Exception.Message))." -ForegroundColor Yellow
  }
  Write-Host ''
}

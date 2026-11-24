<#
.SYNOPSIS
  Builds the Secure Box Android app for Google Play (Windows PowerShell 5.1+ or PowerShell 7).

.DESCRIPTION
  The Android app is Secure Box's website in a Trusted Web Activity: Chrome opens the site full
  screen, so every deploy of the website updates the app too. This builds what Google Play takes
  (an .aab) and an .apk to install on a phone yourself, both signed with your upload key.

  The first run makes the upload key and asks you for its password. Keep the key and the password
  safe and backed up, outside this repository: Google Play needs that key for every update of the
  app (Play signs the app it delivers with a key of its own, so a lost upload key can be reset).

  Needs Java 17 or 21 (a JDK) and the Android SDK (Android Studio installs it). The first build
  downloads Gradle and the Android build libraries.

.EXAMPLE
  .\android\build-android.ps1
  Builds with the upload key in %USERPROFILE%\.secure-box\upload.keystore, and makes it first if
  it isn't there.

.EXAMPLE
  .\android\build-android.ps1 -Keystore D:\keys\secure-box-upload.keystore
  Uses (or makes) the upload key somewhere else.

.EXAMPLE
  .\android\build-android.ps1 -CheckPassword
  Builds nothing: you type passwords, one at a time, and it says whether each one opens your
  upload key. For when you're not sure which password you chose.
#>
[CmdletBinding()]
param(
  [string]$Keystore = (Join-Path $env:USERPROFILE '.secure-box\upload.keystore'),
  [string]$KeyAlias = 'upload',
  [switch]$CheckPassword
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$Gradle = Join-Path $Root 'app\build.gradle'

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Stop-Build([string]$Text) {
  Write-Host ''
  Write-Host "ERROR: $Text" -ForegroundColor Red
  exit 1
}
function Read-Secret([string]$Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# --- Java 17 or 21: the Android build tools this app uses don't run on newer ones -------------
function Get-JavaMajor([string]$JavaHome) {
  $release = Join-Path $JavaHome 'release'
  if (-not (Test-Path $release)) { return 0 }
  $found = Select-String -Path $release -Pattern '^JAVA_VERSION="(\d+)' | Select-Object -First 1
  if ($found) { return [int]$found.Matches[0].Groups[1].Value }
  return 0
}
$javaHomes = @()
if ($env:JAVA_HOME) { $javaHomes += $env:JAVA_HOME }
foreach ($base in @('Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Android\Android Studio')) {
  $folder = Join-Path $env:ProgramFiles $base
  if (Test-Path $folder) { $javaHomes += @(Get-ChildItem $folder -Directory | ForEach-Object { $_.FullName }) }
}
$jdk = $javaHomes |
  Where-Object { (Test-Path (Join-Path $_ 'bin\keytool.exe')) -and (@(17, 21) -contains (Get-JavaMajor $_)) } |
  Sort-Object { Get-JavaMajor $_ } -Descending |
  Select-Object -First 1
if (-not $jdk) { Stop-Build 'Java 17 or 21 (a JDK) is needed: install Eclipse Temurin 21 from adoptium.net, then run this again.' }
$keytool = Join-Path $jdk 'bin\keytool.exe'

# --- -CheckPassword: which password opens the upload key? Nothing is built. -----------------------
if ($CheckPassword) {
  if (-not (Test-Path $Keystore)) { Stop-Build "There's no upload key at $Keystore." }
  Write-Step "Trying passwords on your upload key: $Keystore"
  Write-Host '  Type a password and press Enter (it shows as asterisks). Press Enter alone to stop.'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue' # keytool's "password was incorrect" is an answer, not a failure
  $found = $false
  try {
    while (-not $found) {
      $env:SECURE_BOX_PASSWORD_TRY = Read-Secret '  Password'
      if (-not $env:SECURE_BOX_PASSWORD_TRY) { break }
      & $keytool -list -keystore $Keystore -storepass:env SECURE_BOX_PASSWORD_TRY 2>&1 | Out-Null
      $found = $LASTEXITCODE -eq 0
      if ($found) { Write-Host '  Yes, that one opens your upload key. Save it in your password manager now.' -ForegroundColor Green }
      else { Write-Host '  No, not that one.' -ForegroundColor Yellow }
    }
  } finally {
    Remove-Item Env:SECURE_BOX_PASSWORD_TRY -ErrorAction SilentlyContinue
    $ErrorActionPreference = $previous
  }
  if ($found) { exit 0 }
  exit 1
}

# --- The Android SDK ----------------------------------------------------------------------------
$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) |
  Where-Object { $_ -and (Test-Path (Join-Path $_ 'platform-tools')) } |
  Select-Object -First 1
if (-not $sdk) { Stop-Build 'The Android SDK is needed: install Android Studio and open it once (it sets up the SDK), then run this again.' }

# --- The upload key ------------------------------------------------------------------------------
# The password reaches keytool and Gradle in an environment variable of this run only, never on a
# command line or in a file. A password already set there (a build server) is used as it is.
$ownPassword = -not $env:SECURE_BOX_KEYSTORE_PASSWORD
$previousJavaHome = $env:JAVA_HOME
$previousAndroidHome = $env:ANDROID_HOME
function Clear-BuildEnvironment {
  if ($ownPassword) { Remove-Item Env:SECURE_BOX_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue }
  Remove-Item Env:SECURE_BOX_KEYSTORE, Env:SECURE_BOX_KEY_ALIAS -ErrorAction SilentlyContinue
  $env:JAVA_HOME = $previousJavaHome
  $env:ANDROID_HOME = $previousAndroidHome
}

try {
  if (Test-Path $Keystore) {
    Write-Step "Signing with your upload key: $Keystore"
    if ($ownPassword) { $env:SECURE_BOX_KEYSTORE_PASSWORD = Read-Secret '  Its password' }
  } else {
    Write-Step "Making your upload key: $Keystore"
    Write-Host '  Choose a password for it, and keep the key and the password safe and backed up:'
    Write-Host '  Google Play needs this key for every update of the app.'
    if ($ownPassword) {
      $password = Read-Secret '  New password (at least 6 characters)'
      if ($password.Length -lt 6) { Stop-Build 'The password needs at least 6 characters. Nothing was made.' }
      if ((Read-Secret '  The same password again') -cne $password) { Stop-Build 'The two passwords differ. Nothing was made.' }
      $env:SECURE_BOX_KEYSTORE_PASSWORD = $password
      $password = $null
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $Keystore) | Out-Null
    & $keytool -genkeypair -keystore $Keystore -storetype PKCS12 -alias $KeyAlias -keyalg RSA -keysize 2048 -validity 10000 `
      -dname 'CN=Secure Box' -storepass:env SECURE_BOX_KEYSTORE_PASSWORD -keypass:env SECURE_BOX_KEYSTORE_PASSWORD
    if ($LASTEXITCODE -ne 0) { Stop-Build "keytool couldn't make the upload key (exit code $LASTEXITCODE)." }
    Write-Host "  Made. Back up $Keystore now, with its password." -ForegroundColor Yellow
  }

  # The key's fingerprint, which the website publishes so Chrome trusts the app. It also proves the
  # password right before the build starts.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $listing = & $keytool -list -v -keystore $Keystore -alias $KeyAlias -storepass:env SECURE_BOX_KEYSTORE_PASSWORD 2>&1
  $listed = $LASTEXITCODE
  $ErrorActionPreference = $previous
  $match = [regex]::Match(($listing | Out-String), 'SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})')
  if ($listed -ne 0 -or -not $match.Success) {
    Stop-Build "That password doesn't open $Keystore, or it has no key named '$KeyAlias'."
  }
  $fingerprint = $match.Groups[1].Value

  # --- Build ----------------------------------------------------------------------------------
  Write-Step "Building the app (Java $(Get-JavaMajor $jdk), Android SDK in $sdk)"
  $env:JAVA_HOME = $jdk
  $env:ANDROID_HOME = $sdk
  $env:SECURE_BOX_KEYSTORE = (Resolve-Path $Keystore).Path
  $env:SECURE_BOX_KEY_ALIAS = $KeyAlias
  Push-Location $Root
  try {
    # No Gradle daemon: nothing keeps running afterwards with the password in its environment.
    & .\gradlew.bat --no-daemon --console=plain clean bundleRelease assembleRelease
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Stop-Build "The Android build failed (exit code $code)." }
} finally {
  Clear-BuildEnvironment
}

# --- What was made, and what's next -----------------------------------------------------------------
$package = (Select-String -Path $Gradle -Pattern "applicationId: '([^']+)'").Matches[0].Groups[1].Value
$version = (Select-String -Path $Gradle -Pattern 'versionName "([^"]+)"').Matches[0].Groups[1].Value
$versionCode = (Select-String -Path $Gradle -Pattern 'versionCode (\d+)').Matches[0].Groups[1].Value
$out = Join-Path $Root 'release'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$aab = Join-Path $out "secure-box-$version.aab"
$apk = Join-Path $out "secure-box-$version.apk"
Copy-Item (Join-Path $Root 'app\build\outputs\bundle\release\app-release.aab') $aab -Force
Copy-Item (Join-Path $Root 'app\build\outputs\apk\release\app-release.apk') $apk -Force

Write-Host ''
Write-Host "Secure Box for Android $version (version code $versionCode) is built and signed." -ForegroundColor Green
Write-Host ''
Write-Host "  For Google Play:        $aab"
Write-Host "  To install on a phone:  $apk"
Write-Host "  App (package name):     $package"
Write-Host "  Upload key SHA-256:     $fingerprint"
Write-Host ''
Write-Host '  Next:'
Write-Host '  1. Let the website vouch for the app, so it opens full screen without an address bar:'
Write-Host "       .\deploy-firebase.ps1 -AndroidPackage $package -AndroidFingerprint $fingerprint"
Write-Host '  2. Upload the .aab in Play Console. Google Play then signs the app with its own key: in'
Write-Host '     Play Console, open App integrity, copy the SHA-256 fingerprint of the app signing key'
Write-Host '     certificate, and add it the same way:'
Write-Host '       .\deploy-firebase.ps1 -AndroidFingerprint <that SHA-256>'
Write-Host '  Each new upload to Google Play needs a higher versionCode (android\app\build.gradle).'
Write-Host ''

<#
.SYNOPSIS
  Deploys Secure Box to an S3 bucket in your AWS account (Windows PowerShell 5.1+ or PowerShell 7).

.DESCRIPTION
  Secure Box is only static files. No user data ever touches AWS: every person's vault, key ring
  and files are encrypted in the browser and kept in their own Google Drive.

  1. Creates or updates the CloudFormation stack in infra/template.yaml (one S3 bucket and its
     bucket policy - or your existing bucket).
  2. Writes app/assets/config.json (your Google OAuth client ID and lock settings).
  3. Uploads the app with correct content types.
  Settings are remembered in deploy.settings.json, so later runs need no arguments.

.EXAMPLE
  .\deploy.ps1 -Bucket my-unibox -GoogleClientId 1234-abc.apps.googleusercontent.com -Region us-east-1
  First deployment.

.EXAMPLE
  .\deploy.ps1
  Re-deploys with the remembered settings (for example after changing the app).
#>
[CmdletBinding()]
param(
  [string]$Bucket,
  [string]$GoogleClientId,
  [string]$Region,
  [string]$StackName,
  [string]$AwsProfile,
  [int]$AutoLockMinutes,
  [int]$SessionHours
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''

$Root = $PSScriptRoot
$SettingsPath = Join-Path $Root 'deploy.settings.json'
$TemplatePath = Join-Path $Root 'infra\template.yaml'
$AppDir = Join-Path $Root 'app'
$AssetsDir = Join-Path $AppDir 'assets'
$ConfigPath = Join-Path $AssetsDir 'config.json'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor DarkGray }
function Stop-Deploy([string]$Text) {
  Write-Host ''
  Write-Host "ERROR: $Text" -ForegroundColor Red
  exit 1
}

# --- Remembered settings ------------------------------------------------------------
$saved = @{}
if (Test-Path $SettingsPath) {
  $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json
  foreach ($property in $json.PSObject.Properties) { $saved[$property.Name] = $property.Value }
}
function Select-Setting($Value, [string]$Name, $Default) {
  if ($Value) { return $Value }
  if ($saved.ContainsKey($Name) -and $saved[$Name]) { return $saved[$Name] }
  return $Default
}

$StackName       = Select-Setting $StackName 'StackName' 'unibox'
$AwsProfile      = Select-Setting $AwsProfile 'AwsProfile' ''
$Bucket          = Select-Setting $Bucket 'Bucket' ''
$GoogleClientId  = Select-Setting $GoogleClientId 'GoogleClientId' ''
$AutoLockMinutes = [int](Select-Setting $AutoLockMinutes 'AutoLockMinutes' 10)
$SessionHours    = [int](Select-Setting $SessionHours 'SessionHours' 8)

# Buckets in your account regional namespace carry their account and region in the name:
#   <prefix>-<12-digit account id>-<region>-an   e.g. unibox-123456789012-ap-southeast-1-an
$AccountRegionalPattern = '-(\d{12})-([a-z]{2,4}(?:-[a-z]+)+-\d+)-an$'
$NameAccount = ''
$NameRegion = ''
if ($Bucket -match $AccountRegionalPattern) {
  $NameAccount = $Matches[1]
  $NameRegion = $Matches[2]
}
$Region = Select-Setting $Region 'Region' $NameRegion
$AdoptBucket = $false

# --- AWS CLI helpers ----------------------------------------------------------------
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  Stop-Deploy 'The AWS CLI is not installed. Get it from https://aws.amazon.com/cli/ and run this script again.'
}
$ProfileArgs = @()
if ($AwsProfile) { $ProfileArgs = @('--profile', $AwsProfile) }
if (-not $Region) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $configured = (& aws configure get region @ProfileArgs 2>$null | Out-String).Trim()
  $ErrorActionPreference = $previous
  $Region = if ($configured) { $configured } else { 'us-east-1' }
}
if ($NameRegion -and $Region -ne $NameRegion) {
  Stop-Deploy "Bucket '$Bucket' lives in $NameRegion (it is part of its name), but the region is set to $Region. Run again with -Region $NameRegion."
}
$AwsArgs = @('--region', $Region) + $ProfileArgs

function Invoke-Aws([string[]]$Arguments) {
  # Runs the AWS CLI with live output and stops the deployment if it fails.
  & aws @Arguments @AwsArgs
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "'aws $($Arguments[0]) $($Arguments[1])' failed (exit code $LASTEXITCODE)." }
}

function Get-AwsJson([string[]]$Arguments) {
  # Runs the AWS CLI and returns parsed JSON (an empty object if it printed nothing), or $null on failure.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & aws @Arguments @AwsArgs --output json 2>$null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { return $null }
  $text = ($output | Out-String).Trim()
  if (-not $text) { return [pscustomobject]@{} }
  return $text | ConvertFrom-Json
}

# --- Preflight ----------------------------------------------------------------------
Write-Step "Checking AWS access ($Region)"
$identity = Get-AwsJson @('sts', 'get-caller-identity')
if (-not $identity) {
  Stop-Deploy "The AWS CLI is not signed in. Run 'aws login' (or 'aws sso login' / 'aws configure'), then run this script again."
}
Write-Note "Account $($identity.Account) as $($identity.Arn)"
if ($NameAccount -and $NameAccount -ne $identity.Account) {
  Stop-Deploy "Bucket '$Bucket' belongs to AWS account $NameAccount, but the AWS CLI is signed in to account $($identity.Account)."
}

$stack = $null
$described = Get-AwsJson @('cloudformation', 'describe-stacks', '--stack-name', $StackName)
if ($described -and $described.PSObject.Properties['Stacks']) { $stack = $described.Stacks[0] }
if ($stack -and $stack.StackStatus -eq 'ROLLBACK_COMPLETE') {
  Write-Step "Removing the failed first attempt of stack '$StackName'"
  Invoke-Aws @('cloudformation', 'delete-stack', '--stack-name', $StackName)
  Invoke-Aws @('cloudformation', 'wait', 'stack-delete-complete', '--stack-name', $StackName)
  $stack = $null
}
if ($stack -and $stack.StackStatus -like '*_IN_PROGRESS') {
  Stop-Deploy "Stack '$StackName' is busy ($($stack.StackStatus)). Wait a minute and try again."
}

if ($stack) {
  $current = @{}
  foreach ($p in $stack.Parameters) { $current[$p.ParameterKey] = $p.ParameterValue }
  if ($Bucket -and $Bucket -ne $current['BucketName']) {
    Stop-Deploy "Stack '$StackName' already uses bucket '$($current['BucketName'])'. Use -StackName for a separate deployment."
  }
  $Bucket = $current['BucketName']
  if (-not $GoogleClientId -and $current.ContainsKey('GoogleClientId')) { $GoogleClientId = $current['GoogleClientId'] }
  $AdoptBucket = $current.ContainsKey('CreateBucket') -and $current['CreateBucket'] -eq 'false'
} else {
  if (-not $Bucket -or -not $GoogleClientId) {
    Stop-Deploy "First deployment needs -Bucket and -GoogleClientId. Example:`n       .\deploy.ps1 -Bucket my-unibox -GoogleClientId 1234-abc.apps.googleusercontent.com -Region $Region"
  }
  # Already created the bucket yourself? Use it; otherwise the stack creates it.
  $head = Get-AwsJson @('s3api', 'head-bucket', '--bucket', $Bucket, '--expected-bucket-owner', $identity.Account)
  if ($head) {
    $AdoptBucket = $true
    $bucketRegion = ''
    if ($head.PSObject.Properties['BucketRegion']) { $bucketRegion = [string]$head.BucketRegion }
    if ($bucketRegion -and $bucketRegion -ne $Region) { Stop-Deploy "Bucket '$Bucket' is in $bucketRegion. Run again with -Region $bucketRegion." }
    Write-Note "Found your existing bucket '$Bucket'; Secure Box will use it."
  }
  $blocked = Get-AwsJson @('s3control', 'get-public-access-block', '--account-id', $identity.Account)
  if ($blocked -and $blocked.PSObject.Properties['PublicAccessBlockConfiguration'] -and
      ($blocked.PublicAccessBlockConfiguration.BlockPublicPolicy -or $blocked.PublicAccessBlockConfiguration.RestrictPublicBuckets)) {
    Stop-Deploy ("Your AWS account blocks public bucket policies (S3 > 'Block Public Access settings for this account').`n" +
      "       Secure Box serves its web page straight from S3, so the two 'bucket policies' options must be off at account level.`n" +
      "       Only index.html, sw.js and assets/* become public.")
  }
}

if ($Bucket -notmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') {
  Stop-Deploy "Bucket name '$Bucket' is invalid: use 3-63 lowercase letters, digits or hyphens (no dots)."
}
if ($GoogleClientId -notmatch '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$') {
  Stop-Deploy "'$GoogleClientId' does not look like a Google OAuth client ID (NNNN-xxxx.apps.googleusercontent.com)."
}

# --- Infrastructure -----------------------------------------------------------------
if ($AdoptBucket) {
  Write-Step "Allowing the bucket policy on '$Bucket'"
  # Only the two bucket-policy switches are relaxed, so the policy can make the app files public.
  Invoke-Aws @('s3api', 'put-public-access-block', '--bucket', $Bucket, '--expected-bucket-owner', $identity.Account,
    '--public-access-block-configuration', 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false')
}

Write-Step "Deploying CloudFormation stack '$StackName'"
$overrides = @("BucketName=$Bucket")
if (-not $stack) {
  $overrides += "CreateBucket=$(if ($AdoptBucket) { 'false' } else { 'true' })"
  $overrides += "BucketNamespace=$(if ($NameAccount) { 'account-regional' } else { 'global' })"
}
# (CAPABILITY_NAMED_IAM lets stacks from older Secure Box versions remove their IAM role.)
Invoke-Aws (@('cloudformation', 'deploy', '--stack-name', $StackName, '--template-file', $TemplatePath,
    '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--parameter-overrides') + $overrides)

# Keep settings that belong to deploy-firebase.ps1 (e.g. FirebaseProject).
$saved['StackName'] = $StackName
$saved['Region'] = $Region
$saved['AwsProfile'] = $AwsProfile
$saved['Bucket'] = $Bucket
$saved['GoogleClientId'] = $GoogleClientId
$saved['AutoLockMinutes'] = $AutoLockMinutes
$saved['SessionHours'] = $SessionHours
$saved.Remove('CorsOrigins')
[System.IO.File]::WriteAllText($SettingsPath, ($saved | ConvertTo-Json) + "`n", $Utf8NoBom)

$outputs = @{}
foreach ($o in (Get-AwsJson @('cloudformation', 'describe-stacks', '--stack-name', $StackName)).Stacks[0].Outputs) {
  $outputs[$o.OutputKey] = $o.OutputValue
}

# --- App config + upload ------------------------------------------------------------
Write-Step 'Writing app/assets/config.json'
$config = [ordered]@{
  googleClientId  = $GoogleClientId
  autoLockMinutes = $AutoLockMinutes
  sessionHours    = $SessionHours
}
[System.IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json) + "`n", $Utf8NoBom)

Write-Step "Uploading the app to s3://$Bucket"
# Explicit content types: Windows can map .js to text/plain, which breaks ES modules.
Invoke-Aws @('s3', 'cp', (Join-Path $AppDir 'index.html'), "s3://$Bucket/index.html", '--content-type', 'text/html; charset=utf-8', '--cache-control', 'no-cache', '--only-show-errors')
Invoke-Aws @('s3', 'cp', (Join-Path $AppDir 'sw.js'), "s3://$Bucket/sw.js", '--content-type', 'text/javascript; charset=utf-8', '--cache-control', 'no-cache', '--only-show-errors')
$types = [ordered]@{
  '*.js'   = 'text/javascript; charset=utf-8'
  '*.css'  = 'text/css; charset=utf-8'
  '*.json' = 'application/json; charset=utf-8'
  '*.svg'  = 'image/svg+xml'
  '*.png'  = 'image/png'
}
foreach ($pattern in $types.Keys) {
  Invoke-Aws @('s3', 'cp', $AssetsDir, "s3://$Bucket/assets/", '--recursive', '--exclude', '*', '--include', $pattern,
    '--content-type', $types[$pattern], '--cache-control', 'no-cache', '--only-show-errors')
}

# --- Summary ------------------------------------------------------------------------
$appUrl = $outputs['AppUrl']
Write-Host ''
Write-Host 'Secure Box is deployed.' -ForegroundColor Green
Write-Host ''
Write-Host "  App URL:  $appUrl" -ForegroundColor White
Write-Host ''
Write-Host '  Your Google OAuth client (console.cloud.google.com > Google Auth Platform > Clients) must list:'
Write-Host "    Authorized JavaScript origin:  $($outputs['AppOrigin'])"
Write-Host "    Authorized redirect URI:       $appUrl"
Write-Host ''
Write-Host '  Who can use it is decided in Google Auth Platform > Audience: while the app is in'
Write-Host '  "Testing", only the test users you list can sign in; publish it to let anyone in.'
Write-Host '  Each person gets their own vault, key ring and files in their own Google Drive.'
Write-Host ''

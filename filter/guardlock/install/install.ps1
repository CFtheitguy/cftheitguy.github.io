<#
.SYNOPSIS
  Provisions a Windows machine so Edge, Chrome and Firefox come up filtered and
  PIN-locked, with no clicking. Safe to re-run.

.EXAMPLE
  & ([scriptblock]::Create((irm https://www.linearit.co/filter/guardlock/install/install.ps1))) -Pin 4821

  Or, saved to disk and run from an elevated PowerShell:
    .\install.ps1 -Pin 4821 -Categories adult,gambling,social

.EXAMPLE
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]   $Pin,
  [string[]] $Categories = @('adult', 'gambling'),
  [string[]] $Allow      = @(),
  [string[]] $Block      = @(),
  [string[]] $Lists      = @(),
  [int]      $Relock     = 5,
  [int]      $Sensitivity = 12,
  [string]   $ExtId,
  [string]   $ExtUpdate,
  [string]   $Xpi,
  [string]   $BaseUrl    = 'https://www.linearit.co/filter/guardlock',
  [switch]   $Dns,
  [switch]   $NoPrivate,
  [switch]   $Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Prefix    = Join-Path $env:ProgramFiles 'GuardLock'
$GeckoId   = 'guardlock@cftheitguy.github.io'
$EdgeKey   = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
$ChromeKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
$AllCats   = @('adult', 'gambling', 'social', 'video', 'games')

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell — browser policy lives in HKLM.'
  }
}

function Get-FirefoxDirs {
  # policies.json goes in a "distribution" folder beside firefox.exe.
  @(
    (Join-Path $env:ProgramFiles 'Mozilla Firefox'),
    (Join-Path ${env:ProgramFiles(x86)} 'Mozilla Firefox')
  ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'firefox.exe')) } |
      ForEach-Object { Join-Path $_ 'distribution' }
}

# ------------------------------------------------------------------ uninstall

if ($Uninstall) {
  Assert-Admin
  Write-Host 'Removing GuardLock provisioning...'
  foreach ($key in @($EdgeKey, $ChromeKey)) {
    foreach ($name in @('IncognitoModeAvailability', 'BrowserGuestModeEnabled')) {
      Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
    }
    foreach ($sub in @('ExtensionInstallForcelist', '3rdparty')) {
      Remove-Item -Path (Join-Path $key $sub) -Recurse -ErrorAction SilentlyContinue
    }
  }
  foreach ($dir in Get-FirefoxDirs) {
    Remove-Item -Path (Join-Path $dir 'policies.json') -ErrorAction SilentlyContinue
  }
  if (Test-Path $Prefix) { Remove-Item -Path $Prefix -Recurse -Force }
  Write-Host '  policies and program files removed'
  Write-Host '  DNS was left alone; change it back by hand if you set it with -Dns'
  Write-Host 'Done. Restart the browsers.'
  return
}

Assert-Admin
if (-not $Pin) { throw 'The -Pin parameter is required.' }
if ($Pin -notmatch '^\d{4,12}$') { throw 'The PIN must be 4 to 12 digits.' }

Write-Host 'GuardLock provisioning'
Write-Host "  source     $BaseUrl"

# ------------------------------------------------------- fetch the extension

$zip = Join-Path $env:TEMP 'guardlock-edge.zip'
Write-Host '  downloading the extension...'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri "$BaseUrl/dist/guardlock-edge.zip" -OutFile $zip -UseBasicParsing

$chromiumDir = Join-Path $Prefix 'chromium'
if (Test-Path $chromiumDir) { Remove-Item $chromiumDir -Recurse -Force }
New-Item -ItemType Directory -Path $chromiumDir -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $chromiumDir -Force
Remove-Item $zip -Force

$version = (Get-Content (Join-Path $chromiumDir 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "  installed $chromiumDir (version $version)"

# ------------------------------------------------------------- the PIN hash

# Only the hash is written anywhere. The digits stay with you.
$salt = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
$iterations = 210000
$kdf = New-Object -TypeName Security.Cryptography.Rfc2898DeriveBytes -ArgumentList @(
  $Pin, $salt, $iterations, [Security.Cryptography.HashAlgorithmName]::SHA256)
$toHex = { param($bytes) ($bytes | ForEach-Object { $_.ToString('x2') }) -join '' }

$config = [ordered]@{
  lockSalt           = & $toHex $salt
  lockHash           = & $toHex ($kdf.GetBytes(32))
  lockIterations     = $iterations
  enabled            = $true
  safeSearch         = $true
  keywordsEnabled    = $true
  urlKeywordsEnabled = $true
  guardSettingsPage  = $true
  keywordThreshold   = $Sensitivity
  unlockMinutes      = $Relock
  categories         = [ordered]@{}
  allowlist          = @($Allow)
  blocklist          = @($Block)
  remoteLists        = @($Lists)
}
foreach ($c in $AllCats) { $config.categories[$c] = ($Categories -contains $c) }

# ------------------------------------------------------------ extension ids

# Chromium derives an unpacked extension's id from its own path. Windows hashes
# the path as UTF-16; other platforms as UTF-8. Both are written, because an
# extra entry costs nothing and a missing one silently loses the provisioning.
function Get-UnpackedId([string] $path, [Text.Encoding] $encoding) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash($encoding.GetBytes($path))
  -join ($hash[0..15] | ForEach-Object {
    [char](97 + ($_ -shr 4)) + [char](97 + ($_ -band 15))
  })
}
$ids = @(
  (Get-UnpackedId $chromiumDir ([Text.Encoding]::Unicode)),
  (Get-UnpackedId $chromiumDir ([Text.Encoding]::UTF8))
) | Select-Object -Unique
Write-Host "  unpacked ids $($ids -join ', ')"

if ($ExtId) { $ids = @($ids) + $ExtId }

# --------------------------------------------------------- chromium policies

function Set-Value($path, $name, $value, $type) {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
}

foreach ($browser in @($EdgeKey, $ChromeKey)) {
  if ($NoPrivate) {
    Set-Value $browser 'IncognitoModeAvailability' 1 'DWord'
    Set-Value $browser 'BrowserGuestModeEnabled'   0 'DWord'
  }
  if ($ExtId) {
    $update = if ($ExtUpdate) { $ExtUpdate } else { 'https://clients2.google.com/service/update2/crx' }
    Set-Value (Join-Path $browser 'ExtensionInstallForcelist') '1' "$ExtId;$update" 'String'
  }
  foreach ($id in $ids) {
    $policyKey = Join-Path $browser "3rdparty\extensions\$id\policy"
    foreach ($entry in $config.GetEnumerator()) {
      $value = $entry.Value
      if ($value -is [bool]) {
        Set-Value $policyKey $entry.Key ([int]$value) 'DWord'
      } elseif ($value -is [int]) {
        Set-Value $policyKey $entry.Key $value 'DWord'
      } elseif ($value -is [string]) {
        Set-Value $policyKey $entry.Key $value 'String'
      } else {
        # Objects and arrays travel as JSON strings, which is how Chromium
        # expects structured extension policy in the registry.
        Set-Value $policyKey $entry.Key (ConvertTo-Json -InputObject $value -Compress -Depth 5) 'String'
      }
    }
  }
  Write-Host "  policy -> $browser"
}

# ---------------------------------------------------------- firefox policies

if (-not $Xpi) { $Xpi = "$BaseUrl/dist/guardlock-firefox.xpi" }

$policies = [ordered]@{
  policies = [ordered]@{
    ExtensionSettings = [ordered]@{
      $GeckoId = [ordered]@{
        installation_mode = 'force_installed'
        install_url       = $Xpi
        private_browsing  = $true
        default_area      = 'navbar'
      }
      '*' = @{ installation_mode = 'allowed' }
    }
    '3rdparty'          = @{ Extensions = @{ $GeckoId = $config } }
    BlockAboutConfig    = $true
    BlockAboutProfiles  = $true
    DisableSafeMode     = $true
  }
}
if ($NoPrivate) { $policies.policies['DisablePrivateBrowsing'] = $true }

$firefoxDirs = @(Get-FirefoxDirs)
if ($firefoxDirs.Count -eq 0) {
  Write-Host '  Firefox not found — skipping its policy'
} else {
  foreach ($dir in $firefoxDirs) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $policies | ConvertTo-Json -Depth 8 |
      Set-Content -Path (Join-Path $dir 'policies.json') -Encoding UTF8
    Write-Host "  policy -> $(Join-Path $dir 'policies.json')"
  }
}

# ------------------------------------------------------------------- dns

if ($Dns) {
  # Cloudflare for Families: blocks malware and adult content at the resolver,
  # so the machine is filtered before any browser starts.
  Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses ('1.1.1.3', '1.0.0.3')
  }
  Clear-DnsClientCache
  Write-Host '  DNS -> Cloudflare for Families on every active adapter'
}

# ---------------------------------------------------------------- report

Write-Host ''
Write-Host 'Done. Restart any open browser.'
Write-Host ''
Write-Host '  Firefox   installs GuardLock by itself and allows it in private windows.'
Write-Host "            This needs a signed .xpi at:"
Write-Host "              $Xpi"
if ($ExtId) {
  Write-Host "  Edge      force-installs $ExtId"
} else {
  Write-Host '  Edge      the settings and PIN are provisioned, but nothing force-installs'
  Write-Host '            the extension yet. Either publish it to the Edge Add-ons store'
  Write-Host '            (free) and re-run with -ExtId <id>, or load it once by hand from'
  Write-Host "              $chromiumDir"
  Write-Host '            Once loaded it picks up the policy immediately — still no setup'
  Write-Host '            wizard, still locked.'
}
Write-Host ''
Write-Host '  The PIN is not stored on this machine, only its hash. A provisioned'
Write-Host '  install has no recovery code, so keep the PIN somewhere safe.'

<#
.SYNOPSIS
    One-time learning run: records the internet destinations a properly
    filtered computer talks to, so geder-monitor.ps1 can later recognize
    "normal, filtered" traffic vs. traffic that bypasses the filter.

.DESCRIPTION
    Run this ONCE, manually, on a computer you are certain is correctly
    running Geder. It samples active outbound connections over a window
    (default 5 minutes) and saves every distinct public remote IP seen to
    a JSON allowlist file.

    Afterwards, open the resulting file and copy the IP list into the
    $AllowlistIPs array near the top of geder-monitor.ps1 before you
    deploy that script fleet-wide via NinjaOne.

.PARAMETER DurationSeconds
    How long to sample for. Longer runs catch more of Geder's IPs
    (e.g. if it uses several servers). Default 300 (5 minutes) - browse
    a handful of normal sites while it runs.

.PARAMETER SampleIntervalSeconds
    How often to snapshot active connections during the run.

.PARAMETER OutFile
    Where to write the resulting allowlist JSON.
#>

param(
    [int]$DurationSeconds = 300,
    [int]$SampleIntervalSeconds = 5,
    [string]$OutFile = "$PSScriptRoot\geder-allowlist.json"
)

function Test-PrivateIP {
    param([string]$IP)
    if (-not $IP) { return $true }
    if ($IP -eq '127.0.0.1' -or $IP -eq '::1' -or $IP -eq '0.0.0.0') { return $true }
    if ($IP -match '^10\.') { return $true }
    if ($IP -match '^192\.168\.') { return $true }
    if ($IP -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') { return $true }
    if ($IP -match '^169\.254\.') { return $true }
    if ($IP -match '^::1$|^fe80:|^fc00:|^fd00:') { return $true }
    return $false
}

$seen = New-Object System.Collections.Generic.HashSet[string]
$end = (Get-Date).AddSeconds($DurationSeconds)

Write-Host "Learning normal (filtered) traffic for $DurationSeconds seconds."
Write-Host "Browse a few normal websites on this computer while this runs."

while ((Get-Date) -lt $end) {
    Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-PrivateIP $_.RemoteAddress) } |
        ForEach-Object { $seen.Add($_.RemoteAddress) | Out-Null }
    Start-Sleep -Seconds $SampleIntervalSeconds
}

$allowlist = $seen | Sort-Object
$allowlist | ConvertTo-Json | Set-Content -Path $OutFile -Encoding UTF8

Write-Host ""
Write-Host "Done. Recorded $($allowlist.Count) distinct remote IP(s):"
$allowlist | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Saved to: $OutFile"
Write-Host "Next: copy this IP list into the `$AllowlistIPs array in geder-monitor.ps1"
Write-Host "before deploying that script to the rest of the fleet."

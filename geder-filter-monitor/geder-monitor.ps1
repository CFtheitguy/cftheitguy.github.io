<#
.SYNOPSIS
    Detects when a computer has internet traffic going somewhere other
    than Geder - a sign the filter was removed, disabled, or bypassed
    (by the user, or by malware/an attacker).

.DESCRIPTION
    Meant to run on a schedule via NinjaOne (e.g. every 10-15 minutes)
    across the whole fleet. It lists the computer's currently active
    outbound connections, ignores private/local addresses, and compares
    every remaining public IP against a known-good allowlist of Geder's
    addresses (built once with geder-baseline.ps1).

    If ANY connection is found that isn't in the allowlist:
      - it's logged to $LogFile with the remote IP/port and the local
        process that made the connection
      - it's written to a NinjaOne custom field (if run through the
        NinjaOne agent) so you can alert on it
      - the script exits with code 1, which NinjaOne can treat as a
        failed script result and alert on

    If everything matches the allowlist, it exits 0 and clears the
    custom field.

.NOTES
    Before deploying: run geder-baseline.ps1 once on a known-good,
    properly-filtered PC, then paste the resulting IPs into
    $AllowlistIPs below. You can also pass -AllowlistIPs as a NinjaOne
    script parameter (comma-separated) instead of editing the file.
#>

param(
    [string[]]$AllowlistIPs = @(
        # <-- Paste the IPs from geder-baseline.ps1's output here, e.g.:
        # "203.0.113.10",
        # "203.0.113.11"
    ),
    [string]$AllowlistFile = "$PSScriptRoot\geder-allowlist.json",
    [string]$LogFile = "$PSScriptRoot\geder-monitor.log",
    [string]$CustomFieldName = "gederBypassDetected"
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

# Merge the hardcoded list with an optional allowlist file dropped next
# to the script (handy for testing locally before baking IPs into the
# script for mass deployment).
$knownGood = New-Object System.Collections.Generic.HashSet[string]
foreach ($ip in $AllowlistIPs) { $knownGood.Add($ip) | Out-Null }
if (Test-Path $AllowlistFile) {
    (Get-Content $AllowlistFile | ConvertFrom-Json) | ForEach-Object { $knownGood.Add($_) | Out-Null }
}

if ($knownGood.Count -eq 0) {
    Write-Error "No allowlist configured. Run geder-baseline.ps1 on a known-good PC first, then populate `$AllowlistIPs or $AllowlistFile."
    exit 2
}

$connections = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-PrivateIP $_.RemoteAddress) }

$suspicious = @()
foreach ($conn in $connections) {
    if (-not $knownGood.Contains($conn.RemoteAddress)) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        $suspicious += [PSCustomObject]@{
            Time          = (Get-Date).ToString("s")
            RemoteAddress = $conn.RemoteAddress
            RemotePort    = $conn.RemotePort
            Process       = if ($proc) { $proc.ProcessName } else { "Unknown" }
            Pid           = $conn.OwningProcess
        }
    }
}

if ($suspicious.Count -gt 0) {
    foreach ($s in $suspicious) {
        $line = "{0} SUSPICIOUS remote={1}:{2} process={3} pid={4}" -f `
            $s.Time, $s.RemoteAddress, $s.RemotePort, $s.Process, $s.Pid
        Add-Content -Path $LogFile -Value $line
    }

    $summary = "Possible filter bypass: $($suspicious.Count) unknown connection(s) at $(Get-Date -Format s)"
    Write-Host "ALERT: $summary"
    $suspicious | Format-Table -AutoSize | Out-String | Write-Host

    if (Get-Command Ninja-Property-Set -ErrorAction SilentlyContinue) {
        Ninja-Property-Set $CustomFieldName $summary
    }
    exit 1
}
else {
    Write-Host "OK: all active connections match the Geder allowlist."
    if (Get-Command Ninja-Property-Set -ErrorAction SilentlyContinue) {
        Ninja-Property-Set $CustomFieldName ""
    }
    exit 0
}

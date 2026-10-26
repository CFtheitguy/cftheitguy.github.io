# Nightly offsite copy of Veeam image backups: local/NAS folder -> Cloudflare R2.
# Run after Veeam finishes. Only new/changed image files are uploaded.
# R2 layout: <bucket>/<PC>/current/  (mirror)   <bucket>/<PC>/deleted/<date>/  (kept $ImageR2Days days)
. "$PSScriptRoot\common.ps1"
Start-BackupLog "image-sync"

# rclone reads its R2 remote from environment variables (no rclone.conf needed)
$env:RCLONE_CONFIG_R2_TYPE              = "s3"
$env:RCLONE_CONFIG_R2_PROVIDER          = "Cloudflare"
$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID     = $R2AccessKey
$env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2SecretKey
$env:RCLONE_CONFIG_R2_ENDPOINT          = $R2Endpoint
$env:RCLONE_CONFIG_R2_NO_CHECK_BUCKET   = "true"

$dest = "r2:$ImageBucket/$env:COMPUTERNAME"

try {
    if (-not (Test-Path $ImageFolder)) { throw "Image folder not reachable: $ImageFolder" }

    # Don't sync while Veeam is still writing: wait until no file changed for 15 minutes
    $waited = 0
    while (Get-ChildItem $ImageFolder -Recurse -File |
           Where-Object LastWriteTime -gt (Get-Date).AddMinutes(-15) | Select-Object -First 1) {
        if ($waited -ge 180) { throw "Image files still changing after 3 hours, skipping sync" }
        Start-Sleep -Seconds 60; $waited++
    }

    # Mirror Veeam's folder (Veeam's own retention keeps full+incremental chains valid).
    # Anything removed or replaced locally is moved to a dated "deleted" folder in R2 instead
    # of being destroyed, so ransomware wiping the NAS can't wipe the offsite copy.
    $stamp = Get-Date -Format "yyyy-MM-dd"
    Invoke-Tool $Rclone @("sync", $ImageFolder, "$dest/current",
        "--backup-dir", "$dest/deleted/$stamp",
        "--transfers", "4", "--s3-chunk-size", "64M", "--s3-upload-concurrency", "4",
        "--max-delete", "50", "--log-level", "INFO")

    # Purge holding-area folders older than N days (judged by the folder's date name,
    # because moved files keep their original timestamps)
    $cutoff = (Get-Date).AddDays(-$ImageR2Days)
    foreach ($dir in (& $Rclone lsf "$dest/deleted" --dirs-only 2>$null)) {
        $name = $dir.TrimEnd("/")
        $date = [datetime]::MinValue
        if ([datetime]::TryParseExact($name, "yyyy-MM-dd", $null, "None", [ref]$date) -and $date -lt $cutoff) {
            Invoke-Tool $Rclone @("purge", "$dest/deleted/$name")
        }
    }

    # Sanity check: the newest image in R2 must be from the last 2 days
    $latest = & $Rclone lsjson "$dest/current" --recursive --files-only --max-age 2d | ConvertFrom-Json
    if (-not $latest) { throw "No image in R2 newer than 2 days - check Veeam job" }

    Write-Log "Image sync OK ($($latest.Count) recent file(s))"
    Send-Status "image" $true "ok"
}
catch {
    Write-Log "IMAGE SYNC FAILED: $_"
    Send-Status "image" $false "$_"
    exit 1
}

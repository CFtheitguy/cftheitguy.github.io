# Nightly file-level backup: Restic -> Cloudflare R2 (encrypted, deduplicated, versioned).
# Usage:  file-backup.ps1            run backup + prune
#         file-backup.ps1 -Init      first-time repository setup (run once per PC)
param([switch]$Init)
. "$PSScriptRoot\common.ps1"
Start-BackupLog "file-backup"

$env:RESTIC_REPOSITORY     = "s3:$R2Endpoint/$FileBucket/$env:COMPUTERNAME"
$env:RESTIC_PASSWORD       = $ResticPassword
$env:AWS_ACCESS_KEY_ID     = $R2AccessKey
$env:AWS_SECRET_ACCESS_KEY = $R2SecretKey
$env:AWS_DEFAULT_REGION    = "auto"

try {
    if ($Init) {
        Invoke-Tool $Restic @("init")
        Write-Log "Repository created. Store the Restic password somewhere safe!"
        exit 0
    }

    Invoke-Tool $Restic @("unlock")   # clears stale locks from an interrupted run

    $backupArgs = @("backup") + $BackupPaths + @("--exclude-caches", "--use-fs-snapshot", "--tag", "nightly")
    foreach ($p in $ExcludePatterns) { $backupArgs += @("--exclude", $p) }
    Invoke-Tool $Restic $backupArgs

    Invoke-Tool $Restic @("forget", "--prune", "--tag", "nightly",
        "--keep-daily", $KeepDaily, "--keep-weekly", $KeepWeekly, "--keep-monthly", $KeepMonthly)

    # Weekly integrity check of a sample of the stored data
    if ((Get-Date).DayOfWeek -eq "Sunday") { Invoke-Tool $Restic @("check", "--read-data-subset=5%") }

    Write-Log "File backup OK"
    Send-Status "files" $true "ok"
}
catch {
    Write-Log "FILE BACKUP FAILED: $_"
    Send-Status "files" $false "$_"
    exit 1
}

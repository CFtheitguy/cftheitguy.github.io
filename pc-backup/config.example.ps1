# Copy to C:\Backup\config.ps1 and fill in. Keep this file private (it holds secrets).

# --- Cloudflare R2 ---
$R2AccountId   = "YOUR_CLOUDFLARE_ACCOUNT_ID"
$R2AccessKey   = "R2_ACCESS_KEY_ID"          # token scoped to the buckets below
$R2SecretKey   = "R2_SECRET_ACCESS_KEY"
$FileBucket    = "pc-backups-files"
$ImageBucket   = "pc-backups-images"

# --- File backup (Restic) ---
$ResticPassword = "LONG-RANDOM-PASSWORD"     # SAVE THIS IN A PASSWORD MANAGER. Lost = backups unreadable.
$BackupPaths    = @("C:\Users")              # add app data folders, e.g. "C:\ProgramData\MyApp"
$ExcludePatterns = @("*\AppData\Local\Temp", "*\AppData\Local\Microsoft\Windows\INetCache", "*.tmp", "*\Downloads\*.iso")
$KeepDaily = 7; $KeepWeekly = 4; $KeepMonthly = 12

# --- Image sync (Veeam output folder -> R2) ---
$ImageFolder   = "\\NAS\Backups\$env:COMPUTERNAME"   # where Veeam writes images
$ImageR2Days   = 30                                   # days to keep files Veeam has removed/replaced

# --- Tools ---
$ToolsDir = "C:\Backup\bin"                  # restic.exe and rclone.exe live here
$LogDir   = "C:\Backup\logs"

# --- Optional monitoring: URL that receives a JSON status POST (leave "" to disable) ---
$StatusUrl = ""

# Registers the nightly scheduled tasks. Run once per PC in an elevated PowerShell.
#Requires -RunAsAdministrator
param(
    [string]$FileTime  = "1:00AM",
    [string]$SyncTime  = "4:00AM",
    [string]$ScriptDir = "C:\Backup"
)

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8) `
             -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 30)

function Register($name, $script, $time) {
    $action  = New-ScheduledTaskAction -Execute $ps `
               -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptDir\$script`""
    $trigger = New-ScheduledTaskTrigger -Daily -At $time
    Register-ScheduledTask -TaskName $name -TaskPath "\Backup\" -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Registered \Backup\$name at $time"
}

Register "Nightly File Backup" "file-backup.ps1" $FileTime
Register "Nightly Image Sync"  "image-sync.ps1"  $SyncTime

# config.ps1 holds secrets: only SYSTEM and Administrators may read it
icacls "$ScriptDir\config.ps1" /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
Write-Host "Locked down permissions on config.ps1"
Write-Host "Remember: schedule the Veeam image job for 2:00 AM in the Veeam Agent app."

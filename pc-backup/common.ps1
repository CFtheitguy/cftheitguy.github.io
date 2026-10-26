# Shared helpers loaded by the backup scripts.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\config.ps1"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$R2Endpoint = "https://$R2AccountId.r2.cloudflarestorage.com"
$Restic = Join-Path $ToolsDir "restic.exe"
$Rclone = Join-Path $ToolsDir "rclone.exe"

function Start-BackupLog($name) {
    $script:LogFile = Join-Path $LogDir ("{0}-{1:yyyy-MM-dd}.log" -f $name, (Get-Date))
    Get-ChildItem $LogDir -Filter "$name-*.log" |
        Where-Object LastWriteTime -lt (Get-Date).AddDays(-60) | Remove-Item -Force
}

function Write-Log($msg) {
    $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg
    Write-Host $line
    Add-Content -Path $script:LogFile -Value $line
}

function Invoke-Tool($exe, [string[]]$toolArgs) {
    Write-Log "> $(Split-Path $exe -Leaf) $($toolArgs -join ' ')"
    & $exe @toolArgs 2>&1 | ForEach-Object { Add-Content -Path $script:LogFile -Value "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) exited with code $LASTEXITCODE" }
}

function Send-Status($job, $ok, $detail) {
    if (-not $StatusUrl) { return }
    $body = @{ pc = $env:COMPUTERNAME; job = $job; ok = $ok; detail = $detail; time = (Get-Date).ToString("o") } | ConvertTo-Json
    try { Invoke-RestMethod -Uri $StatusUrl -Method Post -Body $body -ContentType "application/json" -TimeoutSec 20 | Out-Null }
    catch { Write-Log "Status report failed: $_" }
}

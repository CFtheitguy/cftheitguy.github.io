<#
  Linear IT — Device Deep Scan
  ==========================================================================
  Collects the details a web browser is NOT allowed to see (installed apps,
  admin vs. standard users, real disk size, OS uptime, CPU clock speed, RAM
  modules, installed content filter, etc.) and hands them to the dashboard at
  device.linearit.co in two ways:

    1) LOCAL BRIDGE  – serves the report on http://127.0.0.1:8765 so the
       dashboard on THIS PC can pull it automatically ("Pull from this PC").
    2) CLIPBOARD     – copies a report code you can paste into the dashboard
       on ANY device ("Paste report").

  Run it (Admin recommended, not required):
      irm https://www.linearit.co/device/scan.ps1 | iex

  It installs nothing, changes nothing, and only listens on loopback.
  Press Ctrl+C to close when you're done.
  ==========================================================================
#>

$ErrorActionPreference = 'SilentlyContinue'
$Port          = 8765
$BridgeSeconds = 300
$SchemaVersion = 'linear-device/1'

function Test-Admin {
  try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator) } catch { return $false }
}
$IsAdmin = Test-Admin

Write-Host ""
Write-Host "  Linear IT — Device Deep Scan" -ForegroundColor Cyan
Write-Host "  ---------------------------------------------" -ForegroundColor DarkGray
Write-Host ("  Admin mode : {0}" -f $(if($IsAdmin){'Yes'}else{'No (a few security fields will be skipped)'}))
Write-Host "  Collecting system information..." -ForegroundColor DarkGray

# ---- helpers ----------------------------------------------------------------
function GB($bytes){ if($bytes){ [math]::Round(($bytes/1GB),1) } else { $null } }

# ---- OS / computer ----------------------------------------------------------
$os  = Get-CimInstance Win32_OperatingSystem
$cs  = Get-CimInstance Win32_ComputerSystem
$bios= Get-CimInstance Win32_BIOS
$typeMap = @{1='Desktop';2='Laptop';3='Workstation';4='Enterprise Server';5='SOHO Server';6='Appliance PC';7='Performance Server';8='Maximum'}
$boot = $os.LastBootUpTime
$uptime = if($boot){ (New-TimeSpan -Start $boot -End (Get-Date)) } else { $null }

$computer = [ordered]@{
  name         = $env:COMPUTERNAME
  domain       = $cs.Domain
  partOfDomain = [bool]$cs.PartOfDomain
  manufacturer = $cs.Manufacturer
  model        = $cs.Model
  type         = $typeMap[[int]$cs.PCSystemType]
  serial       = $bios.SerialNumber
}
$osInfo = [ordered]@{
  caption   = $os.Caption
  version   = $os.Version
  build     = $os.BuildNumber
  arch      = $os.OSArchitecture
  installed = if($os.InstallDate){ $os.InstallDate.ToString('yyyy-MM-dd') } else { $null }
  lastBoot  = if($boot){ $boot.ToString('o') } else { $null }
  uptimeSec = if($uptime){ [int]$uptime.TotalSeconds } else { $null }
}

# ---- CPU --------------------------------------------------------------------
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cpuInfo = [ordered]@{
  name        = ($cpu.Name -replace '\s+',' ').Trim()
  cores       = [int]$cpu.NumberOfCores
  logical     = [int]$cpu.NumberOfLogicalProcessors
  maxClockMhz = [int]$cpu.MaxClockSpeed
}

# ---- RAM --------------------------------------------------------------------
$modules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  [ordered]@{ sizeGB=(GB $_.Capacity); speedMhz=[int]$_.Speed; manufacturer=($_.Manufacturer).Trim() }
})
$ramArray = Get-CimInstance Win32_PhysicalMemoryArray | Select-Object -First 1
$ramInfo = [ordered]@{
  totalGB    = GB $cs.TotalPhysicalMemory
  modules    = $modules
  slotsUsed  = $modules.Count
  slotsTotal = if($ramArray){ [int]$ramArray.MemoryDevices } else { $null }
}

# ---- Disks ------------------------------------------------------------------
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [ordered]@{
    drive  = $_.DeviceID
    label  = $_.VolumeName
    fsType = $_.FileSystem
    sizeGB = GB $_.Size
    freeGB = GB $_.FreeSpace
    usedPct= if($_.Size){ [int][math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100) } else { $null }
  }
})

# ---- Users (admins vs standard) --------------------------------------------
$adminNames = @()
try {
  $adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'       # built-in Administrators, SID is locale-proof
  $adminNames = @(Get-LocalGroupMember -Group $adminGroup.Name | ForEach-Object {
    ($_.Name -split '\\')[-1] })
} catch {}
$localUsers = @(Get-LocalUser | Where-Object { $_.Enabled } | Select-Object -ExpandProperty Name)
$standard = @($localUsers | Where-Object { $adminNames -notcontains $_ })
$users = [ordered]@{
  current       = "$env:USERDOMAIN\$env:USERNAME"
  adminCount    = @($adminNames).Count
  standardCount = @($standard).Count
  admins        = @($adminNames | Select-Object -Unique)
  standard      = @($standard | Select-Object -Unique)
}

# ---- Installed apps ---------------------------------------------------------
$uninstallKeys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$appsRaw = foreach($k in $uninstallKeys){
  Get-ItemProperty $k | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ReleaseType } |
    Select-Object DisplayName, DisplayVersion, Publisher
}
$apps = @($appsRaw | Sort-Object DisplayName -Unique | ForEach-Object {
  [ordered]@{ name=$_.DisplayName; version=$_.DisplayVersion; publisher=$_.Publisher }
})

# ---- Installed content filter (the reliable check!) -------------------------
$filterMap = @{
  'Techloq'='Techloq'; 'NetSpark'='Netspark'; 'Netspark'='Netspark'; 'NetFree'='NetFree';
  'Net Free'='NetFree'; 'Geder'='Geder'; 'Meshimer'='Meshimer'; 'Gentech'='Gentech';
  'Nativ'='Nativ'; 'MBSmart'='MBSmart'; 'MB Smart'='MBSmart'; 'Bark'='Bark'; 'Qustodio'='Qustodio';
  'Circle'='Circle'; 'Technology Awareness'='TAG'; 'Livigent'='Livigent'; 'K9 Web'='K9'
}
$svc = @(Get-CimInstance Win32_Service | Select-Object -ExpandProperty DisplayName)
$haystack = @($apps.name) + $svc
$filters = @()
foreach($needle in $filterMap.Keys){
  if($haystack | Where-Object { $_ -match [regex]::Escape($needle) }){ $filters += $filterMap[$needle] }
}
$filters = @($filters | Select-Object -Unique)

# ---- Security (admin-only bits are best-effort) -----------------------------
$security = [ordered]@{}
try { $av = Get-CimInstance -Namespace 'root/SecurityCenter2' -Class AntiVirusProduct
      $security.antivirus = @($av | Select-Object -ExpandProperty displayName -Unique) } catch {}
try { $fw = Get-NetFirewallProfile
      $security.firewall = if(($fw | Where-Object Enabled -eq $true).Count){ 'On' } else { 'Off' } } catch {}
if($IsAdmin){
  try { $bl = Get-BitLockerVolume -MountPoint $env:SystemDrive
        $security.bitlocker = "$($bl.VolumeStatus) ($($bl.ProtectionStatus))" } catch {}
}

# ---- Network ----------------------------------------------------------------
$net = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true' | ForEach-Object {
  [ordered]@{ name=$_.Description; ip=@($_.IPAddress | Where-Object { $_ -notmatch ':' })[0]; mac=$_.MACAddress }
})

# ---- Assemble ---------------------------------------------------------------
$report = [ordered]@{
  schema    = $SchemaVersion
  generated = (Get-Date).ToUniversalTime().ToString('o')
  admin     = $IsAdmin
  computer  = $computer
  os        = $osInfo
  cpu       = $cpuInfo
  ram       = $ramInfo
  disks     = $disks
  users     = $users
  apps      = [ordered]@{ count=@($apps).Count; list=$apps }
  filters   = $filters
  security  = $security
  network   = $net
}

$json    = $report | ConvertTo-Json -Depth 8 -Compress
$pretty  = $report | ConvertTo-Json -Depth 8

# save + clipboard
$outFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LinearDevice-Report.json'
try { $pretty | Set-Content -Path $outFile -Encoding UTF8 } catch {}
try { Set-Clipboard -Value $json } catch {}

Write-Host ""
Write-Host "  Done. Summary:" -ForegroundColor Green
Write-Host ("    Computer : {0}  ({1} {2})" -f $computer.name,$computer.manufacturer,$computer.model)
Write-Host ("    OS       : {0}  build {1}" -f $osInfo.caption,$osInfo.build)
Write-Host ("    CPU      : {0}  ({1} cores, {2} MHz)" -f $cpuInfo.name,$cpuInfo.cores,$cpuInfo.maxClockMhz)
Write-Host ("    RAM      : {0} GB in {1} slot(s)" -f $ramInfo.totalGB,$ramInfo.slotsUsed)
Write-Host ("    Disks    : {0}" -f (($disks | ForEach-Object { "$($_.drive) $($_.freeGB)/$($_.sizeGB) GB free" }) -join ', '))
Write-Host ("    Users    : {0} admin / {1} standard" -f $users.adminCount,$users.standardCount)
Write-Host ("    Apps     : {0} installed" -f $apps.Count)
Write-Host ("    Filter   : {0}" -f $(if($filters.Count){ $filters -join ', ' }else{ 'none detected' }))
Write-Host ""
Write-Host "  Report copied to your clipboard and saved to:" -ForegroundColor Yellow
Write-Host ("    {0}" -f $outFile)
Write-Host ""
Write-Host "  NEXT: on device.linearit.co, open the 'Full System Scan' card and either" -ForegroundColor Cyan
Write-Host "        - click 'Pull from this PC'  (keep this window open), or" -ForegroundColor Cyan
Write-Host "        - click 'Paste report' and paste (Ctrl+V)." -ForegroundColor Cyan
Write-Host ""

# ---- Local bridge (raw loopback HTTP, no admin / no firewall prompt) --------
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
function Send-Response($stream,[int]$status,[byte[]]$payload){
  $reason = if($status -eq 204){'No Content'} else {'OK'}
  $hdr = @(
    "HTTP/1.1 $status $reason",
    "Access-Control-Allow-Origin: *",
    "Access-Control-Allow-Private-Network: true",
    "Access-Control-Allow-Methods: GET, OPTIONS",
    "Access-Control-Allow-Headers: *",
    "Cache-Control: no-store",
    "Content-Type: application/json; charset=utf-8",
    ("Content-Length: {0}" -f $(if($payload){$payload.Length}else{0})),
    "Connection: close"
  ) -join "`r`n"
  $hb = [System.Text.Encoding]::UTF8.GetBytes($hdr + "`r`n`r`n")
  $stream.Write($hb,0,$hb.Length)
  if($payload -and $payload.Length){ $stream.Write($payload,0,$payload.Length) }
  $stream.Flush()
}

try {
  $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$Port)
  $tcp.Start()
  Write-Host ("  Bridge listening on http://127.0.0.1:{0}  (open for {1} min — Ctrl+C to stop)" -f $Port,($BridgeSeconds/60)) -ForegroundColor Green
  $deadline = (Get-Date).AddSeconds($BridgeSeconds)
  while((Get-Date) -lt $deadline){
    if($tcp.Pending()){
      $client = $tcp.AcceptTcpClient()
      try{
        $client.ReceiveTimeout = 1500; $client.SendTimeout = 3000
        $ns = $client.GetStream()
        Start-Sleep -Milliseconds 40
        $buf = New-Object byte[] 4096; $n = 0
        if($ns.DataAvailable){ $n = $ns.Read($buf,0,$buf.Length) }
        $method = if($n){ (([System.Text.Encoding]::ASCII.GetString($buf,0,$n)) -split '\s+')[0] } else { 'GET' }
        if($method -eq 'OPTIONS'){ Send-Response $ns 204 $null }
        else { Send-Response $ns 200 $bodyBytes; Write-Host "  -> Report delivered to the dashboard." -ForegroundColor Green }
      } catch {} finally { $client.Close() }
    } else { Start-Sleep -Milliseconds 150 }
  }
  $tcp.Stop()
  Write-Host "  Bridge closed. (The clipboard copy still works — use 'Paste report'.)" -ForegroundColor DarkGray
} catch {
  Write-Host ("  Could not start the local bridge ({0}). Use 'Paste report' instead." -f $_.Exception.Message) -ForegroundColor Yellow
}

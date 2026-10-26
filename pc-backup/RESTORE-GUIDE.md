# Restore Guide

> Print this page. Keep it with the Veeam recovery USB sticks.
> You need: **R2 keys** + **Restic password** + **Veeam encryption password** (password manager).

**Which section do I need?**

| Situation | Go to |
|---|---|
| Lost / overwrote a few files | §1 Restore files |
| PC works but Windows is broken / ransomware | §2 Restore image (same PC) |
| Drive died, or replacing the whole PC | §2 or §3 |
| Need the user working **right now** | §4 Boot image as a VM |
| NAS is gone too (fire/theft) | §5 Get images from R2 first |

---

## §1 Restore files (Restic)
On the PC (or any PC with `C:\Backup` set up), PowerShell as Administrator:

```powershell
cd C:\Backup
. .\config.ps1
$env:RESTIC_REPOSITORY     = "s3:https://$R2AccountId.r2.cloudflarestorage.com/$FileBucket/PCNAME"
$env:RESTIC_PASSWORD       = $ResticPassword
$env:AWS_ACCESS_KEY_ID     = $R2AccessKey
$env:AWS_SECRET_ACCESS_KEY = $R2SecretKey

.\bin\restic.exe snapshots                                  # list backups, note the ID
.\bin\restic.exe find "budget*.xlsx"                         # search for a file
.\bin\restic.exe restore latest --target C:\Restore --include "C:\Users\john\Documents\Budget.xlsx"
.\bin\restic.exe restore 1a2b3c4d --target C:\Restore        # whole snapshot
```
Files land in `C:\Restore\...` – copy them back where they belong. Never restore over
the originals directly.

Prefer clicking? `.\bin\restic.exe mount` is Linux/macOS only; on Windows use
**Restic Browser** (github.com/emuell/restic-browser) with the same repository/keys.

## §2 Restore full image – same PC or replacement drive
1. Install the new drive if needed (same size or larger).
2. Plug in the **Veeam recovery USB**, power on, open the boot menu (F12 / F11 / Esc / F8 – depends on the brand) and boot from USB.
3. Choose **Bare Metal Recovery**.
4. Select **Network storage** → `\\NAS\Backups\PCNAME` (enter NAS username/password).
   If the network driver is missing: *Tools → Load driver*, or use a USB drive with the backup copied onto it (§5).
5. Pick the restore point (usually last night) → enter the Veeam encryption password.
6. Restore mode: **Entire computer** → Restore. 30–90 minutes.
7. Remove USB, reboot. Log in and check: user files, main apps, printers, Windows activation.

## §3 Restore to DIFFERENT hardware
Same as §2, plus:
- In the recovery environment, before restoring choose **Tools → Driver injection** and point
  it at a folder/USB with the new PC's storage & network drivers (download from the maker's site).
- After first boot: let Windows Update install drivers, then **Settings → Activation**. With a
  digital license tied to a Microsoft account use *Troubleshoot → "I changed hardware"*.
- Rename/rejoin the domain only if the old PC is permanently gone (otherwise two PCs share a name).

## §4 Boot the image as a virtual machine (fastest)
Use any working Windows PC with Hyper-V (Win 10/11 Pro) or VirtualBox:
1. On a PC with Veeam Agent installed: **Restore → Volume level restore → Export disk** for the
   system disk, format **VHDX** (Hyper-V) or **VMDK** (VirtualBox). Save to local disk.
   *(Alternative: Veeam Backup & Replication Community Edition can do **Instant Recovery** to Hyper-V directly from the .vbk.)*
2. Hyper-V Manager → New VM → **Generation 2** (if the PC was UEFI, which most are), 8 GB RAM,
   *Use an existing virtual hard disk* → pick the VHDX. Turn **Secure Boot** on (Microsoft Windows template).
3. Start the VM. The user logs in to their old desktop – same apps, same files.
4. Afterwards copy anything they changed in the VM back to the restored/replacement PC.

This is also the **monthly restore test**: boot one PC's image as a VM, log in, close it.

## §5 NAS lost – download images from R2 first
Restores from R2 are **free** (no egress fees); speed depends on your internet.
On any Windows PC with `rclone.exe`:

```powershell
. C:\Backup\config.ps1        # or set the four values by hand
$env:RCLONE_CONFIG_R2_TYPE="s3"; $env:RCLONE_CONFIG_R2_PROVIDER="Cloudflare"
$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID=$R2AccessKey; $env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$R2SecretKey
$env:RCLONE_CONFIG_R2_ENDPOINT="https://$R2AccountId.r2.cloudflarestorage.com"

rclone lsl r2:pc-backups-images/PCNAME/current                     # see what's there
rclone copy r2:pc-backups-images/PCNAME/current E:\PCNAME --transfers 8 --progress
```
- Copy the **whole folder** – the `.vbk` (full) plus all `.vib` (incrementals) and `.vbm` are needed.
- If ransomware damaged the newest files, look in `r2:pc-backups-images/PCNAME/deleted/<date>/`
  for the earlier versions (kept 30 days).
- Then follow §2 and choose **Local storage** → `E:\PCNAME` (external USB drive).

---

## Checklist after any restore
- [ ] User can log in, files present (check Desktop/Documents dates)
- [ ] Email, browser, line-of-business apps open
- [ ] Windows activated, Windows Update run
- [ ] Next night's backups succeed (check `C:\Backup\logs` and Veeam)
- [ ] If hardware changed: make a new Veeam recovery USB for it

## Test schedule
| How often | Test |
|---|---|
| Monthly | §1 restore one random file from each PC |
| Quarterly | §4 boot one PC image as a VM |
| Yearly | §5 download one image from R2 and restore it to spare hardware |

# PC Nightly Backup → Cloudflare R2

Two layers per PC:

| Layer | Tool | Destination | Protects against |
|---|---|---|---|
| **File backup** | Restic | R2 bucket `pc-backups-files` | Deleted/overwritten files, ransomware on files |
| **Image backup** | Veeam Agent (Free) → rclone | NAS/USB, then R2 bucket `pc-backups-images` | Dead drive, dead PC, broken Windows |

Nightly schedule: **1:00 AM** files → **2:00 AM** Veeam image → **4:00 AM** image sync to R2.

## Files

| File | Purpose |
|---|---|
| `config.example.ps1` | Settings template → copy to `config.ps1` and fill in (never commit it) |
| `common.ps1` | Shared logging / status helpers |
| `file-backup.ps1` | Restic backup + retention + weekly integrity check |
| `image-sync.ps1` | Copies Veeam images to R2 (mirror + 30-day "deleted" safety folder) |
| `install-tasks.ps1` | Creates the scheduled tasks (runs as SYSTEM) |
| `RESTORE-GUIDE.md` | How to get files or a whole PC back |

## One-time Cloudflare setup
1. Cloudflare dashboard → **R2** → create buckets `pc-backups-files` and `pc-backups-images`.
2. R2 → **Manage API tokens** → create token with **Object Read & Write**, limited to those two buckets.
   Copy the Access Key ID, Secret, and your Account ID.
3. (Recommended) On each bucket, enable a **Bucket lock / retention rule** of a few days so a compromised PC can't delete its own backups immediately.

## Per-PC setup (≈20 minutes)
1. Create `C:\Backup\bin` and put these in it:
   - `restic.exe` – https://github.com/restic/restic/releases (windows_amd64)
   - `rclone.exe` – https://rclone.org/downloads/
2. Copy all `.ps1` files from this folder into `C:\Backup`.
3. `copy C:\Backup\config.example.ps1 C:\Backup\config.ps1` and edit it.
   **Save the Restic password in your password manager** – without it the file backups can't be opened.
4. Open **PowerShell as Administrator**:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   C:\Backup\file-backup.ps1 -Init      # creates the encrypted repository in R2
   C:\Backup\file-backup.ps1            # first full backup (can take hours)
   C:\Backup\install-tasks.ps1          # schedules nightly runs
   ```
5. Install **Veeam Agent for Microsoft Windows (Free)** and create a job:
   - Backup mode: **Entire computer**
   - Destination: **Shared folder** → `\\NAS\Backups\<PCNAME>` (same as `$ImageFolder`)
   - Restore points: **14**; Advanced → **Active full backup monthly**; enable compression
   - Schedule: **Daily 2:00 AM**
   - Enable encryption and save that password too.
6. In Veeam: **Create Recovery Media** → USB stick. Label it with the PC name and keep it safe.
7. Next morning: check `C:\Backup\logs\` and run the test restores in `RESTORE-GUIDE.md` §1 and §4.

## Monitoring
- Logs: `C:\Backup\logs\file-backup-<date>.log`, `image-sync-<date>.log` (kept 60 days).
- Task status: Task Scheduler → `\Backup\` → *Last Run Result* should be `0x0`.
- Optional: set `$StatusUrl` to an endpoint (e.g. a Cloudflare Worker) that receives
  `{pc, job, ok, detail, time}` JSON after every run and alerts you on failures or silence.

## Expected cost (R2 @ $0.015/GB-month, free egress)
~$1–2/PC/month for files + ~$2–5/PC/month for images on a typical office PC.

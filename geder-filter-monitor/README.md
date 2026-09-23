# Geder Filter Bypass Monitor

Alerts you when a managed computer has internet traffic going somewhere
**other than Geder** - which usually means the filter was removed,
disabled, or bypassed (by the user, or by malware/an attacker on that
machine). Built to run fleet-wide through **NinjaOne**.

Instead of full packet capture (which would need Wireshark/Npcap
installed on every endpoint), this uses each computer's own built-in
connection list (`Get-NetTCPConnection`, no extra software) and checks
every public IP it's talking to against a known-good "this is Geder"
allowlist.

## Files

- **`geder-baseline.ps1`** - run once, manually, on a computer you know
  is properly filtered. Records the IPs it talks to and saves them as
  the allowlist.
- **`geder-monitor.ps1`** - the script you deploy to the whole fleet via
  NinjaOne. Runs on a schedule, compares live connections to the
  allowlist, and flags anything unexpected.

## Step 1: Build the allowlist

1. Pick a computer you're confident is correctly running Geder.
2. Copy `geder-baseline.ps1` to it and run it in an elevated PowerShell
   window:
   ```powershell
   .\geder-baseline.ps1
   ```
3. While it runs (5 minutes by default), browse a handful of normal
   sites so it sees real traffic.
4. It prints and saves the list of remote IPs it saw
   (`geder-allowlist.json`).

## Step 2: Configure the monitor script

Open `geder-monitor.ps1` and paste the IPs from step 1 into the
`$AllowlistIPs` array near the top:

```powershell
[string[]]$AllowlistIPs = @(
    "203.0.113.10",
    "203.0.113.11"
)
```

If Geder rotates or adds servers later, re-run the baseline and update
this list.

## Step 3: Deploy through NinjaOne

1. **Add a Custom Field** (Administration → Devices → Custom Fields):
   create a text field named `gederBypassDetected`. The script writes a
   description of what it found there, or clears it when everything's
   fine.
2. **Add the script** (Administration → Library → Scripting): upload
   `geder-monitor.ps1` as a new PowerShell script.
3. **Schedule it**: create a policy/scheduled task that runs the script
   on all the managed devices you want watched, every 10-15 minutes.
4. **Create the alert condition** (Administration → Alerts → Conditions):
   trigger a NinjaOne alert (which can notify you by email, ticket, etc.
   depending on how your NinjaOne notifications are set up) when either:
   - the script result is **Failed** (exit code 1), or
   - the custom field `gederBypassDetected` is **not empty**

That's it - from then on, if a computer's Geder filter disappears and
it starts talking to the open internet directly, you'll get notified
instead of finding out after the fact.

## Notes

- Exit code `1` = suspicious traffic found (alert). Exit code `2` = the
  script isn't configured yet (no allowlist). Exit code `0` = all clear.
- Details of what was flagged (remote IP, port, and which process made
  the connection) are appended to `geder-monitor.log` next to the
  script on that machine, so you can investigate.
- This flags *connections*, not content - it can't tell you what was
  looked at, only that traffic bypassed the expected path. Treat every
  alert as "go check this computer," not definitive proof of anything.
- Private/local network traffic (10.x, 192.168.x, etc.) is always
  ignored - only public internet destinations are checked.

# LinearWatch Desktop Agent (Step 3 — not built yet)

The C# .NET Windows tray agent will be scaffolded next, after you've tested the
ingest-to-view loop. Until then, [`../mock-device`](../mock-device) exercises the exact
same server API (`/v1/agent/*`) so the backend is fully proven.

## Planned design (disclosed monitoring — nothing hidden)

- **Always-visible system-tray icon** whenever the agent runs — this *is* the required
  "you are being monitored" indicator. It is never hidden, minimized away, or spoofed.
- **First-run consent dialog** naming the organization, what is captured, the interval,
  the retention period, and that continuing constitutes acknowledgment — then reports
  the acknowledgment to the server (`POST /v1/agent/consent`).
- **Enrollment** with an org code (`POST /v1/agent/enroll`); the returned per-device
  token is stored in the Windows Credential Manager / DPAPI, never in plaintext.
- **Capture loop**: grabs the full virtual screen every N seconds (interval pulled from
  `GET /v1/agent/config`), JPEG-compresses, and uploads with the device token. A local
  disk queue retries when offline.
- **Runs only for the interactive logged-in user** (per-user, not a hidden service).
- **Tray menu**: status, pause (with a required reason), open policy, quit.
- **Distribution**: a standard, **code-signed MSI** installer. Nothing about the
  install or runtime is concealed.

No stealth, window-hiding, process-hiding, or anti-detection functionality will be
included — those are out of scope for this product by design.

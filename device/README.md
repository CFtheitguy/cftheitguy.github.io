# Device Report — `device.linearit.co`

A one-tap, browser-based device report. A client or tech opens the page **on the
device in question**, taps **Run device report**, and the page reads everything
the browser is allowed to expose — then offers a **Send report to Linear IT**
button that opens a pre-filled email to `support@linearit.co`.

Nothing is installed, nothing is uploaded automatically, and nothing is sent
unless the user taps *Send*.

Lives at: **`/device/index.html`** → served at `https://www.linearit.co/device/`.

---

## Pointing `device.linearit.co` here

GitHub Pages only serves the single custom domain in the repo's `CNAME`
(`www.linearit.co`), so the `device` subdomain has to be wired in Cloudflare
(where the `linearit.co` DNS already lives). Pick one:

### Option A — Redirect rule (simplest, recommended)
Cloudflare → **Rules → Redirect Rules → Create rule**
- **When**: Hostname `equals` `device.linearit.co`
- **Then**: Static redirect → `https://www.linearit.co/device/` — Status `301`
- Add a DNS record so the hostname resolves: **DNS → Add record** →
  `CNAME  device  →  www.linearit.co` (Proxied / orange cloud).

Visitors typing `device.linearit.co` land on the report; the address bar shows
`www.linearit.co/device/`.

### Option B — Keep the `device.linearit.co` URL (Cloudflare Worker)
If you want the address bar to stay `device.linearit.co`, add a tiny Worker on a
route `device.linearit.co/*` that fetches and returns
`https://www.linearit.co/device/`. More moving parts than Option A; only worth it
if the vanity URL matters.

---

## What it can and can't read

This is a **web page**, so it's limited to what browsers expose. It is *not* a
replacement for the NinjaOne agent — it's a fast, zero-install snapshot.

| Requested                | Shown as            | Notes |
|--------------------------|---------------------|-------|
| Location                 | ✅ Live/Approx      | City/region/ISP from IP; optional precise GPS button |
| Device type & OS         | ✅ Live             | Form factor, OS + version, model (Chromium), architecture |
| Content filter           | ⚠️ Best-effort      | Detects filters that announce themselves (e.g. NetFree); manual confirm dropdown |
| CPU cores & performance  | ✅ Live             | Core count + in-browser single-thread benchmark. Clock speed isn't exposed to browsers |
| RAM                      | ⚠️ Approx           | `navigator.deviceMemory` — coarse, Chromium caps the report at 8 GB |
| Internet speed           | ✅ Live             | Real download test (Cloudflare) + latency |
| Storage                  | ⚠️ Approx           | Browser storage quota only — **not** full drive size (agent-only) |
| Uptime                   | ⚠️ Session only     | Device power-on uptime is agent-only |
| Admin / standard users   | 🔒 Agent required   | Local account inventory is not visible to any website |
| Installed apps           | 🔒 Agent required   | Browsers can't list installed programs (privacy) |
| Display / GPU            | ✅ Live             | Resolution, pixel ratio, GPU (WebGL) |
| Battery / power          | ✅ Live             | Level + charging (where supported) |
| Browser / environment    | ✅ Live             | Browser, timezone, languages, theme, cookies, online |

Items marked **Agent required** are shown honestly rather than faked; they come
from the RMM agent already deployed on managed devices.

## Changing the recipient email
In `index.html`, search for `SEND_TO` and change the address. It's used for both
the nav **Send to Linear IT** button and the bottom **Send report** button.

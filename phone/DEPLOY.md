# Linear Phone — Setup Guide

A Google-Voice-style softphone for your SignalWire line **845-604-2025**.
Web app: **https://linearit.co/phone** — texting + in-browser calling.

Everything below can be done from an iPad in the Cloudflare and SignalWire
**dashboards** — no command line required.

---

## What you're setting up

```
linearit.co/phone   →   linear-ivr Worker (api.linearit.co)   →   SignalWire (845-604-2025)
   the app                 the API + IVR + token minting            calls & texts
```

You'll do four things:
1. Create a **D1 database** (stores texts, call log, contacts, voicemail).
2. Paste the **new Worker code** and add your **secrets**.
3. Point your **SignalWire number** at the Worker.
4. Set the app's **API address** + password and you're live.

---

## 1) Create the D1 database

1. Cloudflare dashboard → **Workers & Pages** → **D1 SQL Database** → **Create**.
2. Name it `linear_phone` → **Create**.
3. Open it → **Console** tab → paste the entire contents of
   [`worker/schema.sql`](../worker/schema.sql) → **Execute**. (Creates the
   `messages`, `calls`, `voicemail`, `contacts` tables.)

## 2) Update the Worker

1. Cloudflare → **Workers & Pages** → open **`linear-ivr`** → **Edit code**.
2. Select all, delete, and paste the entire contents of
   [`worker/src/index.js`](../worker/src/index.js). **Save & Deploy**.
3. Still in `linear-ivr` → **Settings → Bindings** → **Add → D1 database**:
   - **Variable name:** `DB`
   - **D1 database:** `linear_phone`  → **Save**.
4. **Settings → Variables and Secrets** → add these (use **Encrypt** for each):

   | Name | Value |
   |---|---|
   | `SIGNALWIRE_SPACE` | your space host, e.g. `yourspace.signalwire.com` |
   | `SIGNALWIRE_PROJECT` | Project ID (SignalWire → API) |
   | `SIGNALWIRE_TOKEN` | API token (SignalWire → API, starts `PT…`) |
   | `SIGNALWIRE_NUMBER` | `+18456042025` |
   | `APP_PASSWORD` | the password you'll type to log in |
   | `AUTH_SECRET` | a long random string (mash the keyboard) |
   | `ALLOW_ORIGIN` | `https://linearit.co` |

   Optional (for inbound calls — see step 5):
   | `RELAY_CONTEXT` | `linearphone` |
   | `FORWARD_NUMBER` | your cell, e.g. `+1845…` (fallback ring) |

5. **Settings → Domains & Routes** → **Add → Custom Domain** →
   `api.linearit.co` → Save. (Lets the app talk to the Worker on your own
   domain. Cloudflare creates the SSL cert automatically.)

## 3) Point SignalWire at the Worker

In SignalWire → **Phone Numbers** → **845-604-2025** → **Edit Settings**:

- **Voice — Accept Incoming Calls As:** Voice Calls
- **Handle Calls Using:** **LaML Webhooks**
  - **When a Call Comes In:** `https://api.linearit.co/voice` (POST)
- **Messaging — Handle Messages Using:** **LaML Webhooks**
  - **When a Message Comes In:** `https://api.linearit.co/sms/inbound` (POST)

**Save.** Texting and the IVR now work, and the app can place outbound calls.

## 4) Turn on the app

1. Open [`phone/config.js`](config.js) and confirm:
   - `API_BASE: "https://api.linearit.co"`
   - `MY_NUMBER: "+18456042025"`
2. Make sure GitHub Pages serves this repo (it already does — `linearit.co`).
3. Go to **https://linearit.co/phone**, enter your `APP_PASSWORD`, and you're in.

---

## 5) (Optional) Ring the browser on inbound calls

Texting + outbound calling work after steps 1–4. To make inbound calls **ring
in the browser** (not just your cell/voicemail), SignalWire needs to route the
call to your RELAY client:

- Easiest reliable version: in the SignalWire number's voice settings, the
  Worker's `/voice` handler already does `<Dial>` to `FORWARD_NUMBER` if set —
  so set `FORWARD_NUMBER` to your cell and inbound calls ring your phone while
  unanswered calls drop to voicemail (which shows up in the app).
- Full in-browser ringing uses a RELAY Application/context. Set `RELAY_CONTEXT`
  (e.g. `linearphone`) as a Worker secret; the minted JWT is scoped to it. Then
  in SignalWire, route the number to that RELAY context. This part depends on
  your SignalWire account's RELAY setup — ping me and I'll wire the exact
  routing once your number is live on the Worker.

---

## Install it like an app (iPad / iPhone)

Open **https://linearit.co/phone** in Safari → **Share** → **Add to Home
Screen**. It launches full-screen like a native app (PWA). The same web app is
the foundation for a future React-Native/Capacitor mobile build.

## Troubleshooting

- **"Phone not connected" / status stays Offline:** the RELAY JWT couldn't be
  minted — check `SIGNALWIRE_SPACE`, `SIGNALWIRE_PROJECT`, `SIGNALWIRE_TOKEN`.
  Open the browser console for the exact error.
- **Texts send but don't appear inbound:** confirm the **Message Comes In**
  webhook points to `/sms/inbound` and the D1 `DB` binding is attached.
- **Login fails:** `APP_PASSWORD` mismatch, or `AUTH_SECRET` not set.
- **Calls won't dial:** mic permission must be granted, and the page must be
  HTTPS (it is, on `linearit.co`).

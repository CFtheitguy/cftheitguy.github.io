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

Your **voice / IVR is already wired** to this worker at `…/ivr` and keeps working
unchanged — you do **not** need to touch the "When a Call Comes In" setting.

You only need to add the **messaging** webhook so inbound texts reach the app.
In SignalWire → **Phone Numbers** → **845-604-2025** → **Edit Settings**:

- **Messaging — Handle Messages Using:** **LaML Webhooks**
  - **When a Message Comes In:**
    - `https://api.linearit.co/sms/inbound` (POST) — if you added the custom domain in step 2.5, **or**
    - `https://linear-ivr.friedmanchaimhersh.workers.dev/sms/inbound` (POST) — to use the worker's existing URL.

**Save.** Texting now works, and the app can place outbound calls.

> Tip: if you skip the custom domain (step 2.5), set `API_BASE` in
> `phone/config.js` to `https://linear-ivr.friedmanchaimhersh.workers.dev`
> and the SMS webhook to that same host. Everything still works — the app
> uses bearer tokens, not cookies, so cross-domain is fine.

## 4) Turn on the app

1. Open [`phone/config.js`](config.js) and confirm:
   - `API_BASE: "https://api.linearit.co"`
   - `MY_NUMBER: "+18456042025"`
2. Make sure GitHub Pages serves this repo (it already does — `linearit.co`).
3. Go to **https://linearit.co/phone**, enter your `APP_PASSWORD`, and you're in.

---

## 5) Ring the browser on inbound calls (Call Fabric)

Inbound browser ringing uses SignalWire's **Call Fabric Subscriber** system: the
app logs in as a Subscriber with a token (no SIP), so it can receive calls in any
browser on any device. Three one-time steps:

**5a. Create the Subscriber** (this is the identity the browser logs in as)
- SignalWire dashboard → left nav **Subscribers** (under *Call Fabric* / *Resources*)
  → **Create / Add Subscriber**.
- Give it a name/username and password. Note the **name** — it becomes the
  address `/private/<name>`.
- In the Worker, set secret **`SUBSCRIBER_REFERENCE`** to that exact name
  (e.g. `linearphone`). Also confirm **`GOOGLE_VOICE_NUMBER`** = `+19177270405`.

**5b. Point your number at the SWML handler**
- SignalWire → **Phone Numbers** → **845-604-2025** → **Edit Settings**.
- Under **Voice and Fax** → **Handle Calls Using:** choose **a SWML Script**.
- Check **"Use External URL for SWML Script handler?"**
- **External URL:** `https://linear-ivr.friedmanchaimhersh.workers.dev/swml/voice`
  (POST). **Save.**

**5c. Open the app and stay signed in**
- Go to **https://linearit.co/phone**, log in, allow the mic. The status pill
  should read **Online**.
- Call your number from another phone: your browser rings for ~18s. If you don't
  pick up, it rings your Google Voice (+19177270405) for ~25s, which has its own
  voicemail.

> The old `/ivr` cXML webhook still works as a safe fallback (greeting → Google
> Voice). Switching the number to `/swml/voice` in 5b is what turns on browser
> ringing.

---

## Install it like an app (iPad / iPhone)

Open **https://linearit.co/phone** in Safari → **Share** → **Add to Home
Screen**. It launches full-screen like a native app (PWA). The same web app is
the foundation for a future React-Native/Capacitor mobile build.

## Troubleshooting

- **Status stays Offline / a red error toast appears:** the Subscriber token
  couldn't be minted — check `SIGNALWIRE_SPACE`, `SIGNALWIRE_PROJECT`,
  `SIGNALWIRE_TOKEN`, and that the **Subscriber** (step 5a) exists and matches
  `SUBSCRIBER_REFERENCE`. The on-screen toast shows the exact reason.
- **Browser doesn't ring, calls go straight to Google Voice:** the number isn't
  pointed at `/swml/voice` yet (step 5b), or the app isn't open/Online.
- **Texts send but don't appear inbound:** confirm the **Message Comes In**
  webhook points to `/sms/inbound` and the D1 `DB` binding is attached.
- **Login fails:** `APP_PASSWORD` mismatch, or `AUTH_SECRET` not set.
- **Calls won't dial:** mic permission must be granted, and the page must be
  HTTPS (it is, on `linearit.co`).

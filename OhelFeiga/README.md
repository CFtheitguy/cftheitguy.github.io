# 📣 Ohel Feiga Alerts — mass text messages to the whole congregation

A tiny, self-hosted system to text all ~800 members about zmanim changes, events,
and announcements. Built for **basic (non-smartphone) phones** — it sends real SMS,
so it works on any phone that receives texts. Completely separate from the Linear
Phone project (its own number, its own database).

**What it costs:** ~**1¢ per text** (the carrier's cut) — about **$8 to reach all 800
once**. The software and hosting are **free** (Cloudflare's free tier). No monthly
software fee.

```
  Admin page (OhelFeiga/index.html, on your site)
        │  password login
        ▼
  Cloudflare Worker  ──►  SignalWire  ──►  members' phones (SMS)
        │
        ▼
  D1 database (subscriber list + send history)
```

---

## What you need (one-time)

1. A **Cloudflare** account (free) — hosts the worker + database.
2. A **SignalWire** account — sends the texts. (Cheapest tier-1 provider, ~1¢/text.
   You can swap in Telnyx/Twilio later by editing one function — see the bottom.)
3. **A phone number to send from**, registered so carriers don't block you (below).

> ⚠️ **The one rule that makes or breaks this:** US carriers block "one number →
> hundreds of people" texting unless the number is **registered**. If you skip this,
> most of your 800 texts silently never arrive. Two ways to register:
>
> - **Toll-free number + verification (recommended, easiest):** Buy a toll-free
>   number in SignalWire, submit the free **toll-free verification** form. No monthly
>   campaign fee, plenty fast for 800. Best fit for a shul.
> - **Local 10DLC number + charity registration:** A local number, lowest per-text
>   cost, small monthly fee — but register your shul as a **nonprofit / 501(c)(3)**
>   for reduced fees and easier approval.
>
> Either way, **consent matters**: only text people who agreed to receive texts. Keep
> a record (a sign-up sheet, a form, a reply). The system auto-honors **STOP**.

---

## Setup (≈30 min, all from the dashboard — no command line needed)

### 1. Create the database
Cloudflare dashboard → **Workers & Pages → D1 → Create database** → name it
`ohelfeiga`. Open it → **Console** tab → paste the contents of
[`worker/schema.sql`](worker/schema.sql) → **Execute**.

### 2. Create the worker
**Workers & Pages → Create → Worker** → name it `ohelfeiga-alerts` → Deploy → **Edit code**.
Delete the sample, paste all of [`worker/src/index.js`](worker/src/index.js) → **Deploy**.

### 3. Bind the database
Worker → **Settings → Bindings → Add → D1 database**.
Variable name: `DB` → database: `ohelfeiga` → Save.

### 4. Add your settings (Settings → Variables and Secrets)
Add each of these (use **Encrypt** for the token/password/secret):

| Name | Value |
|---|---|
| `SIGNALWIRE_SPACE` | `yourspace.signalwire.com` |
| `SIGNALWIRE_PROJECT` | your Project ID |
| `SIGNALWIRE_TOKEN` | a SignalWire API token (encrypt) |
| `SIGNALWIRE_NUMBER` | your registered FROM number, e.g. `+18005551234` |
| `APP_PASSWORD` | a password you'll type to log in (encrypt) |
| `AUTH_SECRET` | a long random string (encrypt) |
| `ALLOW_ORIGIN` | your site, e.g. `https://www.linearit.co` |
| `SMS_FOOTER` *(optional)* | e.g. ` Reply STOP to opt out.` |
| `BATCH_SIZE` *(optional)* | recipients per batch, default `25` (keep ≤ 45) |

Re-deploy after saving. Visit `https://ohelfeiga-alerts.YOURNAME.workers.dev/` — it
should say **"Ohel Feiga Alerts online"**.

### 5. Point inbound texts at the worker (for STOP handling)
SignalWire → your number → **Inbound SMS** → set the webhook to
`https://ohelfeiga-alerts.YOURNAME.workers.dev/sms/inbound` (POST).

### 6. Use it
Open **`https://www.linearit.co/OhelFeiga/`** (`OhelFeiga/index.html`). Enter the
worker URL + your `APP_PASSWORD`. Then:
- **Subscribers → Import** — paste numbers (one per line; `Name, number` also works)
  or load a `.csv`/`.txt`. Re-importing is safe; duplicates merge.
- **Send a message to everyone** — type it, check the recipient count, send. A
  progress bar fills as the batches go out.

---

## Costs at a glance

| | |
|---|---|
| Per text | ~$0.008 message + ~$0.003 carrier ≈ **~1¢** |
| One blast to 800 | **~$8** (short message = 1 text each) |
| 2 blasts/week | **~$65/month** |
| Cloudflare (worker + D1) | **$0** on the free tier |
| Toll-free verification | **$0** |
| Long messages | over 160 chars (or any Hebrew) splits into multiple texts — the
compose box shows how many. Keep notices short to stay at 1 text each. |

---

## How sending stays reliable (and free to host)

An 800-person blast is split into small batches (default 25). The admin page asks
the worker to send one batch at a time until everyone's done, so a single send never
trips Cloudflare's free-plan limits and you get a live progress bar. Failures are
recorded per-recipient (visible in the count) and never block the rest.

## Legal / good-practice notes
- **Consent:** only import people who agreed to be texted. Keep proof.
- **STOP:** anyone who replies STOP is opted out automatically and skipped on every
  future send. START opts them back in. (Carriers also enforce this at the network
  level for registered numbers.)
- **Identify yourself & keep it relevant:** include the shul name; send zmanim/events,
  not ads.

## Swapping SMS providers
Only one function talks to SignalWire: `providerSend()` in `worker/src/index.js`.
To use Telnyx/Twilio/etc., rewrite that function's body and adjust the secrets —
nothing else changes.

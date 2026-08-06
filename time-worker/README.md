# `linear-time` — Cloudflare Worker for `time.linearit.co`

The backend for **Linear Time**, the time tracker. It stores companies, workers
and every time entry in a **D1** database, signs everyone in with a one-time
email code (via Resend, the same account chat/vault use), and reverse-proxies the
app (hosted in this repo at `/time/`, live at `https://www.linearit.co/time/`) so
it also answers at the vanity domain **time.linearit.co**.

This Worker is **completely separate** from `linear-chat`, `linear-vault` and
`linear-device`: its own folder, its own `wrangler.toml`, no shared bindings. It
cannot affect the other subdomains.

---

## One-time setup (run from this folder)

You must be logged into the **same Cloudflare account** that owns `linearit.co`.

```bash
cd time-worker
npm install
npx wrangler login          # once per machine (skip if already logged in)

# 1) Create the database, then paste the printed id into wrangler.toml -> database_id
npx wrangler d1 create linear_time

# 2) Set the encrypted secrets (they survive every deploy)
npx wrangler secret put AUTH_SECRET      # any long random string, >= 32 chars
npx wrangler secret put RESEND_API_KEY   # the same Resend key chat/vault use
npx wrangler secret put EMAIL_FROM       # ->  Linear IT <alert@linearit.co>
npx wrangler secret put ADMIN_EMAILS     # your super-admin email(s), comma-separated

# 3) Deploy
npx wrangler deploy
```

That single `deploy`:

1. Uploads the `linear-time` Worker.
2. Because `wrangler.toml` has `{ pattern = "time.linearit.co", custom_domain = true }`,
   it **creates the `time.linearit.co` Custom Domain and its DNS record**
   automatically in the `linearit.co` zone.
3. The database tables **create themselves on the first request** — no schema step.

Give Cloudflare a minute to issue the edge certificate, then open
**https://time.linearit.co**.

> Validate without deploying: `npx wrangler deploy --dry-run`.

### A quick generator for `AUTH_SECRET`
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Optional — hands-off auto-deploy (like the chat Worker)

Redeploy on every `git push` by adding a **second** Workers Build project:

1. Cloudflare → **Workers & Pages → Create → Workers → Connect to Git**.
2. Repo **`CFtheitguy/cftheitguy.github.io`**, your production branch.
3. **Root directory: `time-worker`** (keeps it separate from the other Workers).
4. Deploy command: `npx wrangler deploy`. Build command: empty.
5. Save. Now pushes that touch `time-worker/` redeploy the API automatically.

The **front-end** (`/time/`) is served by GitHub Pages, so a change to
`time/index.html`, `time/app.js`, etc. goes live on push with **no Worker
redeploy** — the Worker just proxies the latest copy.

---

## Roles (who can sign in)

| Role | How they're granted | What they see |
|---|---|---|
| **Super admin** | email listed in the `ADMIN_EMAILS` secret | every company, plus company/admin management |
| **Company admin** | a super admin appoints them (Reports app → Admins tab) | reports for their one company |
| **Worker** | signs in with email + their company's join code | their own day tracker |

Sign-in is always email + a 6-digit code. There are no passwords to manage.

---

## Environment

| Name | Where | Purpose |
|---|---|---|
| `DB` | binding (wrangler.toml) | D1 database |
| `AUTH_SECRET` | **secret** | peppers code/token hashes; signs sessions |
| `RESEND_API_KEY` | **secret** | sends the sign-in code email |
| `EMAIL_FROM` | **secret** | From: address, e.g. `Linear IT <alert@linearit.co>` |
| `ADMIN_EMAILS` | **secret** | comma-separated super-admin addresses |
| `VAPID_PUBLIC` / `VAPID_PRIVATE_JWK` / `VAPID_SUBJECT` | **secret** *(optional)* | Web Push keys for background reminders (`node gen-vapid.mjs`) |
| `ALLOW_ORIGIN` / `APP_ORIGIN` / `APP_PATH` | `[vars]` | CORS + where to proxy the app from |
| `DEV_MODE=1` | var (local only) | returns the code in the API response for testing |

## Background reminders (Cron Trigger + Web Push)
`wrangler.toml` schedules the Worker every 5 minutes (`[triggers] crons`). On each
run the `scheduled()` handler finds workers who are due for a 30-minute check-in or
the after-5pm wrap-up and sends them a **payload-less Web Push**; their service
worker then asks `/api/push/pending` what to show. This is what makes reminders
arrive when the app window is closed. It only fires if the `VAPID_*` secrets are
set — otherwise the cron is a no-op and reminders stay in-app only.

Generate the keys once with `node gen-vapid.mjs` and set the three printed values
as secrets. Rotating them just makes every browser re-subscribe on next open.

## Local development
```bash
npx wrangler dev            # http://localhost:8787
# set DEV_MODE=1 in .dev.vars to skip real emails and get the code back in the response
# test the cron locally:  curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Rollback
Cloudflare → `linear-time` → **Deployments** → pick a previous version → **Rollback**.

## Data model (auto-created)
`companies(id, name, code, created_at)` ·
`admins(email, company_id, …)` ·
`workers(email, name, company_id, tz_offset, …)` ·
`entries(id, email, company_id, day, task, preset, started_at, ended_at, checkin_at, …)` ·
`day_end(email, day, ended_at)` · `push_subs(email, endpoint, sub, tz_offset, …)` ·
`login_codes(…)`

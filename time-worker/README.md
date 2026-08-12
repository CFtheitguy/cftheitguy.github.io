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
| `TWILIO_AUTH_TOKEN` | **secret** *(optional, paid number only)* | verifies the inbound SMS webhook signature |
| `SMS_INTAKE_SECRET` | **secret** *(optional, paid number only)* | shared secret for a non-Twilio SMS provider |
| `SMS_NUMBER` | `[vars]` *(optional)* | the number people text, shown in the app (E.164). Leave blank to use the free text-to-email route. |
| `SMS_WEBHOOK_URL` | `[vars]` *(rare)* | override the URL used for signature checks |
| `TODO_EMAIL` | `[vars]` | the intake address the app tells people to use |
| `DEV_MODE=1` | var (local only) | returns the code in the API response for testing |

---

## Linear To-Do — setup

The to-do list works the moment you deploy: it shares this Worker's D1 database,
sign-in and push setup, and its tables create themselves like the rest.

**Nothing below costs money.** The personal quick-add link works immediately with
no configuration at all, and email — including text messages sent to
`task@linearit.co` through a carrier gateway — needs one Email Routing rule. A
dedicated SMS number is the only paid option, and it's entirely optional.

| Door | What it costs | What it needs |
|---|---|---|
| Quick-add link (phone shortcut / Siri) | free | nothing — already live |
| Email to `task@linearit.co` | free | one Email Routing rule |
| Text sent to that address (carrier gateway) | free | the same rule |
| Text sent to a real phone number | ~$1–2/mo + per message | an SMS provider + secret |

### Quick-add link (nothing to set up)

`GET|POST /api/todo/quick?key=…&text=…` adds a task and answers in plain text
(add `&format=json` for JSON). Each person's key is generated on first use and
shown in the app under **To-Do → Settings**, where they can also rotate it. The
key is the credential, so no session is needed — which is what lets an iOS
Shortcut, a Siri phrase, an Android HTTP shortcut or a watch button add a task in
one tap. It accepts the same commands the text door does (`LIST`, `DONE 2`,
`HELP`).

### Tasks by email (`task@linearit.co`)

Cloudflare **Email Routing** delivers the message straight to this Worker — there
is no mailbox and no polling.

1. Cloudflare dashboard → the **linearit.co** zone → **Email → Email Routing**.
   If it's not on yet, enable it and accept the MX/TXT records it adds.
2. **Routing rules → Create address**
   - Custom address: **`task`** (`@linearit.co`)
   - Action: **Send to a Worker** → **`linear-time`**
3. Save. Mail to `task@linearit.co` now becomes a task.
4. *(Optional, for `task+groceries@…` list routing to work from every sender)* —
   plus-addressing is handled by the Worker, but some rule sets don't match a
   `+tag` address. If yours doesn't, add a **catch-all** rule sending to the same
   Worker; the Worker ignores anything addressed to something other than `task`.

The address the app *tells people to use* comes from the `TODO_EMAIL` var in
`wrangler.toml` — change both together if you use a different name.

**Who's allowed to send.** The From: address must belong to a known person (their
sign-in address, or an extra address they added under To-Do → Settings) and the
message must not fail SPF/DMARC. Anything else is rejected at SMTP time with a
reason, so the sender finds out rather than wondering where the task went.

### Tasks by text message — the free way

Once the Email Routing rule above exists, **texting already works** and there is
nothing more to configure.

Most US carriers let a handset send a text to an email address: you put
`task@linearit.co` in the To: field of an ordinary text. It reaches this Worker
as mail from `<number>@<carrier gateway>` — `8455550123@vtext.com` and friends —
so `intake.js` treats it as a text rather than an email: the body is the task,
and the answer is mailed back to that same gateway address, which the carrier
delivers to the handset **as a reply text**. Two-way texting, no provider.

Ownership comes from the number in that From address, which the *carrier* writes
(and the mail still has to pass SPF/DMARC). It's matched against the number the
person saved under **To-Do → Settings**; a text from any unregistered number
creates nothing. Because there's no number of ours to text a code to, saving the
number doesn't require a code — claiming someone else's gains nothing, since no
mail is routed anywhere, and numbers stay unique across accounts.

Known gateway domains are listed in `CARRIER_GATEWAYS` in `src/intake.js`; add
more there if your people are on a carrier that isn't covered.

> Carrier support varies and has been shrinking — Verizon (`vtext.com`) and
> T-Mobile (`tmomail.net`) are reliable, others less so. The quick-add link is
> the fallback that works on every phone, on any carrier, worldwide.

### Tasks by text message — with a real number (optional, costs money)

Only needed if you want people texting an actual phone number. Point the
provider's inbound webhook at:

```
https://time.linearit.co/api/sms/inbound
```

**With Twilio** (~$1.15/month for the number plus a fraction of a cent per
message):

1. Twilio Console → **Phone Numbers → your number → Messaging**.
2. *A message comes in* → **Webhook**, **HTTP POST**, the URL above.
3. Set the auth token as a secret so the signature is verified:
   ```bash
   npx wrangler secret put TWILIO_AUTH_TOKEN
   ```
4. Put the number in `wrangler.toml` as `SMS_NUMBER` (E.164, e.g. `+18456041462`)
   so the app can tell people where to text, and deploy.

**With any other provider**, set a shared secret instead and include it as
`?secret=…` or an `X-Intake-Secret` header on the webhook:

```bash
npx wrangler secret put SMS_INTAKE_SECRET
```

The endpoint answers Twilio-style form posts with TwiML, and JSON posts
(`{"from":"+1…","body":"…"}`) with `{"reply":"…"}`.

> **The endpoint is closed until one of those two secrets exists.** Without
> `TWILIO_AUTH_TOKEN` or `SMS_INTAKE_SECRET` every request gets a 401 — an
> unauthenticated task inbox isn't a useful default.

Once a real number *is* configured, number linking upgrades to a proper proof of
ownership: the app shows a short code and the person texts it in from the handset
they want to link.

### Calendar feed

`GET /api/todo/feed.ics?key=…` returns dated tasks as iCalendar. The key is
per-person, generated on first use, and shown in the app under To-Do → Settings.
No session is needed — the key *is* the credential — so it's safe to paste into
Outlook/Google, and rotating it means clearing `feed_key` for that row.

---

## Background reminders (Cron Trigger + Web Push)
`wrangler.toml` schedules the Worker **every minute** (`[triggers] crons`). On each
run the `scheduled()` handler finds who is due for a 30-minute check-in, the
after-5pm wrap-up, or a **to-do reminder**, and sends them a **payload-less Web
Push**; their service worker then asks `/api/push/pending` what to show. This is
what makes reminders arrive when the app window is closed. It only fires if the
`VAPID_*` secrets are set — otherwise the cron is a no-op and reminders stay
in-app only.

It runs every minute rather than every five so a task reminder set for 3:00
arrives at 3:00. That doesn't make the tracker's nudges chattier: those are
throttled per company by the nudge interval, independent of the cron. A to-do
reminder is marked fired the moment it's pushed, so it goes out once, and stays
readable for ten minutes afterwards so the service worker can still fetch what to
display after the push wakes it.

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

**Time tracker**
`companies(id, name, code, created_at)` ·
`admins(email, company_id, …)` ·
`workers(email, name, company_id, tz_offset, …)` ·
`entries(id, email, company_id, day, task, preset, started_at, ended_at, checkin_at, …)` ·
`day_end(email, day, ended_at)` · `push_subs(email, endpoint, sub, tz_offset, …)` ·
`login_codes(…)`

**To-Do**
`todo_lists(id, email, name, emoji, color, position, …)` ·
`todos(id, email, list_id, title, notes, due_at, due_all_day, remind_at, reminded_at, priority, important, myday, repeat_json, tags, status, completed_at, source, …)` ·
`todo_steps(id, todo_id, email, title, done, position, …)` ·
`todo_prefs(email, tz_offset, default_list, phone, phone_pending, phone_code, alt_emails, feed_key, quick_key, intake_receipt, …)`

Everything is keyed by **email**, not by role — so the same person keeps one list
whether they sign in as a worker or an admin.

## Source layout
| File | What's in it |
|---|---|
| `src/index.js` | HTTP router, sign-in, the time tracker, cron, app reverse-proxy, `email()` |
| `src/todos.js` | to-do schema, CRUD, smart-view counts, recurrence, reminders, ICS feed |
| `src/intake.js` | inbound email (MIME parsing, sender auth) and the SMS webhook |
| `src/parse.js` | the natural-language quick-add parser, shared by all three doors |

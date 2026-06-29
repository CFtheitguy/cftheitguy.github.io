# Linear Chat — `chat.linearit.co`

A small team group-chat app. **One Cloudflare Worker is the whole thing** — it
serves the web app *and* the API, backed by a D1 database.

- **Sign in with email + an MFA code** (a 6-digit one-time code is emailed; no
  passwords).
- **Admins** create groups and add/remove members by email.
- **Members** sign in and chat with their teammates in real time (polling).

```
chat.linearit.co  →  linear-chat Worker  →  D1 (users, groups, members, messages)
   the web app          UI + API + MFA          +  email provider (codes)
```

## Files
- `src/index.js` — the entire Worker (UI + API). Paste into Cloudflare → `linear-chat` → Edit code.
- `schema.sql` — D1 tables. Run once, or let the Worker self-heal (it creates them on first request).
- `DEPLOY.md` — step-by-step setup (works from an iPad, dashboard only).

## Deploy
See **[`DEPLOY.md`](./DEPLOY.md)**. Short version:
1. Create a D1 database `linear_chat` and run `schema.sql`.
2. Create a Worker `linear-chat`, paste `src/index.js`, bind D1 as `DB`.
3. Add the secrets below, then add the custom domain `chat.linearit.co`.

## Configuration

| Name | Required | Purpose |
|---|---|---|
| `DB` (binding) | ✅ | D1 database. |
| `AUTH_SECRET` | ✅ | Long random string. Signs session tokens and hashes login codes. |
| `ADMIN_EMAILS` | recommended | Comma/space-separated emails allowed to **create groups**. If empty, the first person to sign in becomes the admin (bootstrap). |
| `EMAIL_FROM` | recommended | `From:` address, e.g. `Linear Chat <chat@linearit.co>`. |
| `RESEND_API_KEY` | one email option | Send codes via [Resend](https://resend.com). |
| `EMAIL_WEBHOOK_URL` | one email option | POST `{to,subject,text,html,from}` to a webhook (e.g. a Power Automate flow that sends from Outlook 365). |
| `DEV_MODE` | optional | `"1"` returns the code in the API response so you can test without email. **Turn off in production.** |
| `RESTRICT_TO_MEMBERS` | optional | `"1"` only lets known admins/members request a code (locks out strangers). |
| `ALLOW_ORIGIN` | optional | CORS origin for the API. The bundled app is same-origin, so usually unneeded. |

> **Email is required for real use.** Set **either** `RESEND_API_KEY` **or**
> `EMAIL_WEBHOOK_URL`. Since Linear IT runs on Microsoft 365, the
> `EMAIL_WEBHOOK_URL` → Power Automate → Outlook route reuses the same pattern
> already used for inbound SMS. `DEV_MODE` lets you try everything first with no
> email at all.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | — | The chat web app |
| GET | `/health` | — | Health check |
| POST | `/api/auth/request` | — | `{email}` → email a one-time code |
| POST | `/api/auth/verify` | — | `{email, code}` → `{token, user}` |
| GET | `/api/me` | Bearer | Current user |
| POST | `/api/me` | Bearer | `{name}` → set display name |
| GET | `/api/groups` | Bearer | Groups you belong to |
| POST | `/api/groups` | Bearer (admin) | `{name}` → create a group |
| GET | `/api/groups/{id}/members` | Bearer (member) | List members |
| POST | `/api/groups/{id}/members` | Bearer (group admin) | `{email}` → add a member |
| POST | `/api/groups/{id}/members/remove` | Bearer (group admin) | `{email}` → remove a member |
| GET | `/api/groups/{id}/messages?after={id}` | Bearer (member) | Messages (poll with `after`) |
| POST | `/api/groups/{id}/messages` | Bearer (member) | `{body}` → post a message |

Sessions are stateless HMAC-signed bearer tokens (30-day expiry) — no cookies,
so it works cleanly on Safari/iPad.

## Security notes
- Login codes are 6 digits, **hashed** before storage, expire in 10 minutes,
  allow 5 attempts, are single-use, and old codes are invalidated when a new one
  is sent. There's a 45-second resend cooldown.
- Group create/add/remove permissions are re-checked against the database on
  every request (not just trusted from the token).
- Message bodies are rendered with `textContent` in the browser (no HTML
  injection).

## Possible upgrades
- Swap polling for WebSockets via a Cloudflare **Durable Object** per group for
  instant delivery and presence.
- Read receipts / unread counts, file attachments (R2), push notifications.

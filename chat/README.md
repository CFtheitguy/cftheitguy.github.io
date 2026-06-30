# Linear Chat — `chat.linearit.co`

A small team group-chat app. **One Cloudflare Worker is the whole thing** — it
serves the web app *and* the API, backed by a D1 database.

- **Sign in with email + an MFA code** (a 6-digit one-time code is emailed; no
  passwords).
- **Admins** create groups and add/remove members by email.
- **Members** sign in and chat with their teammates in real time (polling).
- **Threaded replies** (Slack-style, single level), **emoji reactions**, and
  **file attachments** (images preview inline; everything else downloads).
- **Voice & video calls** — a Start-call button posts a "Join" card to the
  group and opens a room. Uses Jitsi today; the provider is swappable (a future
  Cloudflare Realtime SFU is a config change, not a rewrite).

```
chat.linearit.co  →  linear-chat Worker  →  D1 (users, groups, members, messages, reactions)
   the web app          UI + API + MFA          R2 (file attachments, optional)
                                                 email provider (login codes)
                                                 Jitsi (call rooms)
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
| `FILES` (binding) | for attachments | R2 bucket. Bind it to enable file uploads. Without it, chat still works; the attach button is hidden. |
| `AUTH_SECRET` | ✅ | Long random string. Signs session tokens, hashes login codes, and signs attachment links. |
| `MAX_UPLOAD_MB` | optional | Max attachment size in MB (default 20). |
| `JITSI_DOMAIN` | optional | Domain that hosts the call rooms (default `meet.jit.si`). Point it at a self-hosted Jitsi / 8x8 JaaS for private media. |
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
| GET | `/api/groups/{id}/messages?after={id}` | Bearer (member) | Top-level messages (poll with `after`) |
| POST | `/api/groups/{id}/messages` | Bearer (member) | Post a message. JSON `{body, parent_id?}` or `multipart/form-data` with `body`, optional `parent_id`, and `files` |
| GET | `/api/groups/{id}/messages/{mid}/thread?after={id}` | Bearer (member) | A message's thread (parent + replies) |
| POST | `/api/groups/{id}/badges` | Bearer (member) | `{ids:[…]}` → live reaction + reply counts for visible messages |
| POST | `/api/messages/{mid}/react` | Bearer (member) | `{emoji}` → toggle a reaction |
| POST | `/api/groups/{id}/call` | Bearer (member) | `{mode:'audio'|'video'}` → start a call; posts a Join card |
| GET | `/api/files/{id}?e=&t=` | signed link | Stream an attachment from R2 (time-limited HMAC link) |
| GET | `/api/config` | — | Client config (attachments enabled, max upload, emoji set) |

Sessions are stateless HMAC-signed bearer tokens (30-day expiry) — no cookies,
so it works cleanly on Safari/iPad. Each message returned by the API is enriched
with its `reactions`, `attachments`, and `reply_count`.

## Security notes
- Login codes are 6 digits, **hashed** before storage, expire in 10 minutes,
  allow 5 attempts, are single-use, and old codes are invalidated when a new one
  is sent. There's a 45-second resend cooldown.
- Group create/add/remove permissions are re-checked against the database on
  every request (not just trusted from the token).
- Message bodies and filenames are rendered with `textContent` in the browser
  (no HTML injection).
- Attachments are served only via **short-lived HMAC-signed links** (24h) and
  the upload/serve paths re-check group membership. Uploads are size-capped
  (`MAX_UPLOAD_MB`, default 20) and limited to 10 files per message.

## Calls
- A 📞/🎥 button in the group header starts a voice or video call. The Worker
  creates a message of `kind:'call'` with an unguessable room name and posts it
  as a **Join** card so other members can hop in.
- The room is opened with the Jitsi embed (`JitsiMeetExternalAPI`) in a
  full-screen overlay; "Leave call" closes it. Audio mode just starts with
  video muted.
- **Swapping providers later:** the room/provider lives in the message `meta`
  and the domain comes from `JITSI_DOMAIN`. To move to your own Cloudflare
  Realtime SFU, change `startCall` (server) and the call overlay (client) to
  that provider — the schema, call card, and group plumbing stay the same.
- **Privacy:** with the default `meet.jit.si`, call media flows through 8x8's
  public servers. For private media, set `JITSI_DOMAIN` to a self-hosted Jitsi
  (or move to Cloudflare Realtime).

## Possible upgrades
- Self-hosted Jitsi / Cloudflare Realtime SFU for in-house call media.
- Swap polling for WebSockets via a Cloudflare **Durable Object** per group for
  instant delivery and presence.
- Read receipts / unread counts, push notifications.

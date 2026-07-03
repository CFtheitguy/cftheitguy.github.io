# Linear Chat — `chat.linearit.co`

A small team group-chat app. **One Cloudflare Worker is the whole thing** — it
serves the web app *and* the API, backed by a D1 database.

- **Sign in with email + an MFA code** (a 6-digit one-time code is emailed; no
  passwords).
- **Admins** create groups and add/remove members by email.
- **Members** sign in and chat with their teammates in real time (polling).
- **Threaded replies** (Slack-style, single level), **emoji reactions**, and
  **file attachments** (images preview inline; everything else downloads).
- **Voice notes** — record from the mic (🎤) and send as an audio message that
  plays inline. Stored as an R2 attachment; no extra services.
- **Voice & video calls** — a Start-call button posts a "Join" card to the
  group and opens a room. Uses Jitsi today; the provider is swappable (a future
  Cloudflare Realtime SFU is a config change, not a rewrite).
- **Link previews** — URLs become clickable, and YouTube (click-to-play),
  Vimeo, image, video, and audio links render inline. Done client-side (no
  server fetch), so there's no SSRF surface.
- **Edit & delete your own messages** — delete is enforced server-side to the
  author only (you can't delete anyone else's); deleted messages show a
  tombstone, edited ones show an "edited" tag.
- **Unread badges** — per-group unread counts in the sidebar (tracked per user).
- **Full emoji picker** — react with (or type) any emoji, not a fixed few.
- **Per-user theme color** — each person picks an accent color (Account →
  App color); it follows them across devices.
- **Chat wallpaper & messenger look** — WhatsApp/Telegram/Signal-style message
  area: tailed bubbles (yours accent-colored, theirs white), Telegram-style
  colored sender names in groups, "Today/Yesterday" date separators, and a
  per-user **chat background** picker (Account → Chat background) with a doodle
  pattern, gradients, solids, and a dark option. The background follows you
  across devices.
- **Installable (PWA)** — "Add to Home Screen" for a full-screen app icon
  (served `/manifest.webmanifest` + `/sw.js`).
- **Markdown** — `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and fenced
  code blocks, rendered safely (built as DOM nodes, never innerHTML).
- **@mentions** — type `@` for a member autocomplete; mentions are stored,
  highlighted, and the message is ringed for the person mentioned.
- **Pinned messages** — any member can pin/unpin; a 📌 in the header opens the
  pinned list for the group.
- **Direct messages (1:1)** — a "Direct Messages" section in the sidebar; start
  one from the people you share a group with. DMs are private 2-person
  conversations with all the same features (threads, calls, files…).
- **Avatars & group icons** — upload a profile photo (Account → Change photo)
  and a group photo (admin). Shown in the sidebar, message list, and members;
  a colored initials circle is the fallback. Stored in R2, served via
  short-lived signed links.
- **Push notifications** — turn them on per device (Account → Notifications) to
  get alerts for new messages, DMs, and @mentions even when the app is closed.
  Real Web Push (VAPID + RFC 8291 payload encryption) done entirely in the
  Worker — no third-party push service and no keys to manage (they
  auto-generate). The OS banner is suppressed while the app is open and
  focused; @mentions and DMs are high-priority. On iPhone/iPad, "Add to Home
  Screen" first (an Apple requirement for web push).

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
| `VAPID_PUBLIC_KEY` | optional | Web Push public key (base64url, 65-byte P-256 point). If unset, a keypair is generated once and stored in D1 (`app_kv`). Set this only to bring your own keys. |
| `VAPID_PRIVATE_KEY` | optional | Web Push private key (base64url `d`). Pair with `VAPID_PUBLIC_KEY`. |
| `VAPID_SUBJECT` | optional | `mailto:` (or `https:`) contact for push services. Defaults to the `EMAIL_FROM` address, else `mailto:admin@linearit.co`. |

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
| GET | `/api/push/key` | Bearer | `{enabled, key}` → the VAPID public key for `pushManager.subscribe` |
| POST | `/api/push/subscribe` | Bearer | `{endpoint, keys:{p256dh, auth}}` → save this device's push subscription |
| POST | `/api/push/unsubscribe` | Bearer | `{endpoint}` → remove this device's subscription |
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
- Push payloads are **end-to-end encrypted per RFC 8291** (ECDH → HKDF →
  AES-128-GCM) with a fresh ephemeral key per message, and each request is
  authorized with a short-lived **VAPID** JWT (ES256). The push service only
  ever sees ciphertext. Only a group's own members are ever notified, and dead
  subscriptions are pruned automatically (HTTP 404/410).

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

## Notifications
- **Turn on per device:** Account → Notifications → *Turn on*. The browser asks
  permission, then this device subscribes; the button flips to *Turn off*.
- **What fires one:** a new message, reply, DM, or @mention sent by someone else
  in a group you belong to. @mentions and DMs are sent high-priority.
- **When it's quiet:** if the app is open and focused, the service worker skips
  the OS banner (it just nudges the page). Banners only show when the app is
  closed or in the background.
- **iPhone/iPad:** Apple only allows web push for **installed** web apps — use
  Share → *Add to Home Screen*, open it from the icon, then turn on
  notifications. Desktop Chrome/Edge/Firefox and Android Chrome work directly.
- **Keys:** the VAPID keypair auto-generates on first use and is stored in D1
  (`app_kv`) so it survives deploys. Override with `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` secrets if you'd rather manage your own.

## Possible upgrades
- Self-hosted Jitsi / Cloudflare Realtime SFU for in-house call media.
- Swap polling for WebSockets via a Cloudflare **Durable Object** per group for
  instant delivery and presence.
- Read receipts, message search, and richer notification preferences
  (per-group mute, mentions-only).

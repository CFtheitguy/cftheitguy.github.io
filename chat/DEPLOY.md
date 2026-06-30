# Linear Chat — Setup Guide

A team group-chat at **https://chat.linearit.co**. Sign in with your email,
get a one-time code, and chat with your group — with threaded replies, emoji
reactions, file attachments, and voice/video calls. Admins create groups and
add members.

Everything below can be done from an iPad in the **Cloudflare dashboard** — no
command line.

---

## What you're setting up

```
chat.linearit.co   →   linear-chat Worker   →   D1 database (chat data)
   the web app            UI + API + MFA          R2 bucket (attachments, optional)
                                │
                                └──→  email provider (sends the login codes)
```

Four steps:
1. Create a **D1 database** (stores users, groups, members, messages, reactions).
2. Create the **Worker**, paste the code, add bindings (D1 + optional R2) and **secrets**.
3. Pick how login-code **emails** are sent.
4. Add the **custom domain** `chat.linearit.co` and you're live.

---

## 1) Create the D1 database

1. Cloudflare dashboard → **Workers & Pages** → **D1 SQL Database** → **Create**.
2. Name it `linear_chat` → **Create**.
3. Open it → **Console** tab → paste the entire contents of
   [`schema.sql`](./schema.sql) → **Execute**.
   *(Optional — the Worker also creates these tables automatically on first use.)*

## 2) Create the Worker

1. Cloudflare → **Workers & Pages** → **Create application** → **Create Worker**.
   Name it `linear-chat` → **Deploy** (the placeholder code is fine for now).
2. Open it → **Edit code**. Select all, delete, and paste the entire contents of
   [`src/index.js`](./src/index.js). **Save & Deploy**.
3. **Settings → Bindings** → **Add → D1 database**:
   - **Variable name:** `DB`
   - **D1 database:** `linear_chat` → **Save**.
4. **(For attachments) Add an R2 bucket** — skip if you don't need file uploads:
   - Cloudflare → **R2** → **Create bucket** → name it `linear-chat-files` → **Create**.
   - Back in the worker → **Settings → Bindings** → **Add → R2 bucket**:
     **Variable name:** `FILES` · **Bucket:** `linear-chat-files` → **Save**.
   - Without this binding, chat still works — the 📎 attach button is just hidden.
5. **Settings → Variables and Secrets** → add these (use **Encrypt** for secrets):

   | Name | Value |
   |---|---|
   | `AUTH_SECRET` | a long random string (mash the keyboard) |
   | `ADMIN_EMAILS` | emails that may create groups, e.g. `you@linearit.co, ops@linearit.co` |
   | `EMAIL_FROM` | `Linear Chat <chat@linearit.co>` |
   | `MAX_UPLOAD_MB` | *(optional)* max attachment size, default `20` |
   | `JITSI_DOMAIN` | *(optional)* call-room host, default `meet.jit.si` |

   > If you leave `ADMIN_EMAILS` blank, the **first person to sign in becomes the
   > admin** — handy for a quick start, but setting it is safer.

   > **Voice & video calls work out of the box** — no account or key needed.
   > They use `meet.jit.si` by default, which means call media flows through
   > Jitsi's public servers. For private media later, set `JITSI_DOMAIN` to a
   > self-hosted Jitsi (or we move to a Cloudflare Realtime SFU).

## 3) Choose how codes are emailed

Pick **one**. (Skip this only for a quick test — see "Test without email" below.)

### Option A — Power Automate → Outlook 365 *(recommended; you already use this pattern)*
1. In **Power Automate**, create a flow: **When an HTTP request is received**
   (it generates a URL). Add a **Send an email (V2)** action (Outlook).
2. Map the body fields the Worker sends — JSON `{ to, subject, text, html, from }`:
   - **To:** `to`  ·  **Subject:** `subject`  ·  **Body:** `html` (or `text`).
3. Save, copy the generated **HTTP POST URL**.
4. Back in the Worker → **Variables and Secrets** → add (Encrypt):
   | Name | Value |
   |---|---|
   | `EMAIL_WEBHOOK_URL` | the Power Automate HTTP URL |

### Option B — Resend
1. Create an account at **resend.com**, verify your sending domain, make an API key.
2. Worker → **Variables and Secrets** → add (Encrypt):
   | Name | Value |
   |---|---|
   | `RESEND_API_KEY` | your Resend API key |

   Make sure `EMAIL_FROM` uses your verified domain.

### Test without email (optional)
Add a variable `DEV_MODE` = `1`. The login screen will then **show the code on
screen** instead of emailing it, so you can try the whole app immediately.
**Remove `DEV_MODE` before real use.**

## 4) Add the custom domain

1. Worker → **Settings → Domains & Routes** → **Add → Custom Domain**.
2. Enter `chat.linearit.co` → **Add domain**. Cloudflare creates the SSL
   certificate automatically (a minute or two).

That's it — open **https://chat.linearit.co**.

---

## How to use it

**As an admin**
1. Go to chat.linearit.co, enter your email, click **Send code**.
2. Enter the 6-digit code from your inbox → you're in.
3. Click **+ New** to create a group.
4. Open the group → **Members** → add teammates by email.

**As a member**
1. Your admin adds your email (you may get an invite email).
2. Go to chat.linearit.co, enter the same email, get a code, sign in.
3. Pick your group and start chatting.

**In a group you can**
- **Reply in a thread:** tap **↩ Reply** under a message.
- **React:** tap **🙂** under a message and pick an emoji.
- **Attach:** tap **📎** in the composer (needs the R2 bucket from step 4).
- **Call:** tap **📞** (voice) or **🎥** (video) in the group header. Everyone
  else sees a **Join** card. The first time, your browser will ask for
  camera/microphone permission — allow it.

---

## Troubleshooting

- **"Couldn't send the email…"** — no email provider is configured. Do step 3,
  or set `DEV_MODE=1` to test.
- **Code never arrives** — check the Power Automate run history / Resend logs,
  the spam folder, and that `EMAIL_FROM` uses an allowed domain.
- **"Only admins can create groups."** — add your email to `ADMIN_EMAILS` (then
  sign out and back in), or have an existing admin add you.
- **"Database not configured"** — the `DB` binding is missing (step 2.3).
- **Locking it down** — set `RESTRICT_TO_MEMBERS=1` so only people an admin has
  added (or `ADMIN_EMAILS`) can request a code.

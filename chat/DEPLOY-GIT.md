# Auto-deploy Linear Chat from GitHub (stop the copy/paste)

One-time setup so the `linear-chat` Worker redeploys itself on every `git push`,
using [`chat/wrangler.toml`](./wrangler.toml). Do the steps **in order** — step 2
protects your live app from breaking.

---

## Why the order matters
When a Worker deploys from `wrangler.toml`, that file becomes the source of truth
for **bindings** (D1, R2) and **plaintext variables**. Anything not declared can
be removed on deploy. **Encrypted Secrets are the exception — they always
survive.** Your `AUTH_SECRET`, `RESEND_API_KEY`, etc. are currently *plaintext*
variables, so we convert them to Secrets first.

---

## 1) Put your D1 database ID into wrangler.toml
1. Cloudflare → **Storage & Databases → D1** → open **`linear_chat`**.
2. Copy the **Database ID** (a long UUID).
3. Paste it into `chat/wrangler.toml` → `database_id = "..."` (replace the
   placeholder), and commit. *(Or paste it to me and I'll commit it.)*
4. Confirm the R2 `bucket_name` in the file matches the bucket you created
   (default `linear-chat-files`).

## 2) Convert your variables to encrypted Secrets  ⚠️ important
Cloudflare → `linear-chat` → **Settings → Variables and Secrets**. For **each** of
these, copy the current value first, delete the plaintext one, then **Add** it
back with **Encrypt** turned on (so its type becomes *Secret*):

- `AUTH_SECRET` — **use the exact same value** (changing it logs everyone out and
  breaks existing file links).
- `RESEND_API_KEY` — same value (or a fresh key from Resend).
- `ADMIN_EMAILS`
- `EMAIL_FROM`

> Why: these are not listed in `wrangler.toml` (it's a public repo — secrets must
> never be committed). As Secrets they persist across deploys; left as plaintext,
> they'd be wiped on the first Git deploy and the app would break (logins/email).

*(Alternative: the two non-sensitive ones — `ADMIN_EMAILS`, `EMAIL_FROM` — can
instead go under `[vars]` in wrangler.toml, but that exposes those emails in the
public repo. Secrets are cleaner.)*

## 3) Connect the Worker to this repo
1. Cloudflare → `linear-chat` → **Settings → Build** → **Connect** (Workers Builds).
2. Pick the GitHub repo **`CFtheitguy/cftheitguy.github.io`** and the **branch**
   you want to deploy from.
3. Set **Root directory** to **`chat`**.
4. Build command: **leave empty**. Deploy command: **`npx wrangler deploy`**
   (usually the default).
5. Save.

## 4) Test it
Push any small change (or use **Retry build** in the dashboard). Watch the build
log finish, then load **chat.linearit.co**. Confirm:
- you're still signed in (Secrets survived),
- attachments and email still work,
- your latest change is live.

---

## Which branch?
Point Workers Builds at whichever branch you want to be "production." Today the
work is on `claude/determined-heisenberg-q991k0`. If you'd like a stable setup,
say the word and I'll merge it to **`main`** and you can point the build at
`main`.

## If a deploy breaks something (rollback)
Cloudflare → `linear-chat` → **Deployments** → pick the previous good version →
**Rollback**. Then fix the cause (usually a missing binding/secret) and redeploy.

## Day-to-day after setup
You do nothing. I push changes; Cloudflare builds and deploys them automatically.
You'd only touch the dashboard to change a Secret or roll back.

# `linear-device` — Cloudflare Worker for `device.linearit.co`

Serves the device report (hosted in this repo at `/device/index.html`, live at
`https://www.linearit.co/device/`) under the vanity domain **device.linearit.co**.

It's a **reverse proxy**, so the page has one source of truth — the repo. Edit
`/device/index.html`, push, and it's live here with **no worker redeploy**. The
worker just fetches the page from the site and returns it.

This Worker is **completely separate** from `linear-chat`: its own folder, its own
`wrangler.toml`, no shared bindings. It cannot affect `chat.linearit.co`.

---

## Deploy it live — one command

You need to be logged into the **same Cloudflare account** that owns
`linearit.co` (the one that runs `chat.linearit.co`). Wrangler uses that login.

```bash
cd device-worker
npx wrangler login      # once per machine, opens a browser (skip if already logged in)
npx wrangler deploy
```

That single `deploy` does everything:

1. Uploads the `linear-device` Worker.
2. Because `wrangler.toml` has `{ pattern = "device.linearit.co", custom_domain = true }`,
   it **creates the `device.linearit.co` Custom Domain and its DNS record**
   automatically in the `linearit.co` zone.

Give Cloudflare a minute to issue the edge certificate, then open
**https://device.linearit.co** — you should see the device report.

> Validate without deploying anything: `npx wrangler deploy --dry-run` (compiles
> and checks config, uploads nothing).

---

## Optional — hands-off auto-deploy (like the chat Worker)

If you want this to redeploy on every `git push` the way `linear-chat` does, add a
**second** Workers Build project:

1. Cloudflare → **Workers & Pages → Create → Workers → Connect to Git**.
2. Repo **`CFtheitguy/cftheitguy.github.io`**, your production branch.
3. **Root directory: `device-worker`** (this is what keeps it separate from chat).
4. Deploy command: `npx wrangler deploy`. Build command: empty.
5. Save. Now pushes that touch `device-worker/` redeploy the domain automatically.

The first build still provisions the Custom Domain + DNS via `custom_domain = true`.

---

## How it maps requests

| Request to device.linearit.co | Proxied from |
|---|---|
| `/`            | `https://www.linearit.co/device/` (the report) |
| `/logo.png`    | `https://www.linearit.co/logo.png` |
| `/favicon.png` | `https://www.linearit.co/favicon.png` |
| any other path | `https://www.linearit.co<path>` |

No request loop: the worker only receives `device.linearit.co` traffic and fetches
the plain GitHub Pages origin (`www.linearit.co`), which is not a worker.

## Rollback
Cloudflare → `linear-device` → **Deployments** → pick a previous version → **Rollback**.
To remove the domain, delete the Custom Domain under the Worker's **Domains & Routes**.

## Alternative with no Worker at all
If you'd rather not run a Worker, a Cloudflare **Redirect Rule**
(`device.linearit.co/*` → `https://www.linearit.co/device/`, 301) plus a
`CNAME device → www.linearit.co` also works — but the address bar then shows
`www.linearit.co/device/` instead of `device.linearit.co`. See `../device/README.md`.

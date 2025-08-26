# Linear Desk — help.linearit.co package

Files in this repo:
- `index.html` — public client form (points to `https://api.help.linearit.co`)
- `admin.html` — agent dashboard (noindex; points to `https://api.help.linearit.co`)
- `CNAME` — sets GitHub Pages custom domain `help.linearit.co`
- `WORKER.md` — how to map your Cloudflare Worker to `api.help.linearit.co`

## Add required labels (GitHub → Issues → Labels)
Go to your `linear-desk-tickets` repo → **Issues → Labels → New label** and create these **exact names**:

**Status**
- `status: new` (color: light gray)
- `status: in-progress` (blue)
- `status: waiting` (yellow)
- `status: closed` (green)

**Priority**
- `priority: low` (gray)
- `priority: normal` (default)
- `priority: high` (red)

**(Optional) Category**
- `category: network`
- `category: printer`
- `category: software`
- `category: hardware`
- `category: password`

> Why add labels first? The Worker sets these labels during ticket creation; having them pre‑created avoids `422 Unprocessable Entity` errors.

## Where labels are used
- The **Worker** applies `status: new` + `priority: <value>` + optional `category: <value>` when creating the issue.
- The **Dashboard** reads these labels to show status, priority highlighting, and filters.

## Publish to GitHub Pages
1) Put these files in the root of your site repo (e.g., `help-site`).  
2) Repo → **Settings → Pages** → Build from Branch (main / root).  
3) The included **CNAME** file maps to `help.linearit.co`. Make sure your domain in Cloudflare has a CNAME for `help` → `YOUR_GITHUB_USERNAME.github.io` and proxy on.

That’s it.

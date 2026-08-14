# `speed-worker` — Cloudflare Worker for `speed.linearit.co`

The measurement backend for **Linear Speed**, the branded speed test. The app
itself lives in this repo at `/speed/` (served by GitHub Pages at
`https://www.linearit.co/speed/`); this Worker reverse-proxies that copy so it
also answers at the vanity domain **speed.linearit.co**, and adds the four
endpoints the test needs.

This Worker is **completely separate** from `linear-chat`, `linear-vault`,
`linear-time` and `linear-sign`: its own folder, its own `wrangler.toml`, no
shared bindings. It cannot affect the other subdomains.

There is **no database, no email and no secret to set.**

---

## One-time setup (run from this folder)

You must be logged into the **same Cloudflare account** that owns `linearit.co`.

```bash
cd speed-worker
npm install
npx wrangler login      # once per machine (skip if already logged in)
npx wrangler deploy
```

That single `deploy`:

1. Uploads the `speed-worker` Worker.
2. Because `wrangler.toml` has `{ pattern = "speed.linearit.co", custom_domain = true }`,
   it **creates the `speed.linearit.co` Custom Domain and its DNS record**
   automatically in the `linearit.co` zone.

Give Cloudflare a minute to issue the edge certificate, then open
**https://speed.linearit.co**.

> Validate without deploying: `npx wrangler deploy --dry-run`.

**Until this Worker is deployed the test cannot run** — not even at
`https://www.linearit.co/speed/`, because the page measures against these
endpoints. The page will load and show the "we couldn't reach the measurement
server" card.

---

## The endpoints

| Route | What it does |
|---|---|
| `GET /api/ping` | Empty `204`. The client times a dozen of these for ping and jitter. |
| `GET /api/down?bytes=N` | Streams `N` bytes of **random** data (capped at 100 MB). |
| `POST /api/up` | Reads the body to the end, throws it away, replies with the byte count (capped at 64 MB). |
| `GET /api/info` | What the edge sees: IP, city, country, ISP, ASN, colo, HTTP version. |
| `GET /api/health` | `ok`. |
| anything else | Reverse-proxied from `https://www.linearit.co/speed/`. |

**Why random bytes and not zeros:** a response full of zeros compresses to almost
nothing, so the test would be measuring the compressor rather than the line.
Random data is incompressible, so what the browser counts is what actually
crossed the wire. One 64 KB block is generated per request and reused for every
chunk — regenerating it hundreds of times would measure Worker CPU instead.

**Nothing is stored.** The downloaded bytes are generated on demand, the uploaded
bytes are discarded as they arrive, and results exist only in the visitor's tab.

---

## Cost

Requests are cheap; **bandwidth out of Cloudflare Workers is not metered**, but
each test moves real data (roughly 10 seconds of your visitor's line speed down,
plus 9 seconds up). On the Workers paid plan the meaningful number is CPU time,
and this Worker uses almost none — it streams a pre-made buffer and counts bytes.

If you ever want to make a test lighter, the knobs are at the top of
`/speed/app.js`: `DL_MS`, `UL_MS`, `DL_STREAMS`, `UL_STREAMS`.

---

## Optional — hands-off auto-deploy

Redeploy on every `git push` by adding a **Workers Build** project pointed at
this repo with **Root directory: `speed-worker`** and the build command left
empty (Wrangler picks up `wrangler.toml`). Same pattern as `chat/DEPLOY-GIT.md`.

---

## Local development

```bash
cd speed-worker
npx wrangler dev
```

`wrangler dev` serves the endpoints on `http://localhost:8787`. The app's API
base is chosen by hostname (see the top of `/speed/app.js`): anything that isn't
`www.linearit.co` / `linearit.co` / `cftheitguy.github.io` is treated as
same-origin, so a local copy of `/speed/` served from that same port just works.

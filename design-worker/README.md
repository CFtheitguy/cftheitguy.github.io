# `design-worker` — Cloudflare Worker for `design-api.linearit.co`

Free stock photo search for **Linear Design** (`https://www.linearit.co/design/`).
The design app itself is static and runs entirely in the browser; this Worker
is the only piece that talks to an outside service (Pexels), and it's the only
place the Pexels key exists.

| Endpoint | What it does |
|---|---|
| `GET /photos/search?q=…` | Stock photo search (Pexels). Identical searches are cached for an hour. |
| `GET /photos/image?u=…` | Re-serves one Pexels image with CORS, so the editor can export it. Refuses any other host. |
| `GET /health` | Tells the app whether photo search is switched on. |

It is **completely separate** from `linear-chat`, `board-worker`, `speed-worker`
and the rest: its own folder, its own `wrangler.toml`, no shared bindings.

**Costs nothing.** Pexels is free (no card), and this Worker fits comfortably in
Cloudflare's free Workers allowance.

**Safety rails built in**

- Only pages on `https://www.linearit.co` / `https://linearit.co` can use it
  (other sites get `403`).
- Each visitor is limited to 60 photo requests a minute (change it in
  `wrangler.toml`).
- The key is an encrypted Worker secret — never in this repo, never sent to the
  browser.

Until it's set up, the app's Photos tab says "not switched on yet" — everything
else in Linear Design keeps working.

---

## Setup without a terminal (Cloudflare dashboard)

1. Get a Pexels key (step 1 below).
2. **dash.cloudflare.com** → **Workers & Pages** → **Create** → Worker → name it
   `design-worker` → **Deploy**.
3. **Edit code** → delete everything → paste the whole of
   [`src/index.js`](src/index.js) → **Deploy**.
4. Worker → **Settings → Variables and Secrets → Add** → Type **Secret**,
   Name `PEXELS_KEY`, Value = your key → **Deploy**.
5. Worker → **Settings → Domains & Routes → Add → Custom domain** →
   `design-api.linearit.co` → **Add domain**.
6. Check **https://design-api.linearit.co/health** shows `"photos":true`.

(The dashboard route has no per-visitor rate limit — that binding is set in
`wrangler.toml` — but results are still cached and Pexels' own limits apply.)

## Setup — step by step

You need to be logged into the **same Cloudflare account that owns `linearit.co`**
(the one you used for `board-worker`), on a computer with Node.js.

### 1. Get a Pexels API key (free)

1. Go to **https://www.pexels.com/join-consumer/** and create a free account
   (or log in).
2. Go to **https://www.pexels.com/api/new/**.
3. Fill in the short form — for example:
   - *Project name:* `Linear Design`
   - *Description:* `Stock photo search inside the Linear Design app at linearit.co/design`
   - *URL:* `https://www.linearit.co/design/`
4. Submit. Your **API key** is shown on **https://www.pexels.com/api/** — copy it.

Limits: 200 requests an hour, 20,000 a month (the Worker's caching stretches
that a long way).

### 2. Deploy the Worker

In a terminal, from your copy of this repo (run `git pull` first):

```bash
cd design-worker
npm install
npx wrangler login        # opens a browser — click Allow. Skip if already logged in.
npx wrangler deploy
```

`deploy` uploads the Worker and, because of `custom_domain = true`, creates the
**design-api.linearit.co** hostname and its DNS record automatically. Give
Cloudflare a minute to issue the certificate.

### 3. Add the key as a secret

Still in `design-worker`:

```bash
npx wrangler secret put PEXELS_KEY
```

It asks `Enter a secret value:` — paste the Pexels key, press Enter. It takes
effect immediately. **Don't paste the key anywhere else** — not in files, chat
or GitHub.

### 4. Check it

Open **https://design-api.linearit.co/health** — you should see:

```json
{"ok":true,"photos":true}
```

Then open **https://www.linearit.co/design/**, start a design, open the
**Photos** tab and search "coffee". Click a photo to add it.

---

## Everyday

| Task | Command (from `design-worker/`) |
|---|---|
| See live logs | `npx wrangler tail` |
| Replace the key | `npx wrangler secret put PEXELS_KEY` |
| Turn photo search off | `npx wrangler secret delete PEXELS_KEY` |
| Change the limit | edit `wrangler.toml`, then `npx wrangler deploy` |
| Run the tests (no key needed) | `npm test` |

If the key ever leaks: delete it on the Pexels API page, create a new one, and
`secret put` the new one.

## Privacy note

**Search words** go to Pexels. Uploaded photos and designs never leave the
device. The app says this under the Photos tab.

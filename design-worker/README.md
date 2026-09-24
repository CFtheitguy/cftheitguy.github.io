# `design-worker` — Cloudflare Worker for `design-api.linearit.co`

The online half of **Linear Design** (`https://www.linearit.co/design/`). The
design app itself is static and runs entirely in the browser; this Worker adds
the two features that need an outside service, and it's the only place their
API keys exist:

| Endpoint | What it does | Needs |
|---|---|---|
| `GET /photos/search?q=…` | Stock photo search (Pexels). Identical searches are cached for an hour. | `PEXELS_KEY` |
| `GET /photos/image?u=…` | Re-serves one Pexels image with CORS, so the editor can export it. Refuses any other host. | — |
| `POST /write` | **Magic Write**: headline, tagline, caption and rewrite suggestions from Claude. | `ANTHROPIC_KEY` |
| `GET /health` | Tells the app which features are switched on. | — |

It is **completely separate** from `linear-chat`, `board-worker`, `speed-worker`
and the rest: its own folder, its own `wrangler.toml`, no shared bindings.

**Safety rails built in**

- Only pages on `https://www.linearit.co` / `https://linearit.co` can use it
  (other sites get `403`).
- Each visitor is rate-limited: 60 photo requests and 8 Magic Write requests per
  minute (change them in `wrangler.toml`).
- Keys are encrypted Worker secrets. They are never in this repo and never sent
  to the browser.

Until the keys are set, the app shows "not set up yet" for these two features —
everything else in Linear Design keeps working.

---

## Setup — step by step

You need to be logged into the **same Cloudflare account that owns `linearit.co`**
(the one you used for `board-worker`).

### 1. Get a Pexels API key (free)

1. Go to **https://www.pexels.com/join-consumer/** and create a free account
   (or log in).
2. Go to **https://www.pexels.com/api/new/**.
3. Fill in the short form — for example:
   - *Project name:* `Linear Design`
   - *Description:* `Stock photo search inside the Linear Design app at linearit.co/design`
   - *URL:* `https://www.linearit.co/design/`
4. Submit. Your **API key** is shown on **https://www.pexels.com/api/** — copy it.

Free, no card. Limits: 200 requests an hour, 20,000 a month (the Worker's
caching stretches that a long way).

### 2. Get an Anthropic API key (pay per use)

1. Go to **https://console.anthropic.com/** (it may forward you to Anthropic's
   newer developer platform address — that's fine) and sign up / log in.
2. Open the **Billing** page: add a payment method and buy a small amount of
   credit (e.g. $5–$10 to start).
3. Open the **Limits** page (spend limits): set a **monthly spend limit** you're
   comfortable with, e.g. $10. The API stops at that limit — no surprise bills.
4. Open the **API Keys** page → **Create Key**. Name it `linear-design-worker`.
   Copy the key (starts with `sk-ant-`). It's only shown once.

The Worker uses the model named in `wrangler.toml` (`MODEL`, default
`claude-opus-5`) at low effort. Each Magic Write request is one short
call. To spend less per request, change `MODEL` to `claude-haiku-4-5` and
redeploy — the trade-off is somewhat plainer suggestions. Prices:
https://www.anthropic.com/pricing

### 3. Deploy the Worker

On your computer, in a terminal, from the repo folder:

```bash
cd design-worker
npm install
npx wrangler login        # opens a browser — approve. Skip if already logged in.
npx wrangler deploy
```

`deploy` uploads the Worker and, because of `custom_domain = true`, creates the
**design-api.linearit.co** hostname and its DNS record automatically. Give
Cloudflare a minute to issue the certificate.

### 4. Add the two keys as secrets

Still in `design-worker`:

```bash
npx wrangler secret put PEXELS_KEY
```

It asks `Enter a secret value:` — paste the Pexels key, press Enter.

```bash
npx wrangler secret put ANTHROPIC_KEY
```

Paste the Anthropic key, press Enter.

Secrets take effect immediately; no redeploy needed. **Don't paste keys
anywhere else** — not in files, not in chat, not in GitHub.

### 5. Check it

Open **https://design-api.linearit.co/health** — you should see:

```json
{"ok":true,"photos":true,"write":true}
```

Then open **https://www.linearit.co/design/**, start a design, and:

- **Photos** tab → search "coffee" → click a photo to add it.
- Select a text box → **Magic Write** → pick "Headlines" → **Write**.

---

## Everyday

| Task | Command (from `design-worker/`) |
|---|---|
| See live logs | `npx wrangler tail` |
| Replace a key | `npx wrangler secret put PEXELS_KEY` (or `ANTHROPIC_KEY`) |
| Turn a feature off | `npx wrangler secret delete ANTHROPIC_KEY` |
| Change model / limits | edit `wrangler.toml`, then `npx wrangler deploy` |
| Run the tests (no keys needed) | `npm test` |

If a key ever leaks: delete it in the Pexels / Anthropic dashboard, create a new
one, and `secret put` the new one.

## Privacy note

With these features on, **searches** go to Pexels and the **text you ask Magic
Write about** goes to Anthropic. Uploaded photos and designs still never leave
the device. The app says this next to both features.

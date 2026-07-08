# Roast My Setup — Setup Guide

An AI photo-roaster: upload a desk/room/car/pet/food pic, get a witty roast.
Web app: **https://linearit.co/fun4** (or `cftheitguy.github.io/fun4`).

Everything below can be done from the Cloudflare **dashboard** — no command
line required. No D1 database, no secrets, no third-party API key — it runs
entirely on **Workers AI**, which is billed to your Cloudflare account and
included in the Workers Free plan's daily allowance.

---

## 1) Create the Worker

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it `roast-api` → **Deploy** (deploys the default template first).
3. Open it → **Edit code** → select all, delete, and paste the entire
   contents of [`worker/src/index.js`](worker/src/index.js). **Save & Deploy**.

## 2) Attach Workers AI

1. Still in `roast-api` → **Settings → Bindings** → **Add → Workers AI**.
2. **Variable name:** `AI` → **Save**. (No further config — Workers AI needs
   no API key.)

## 3) (Optional) Lock down CORS

By default the Worker accepts requests from any origin. To restrict it to
your site:

- **Settings → Variables and Secrets** → **Add**:
  - `ALLOW_ORIGIN` = `https://cftheitguy.github.io` (or `https://linearit.co`)

## 4) Point the app at your Worker

`roast-api.<your-subdomain>.workers.dev` is shown at the top of the Worker's
dashboard page once deployed. If it doesn't match the default used in
[`index.html`](index.html) (`roast-api.friedmanchaimhersh.workers.dev`),
update the `API` constant near the top of that file's `<script>` block.

## 5) Test it

1. Make sure GitHub Pages serves this repo (it already does — `linearit.co`).
2. Go to **https://linearit.co/fun4**, upload a photo, tap **Roast Me**.

---

## Cost / abuse notes

- Workers AI's free daily allowance is generous for casual/viral traffic but
  not unlimited. If it gets shared widely and you want a hard stop, add a
  [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) check
  or a rate limit rule in front of `/roast`.
- Photos are sent to Workers AI for inference and are **not stored** —
  nothing is written to disk or a database.

## Troubleshooting

- **"Something broke while roasting that."** — the `AI` binding isn't
  attached (step 2), or the account has hit its daily Workers AI limit.
- **CORS error in the browser console** — `ALLOW_ORIGIN` doesn't match the
  page's origin, or you set it but are testing from a different domain.

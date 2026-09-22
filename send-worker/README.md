# `send-worker` — Cloudflare Worker for `send.linearit.co`

The backend for **Linear Send**, our own take on WeTransfer: pick as many files
as you like, get one link, and the link switches itself off after the time you
chose. The page lives in this repo at `/send/` (served by GitHub Pages at
`https://www.linearit.co/send/`); this Worker reverse-proxies that copy so it
also answers at **send.linearit.co**, and it stores the files in R2.

Completely separate from every other Worker here: its own folder, its own
`wrangler.toml`, its own bucket.

## Nothing loses size or quality

Files are stored **byte for byte** and handed back byte for byte. There is no
resizing, no transcoding and no compression anywhere. "Download all" builds a
ZIP with the **store** method (no compression), so even the bundle is the
original files laid end to end.

Before a link opens, the Worker checks that every file landed at **exactly**
the size the sender's browser announced. A short or missing file stops the
link from ever opening.

## One-time setup (run from this folder)

```bash
cd send-worker
npm install
npx wrangler login                                # once per machine
npx wrangler r2 bucket create linear-send-files
npx wrangler secret put UPLOAD_KEY                # strongly recommended — see below
npx wrangler deploy
```

That `deploy` uploads the Worker, provisions the `send.linearit.co` Custom
Domain and DNS record, and registers the hourly cron that deletes expired
transfers.

### `UPLOAD_KEY` — who may send

Without it, **anyone on the internet** can upload to your bucket. Set it to a
passphrase and the page asks for it the first time someone sends (and remembers
it in that browser). **Receiving never needs the key** — the link itself is the
permission.

### What it costs

R2 has a free tier (10 GB stored per month, and downloads are always free), and
nothing here needs the paid Workers plan. Because transfers delete themselves,
storage stays near zero unless lots of people send at once. Past the free tier
it's about $0.015 per GB-month.

## Limits

| | | where |
| --- | --- | --- |
| one transfer, all files together | 10 GB | `MAX_TRANSFER_GB` in `wrangler.toml` (also `MAX_BYTES` in `send/app.js`) |
| longest expiry | 14 days | `MAX_DAYS` in `wrangler.toml` |
| expiry choices | 1 hour, 1 day, 3 days, 7 days, 14 days | `EXPIRY_CHOICES` in `src/index.js` |
| files in one transfer | 500 | `MAX_FILES` |

## How an upload works

1. `POST /api/t` — the file list and expiry. Returns an id, an **owner token**
   (only its SHA-256 is stored) and the part size.
2. Each file goes up whole if it's 16 MB or less, otherwise in 16 MB parts
   using R2 multipart (`/start`, `PUT ?upload&part`, `/complete`). One Worker
   request is capped at 100 MB, and parts mean a dropped connection only costs
   one part. The browser runs four requests at once and retries each with
   backoff.
3. `POST /api/t/:id/finish` — size check, then the link opens.

While each file streams up, the browser works out its **CRC-32**. That is what
lets the Worker build the ZIP without reading any file bytes itself: it writes
a header, pipes the R2 object through untouched, writes the next header. CPU
cost stays flat however big the transfer is, and the download has a real
`Content-Length` so the browser shows true progress. ZIP64 kicks in
automatically past 4 GB.

## Expiry

- Every request checks `expiresAt` first, so a link is dead the moment it
  runs out (`410 Gone`), and that request deletes the files on its way out.
- An hourly cron (`17 * * * *`) deletes everything else that's due. It walks
  an index of empty keys, `exp/<13-digit ms>/<id>`, which R2 lists in time
  order, so it only ever reads what's actually expired.
- The sender can delete early from the "link is ready" screen, or from
  "Links you've sent from this browser".
- Abandoned half-finished multipart uploads are cleaned up by R2 on its own
  after 7 days.

## Endpoints

| Route | |
| --- | --- |
| `POST /api/t` | create a transfer (needs `X-Upload-Key` if `UPLOAD_KEY` is set) |
| `PUT /api/t/:id/f/:n` | upload a small file whole (owner) |
| `POST /api/t/:id/f/:n/start` | begin a multipart upload (owner) |
| `PUT /api/t/:id/f/:n?upload=U&part=P` | upload one part (owner) |
| `POST /api/t/:id/f/:n/complete` | finish a multipart upload (owner) |
| `POST /api/t/:id/finish` | check sizes and open the link (owner) |
| `DELETE /api/t/:id` | delete now (owner) |
| `GET /api/t/:id` | titles, message, file list, expiry |
| `GET /dl/:id/:n` | one file, `Range` supported, so downloads can resume |
| `GET /dl/:id/all` | every file in one uncompressed ZIP |
| `GET /api/health` | `ok` |
| `GET /*` | reverse-proxy of `APP_ORIGIN` + `APP_PATH` |

Owner requests carry the token in `X-Owner-Token`. Downloads are always sent
as `attachment` with `nosniff` and a sandbox CSP, so nothing uploaded can ever
run as a page on this domain.

## Local development

```bash
python3 -m http.server 8788 &        # from the repo root
npx wrangler dev --port 8787 --var APP_ORIGIN:http://127.0.0.1:8788 --var APP_PATH:/send/
```

Open <http://127.0.0.1:8787/>. `wrangler dev` gives you a local R2 bucket
automatically. Add `--test-scheduled` and hit
`/__scheduled?cron=17+*+*+*+*` to run the expiry sweep by hand.

## Tail the logs

```bash
npx wrangler tail
```

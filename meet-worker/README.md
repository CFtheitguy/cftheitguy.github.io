# `meet-worker` — Cloudflare Worker for `meet.linearit.co`

The backend for **Linear Meet**, video and voice meetings you join with a link.
The app itself lives in this repo at `/meet/` (GitHub Pages serves it at
`https://www.linearit.co/meet/`); this Worker reverse-proxies that copy so it
also answers at **meet.linearit.co**, runs one Durable Object per meeting for
signaling, and proxies the **Cloudflare Realtime SFU** so the app secret never
reaches a browser.

Separate from `linear-chat`, `board-worker` and the rest: its own folder, its
own `wrangler.toml`, no shared bindings. It uses the **same Realtime app** as
Linear Chat (same App ID and secret).

## One-time setup (run from this folder)

Logged into the Cloudflare account that owns `linearit.co`:

```bash
cd meet-worker
npm install
npx wrangler login
npx wrangler secret put REALTIME_APP_SECRET   # paste the same secret linear-chat uses
npx wrangler deploy
```

`deploy` uploads the Worker, creates the `MeetRoom` Durable Object class and
provisions the `meet.linearit.co` Custom Domain and DNS record.

Check it: open `https://meet.linearit.co/api/status` — you want
`{"configured":true,"ok":true,...}`.

**Or deploy from Git** (like board-worker): Cloudflare dashboard → Workers &
Pages → Create → Import a repository → this repo, **Root directory
`meet-worker`**, deploy command `npx wrangler deploy`. Then add the
`REALTIME_APP_SECRET` secret under the Worker's Settings → Variables and Secrets.
Every push to `main` redeploys it.

### Optional: TURN (for strict office/hotel firewalls)

Calls use Cloudflare's STUN server by default, which works on most networks.
For networks that block direct UDP, create a TURN key in the dashboard
(Realtime → TURN) and add two secrets:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

The app then fetches short-lived TURN credentials from `/api/ice` automatically.

### Cost

Durable Objects need the paid Workers plan ($5/month — already in use for the
board). Realtime SFU traffic is billed per GB leaving Cloudflare, with a large
free monthly allowance; small meetings are typically free.

## Routes

| Route | What it does |
| --- | --- |
| `GET /ws?room=NAME&cid=ID` | WebSocket to the meeting's Durable Object |
| `POST /api/sfu/sessions/new` | → Realtime `sessions/new` (ticket required) |
| `POST /api/sfu/sessions/:id/tracks/new` | → Realtime `tracks/new` (ticket required) |
| `PUT /api/sfu/sessions/:id/renegotiate` | → Realtime `renegotiate` (ticket required) |
| `PUT /api/sfu/sessions/:id/tracks/close` | → Realtime `tracks/close` (ticket required) |
| `GET /api/ice` | STUN, or TURN credentials if configured (ticket required) |
| `GET /api/status` | Are the Realtime credentials set and accepted? |
| `GET /api/health` | `ok` |
| `GET /*` | reverse-proxy of `APP_ORIGIN` + `APP_PATH` |

**Tickets.** When someone joins a room, the room gives them an HMAC ticket
(signed with the Realtime secret, valid 12 hours). The SFU proxy refuses
requests without one, so this Worker can't be used as a free media relay by
anyone who hasn't joined a meeting from an allowed origin.

## Protocol (JSON over the socket)

**Browser → room:** `hello {name, muted, camOff}`, `state {sessionId, tracks,
muted, camOff, hand}`, `chat {text}`, `react {emoji}`, `ping`, and for the host
`host {action: mute | mute-all | remove | make-host | lock | unlock, target}`.

**Room → browser:** `lobby {count, locked}`, `welcome {cid, ticket}`,
`denied {reason}`, `roster {people, locked}`, `chat`, `react`, `notice {text}`,
`force-mute {by}`, `removed {by}`, `pong`.

The host is whoever has been in the room longest, unless they hand it on.
Nothing is stored except the lock flag and the host's id, and both are wiped
when the last person leaves.

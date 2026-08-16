# `board-worker` — Cloudflare Worker for `board.linearit.co`

The relay behind **Linear Board**, the shared whiteboard. The app itself lives
in this repo at `/board/` (served by GitHub Pages at
`https://www.linearit.co/board/`); this Worker reverse-proxies that copy so it
also answers at the vanity domain **board.linearit.co**, and it runs the
Durable Object that actually holds each board.

This Worker is **completely separate** from `linear-chat`, `linear-vault`,
`linear-time`, `linear-sign` and `speed-worker`: its own folder, its own
`wrangler.toml`, no shared bindings. It cannot affect the other subdomains.

There is **no database, no email and no secret to set.**

---

## One-time setup (run from this folder)

You must be logged into the **same Cloudflare account** that owns `linearit.co`.

```bash
cd board-worker
npm install
npx wrangler login      # once per machine (skip if already logged in)
npx wrangler deploy
```

That single `deploy`:

1. Uploads the `board-worker` Worker.
2. Creates the `BoardRoom` Durable Object class (migration `v1`).
3. Provisions the `board.linearit.co` Custom Domain **and** its DNS record in
   the `linearit.co` zone.

### One thing to know about billing

Durable Objects require the **paid Workers plan, $5 a month**. That is the
whole cost. Nothing in this app approaches any usage tier beyond the base
charge — a busy hand-drawn board is a few hundred kilobytes, and a room holds
a handful of sockets. Static hosting of the front-end is free.

---

## What it does

| Route | Behaviour |
| --- | --- |
| `GET /ws?room=NAME&cid=ID` | WebSocket upgrade, routed to that room's Durable Object |
| `GET /api/health` | `ok` |
| `GET /*` | reverse-proxy of `APP_ORIGIN` + `APP_PATH` (the Pages copy of the app) |

### Why a Durable Object

Cloudflare guarantees that a given room name resolves to **exactly one
instance, running in one place, worldwide**. That guarantee is the entire
reason this is the right tool. Without it, two people could open the same link,
land on two different machines, and never see each other.

Each room instance holds three things:

- an open WebSocket to every person currently on that board
- the ordered list of everything drawn or typed so far
- the alarm that eventually deletes the lot

### The protocol

All JSON, over one socket. This is the whole thing.

**Browser → room**

| Message | Payload |
| --- | --- |
| `stroke_start` | `id`, `color`, `width`, `pts` (first points) |
| `stroke_points` | `id`, `pts` (added since the last message) |
| `stroke_end` | `id` |
| `text_add` | `id`, `x`, `y`, `text`, `size`, `color` |
| `undo` | `id` of the item to remove |
| `clear` | — |
| `ping` | — (keepalive; answered with `pong`) |

**Room → browser**

| Message | Payload |
| --- | --- |
| `history_start` | `n`, `expiresAt` |
| `history` | `items` — sent as many times as it takes |
| `history_end` | — |
| the six messages above | relayed from other people |
| `peers` | `n` — how many people are on the board |
| `reject` | `id`, `reason` — the room would not take that item |
| `expired` | the 24 hours ran out; the socket closes |

Strokes and text are both **items** in one ordered list, so undo, clear and
history replay work on either with no special cases.

Coordinates and font sizes are stored as **fractions between 0 and 1** —
`0.5, 0.5` is the middle of the board. That is what lets a phone and a 27-inch
monitor show the same board correctly, and it is what makes the high-resolution
PNG export work without recalculating anything.

History is sent in **chunks** (`history_start` … `history` × n …
`history_end`), because a busy board is larger than a single WebSocket message
is allowed to be.

### Rooms delete themselves

Every write pushes a Durable Object alarm out to **24 hours from that moment**.
The countdown is *rolling*, not fixed: a fixed timer started at room creation
would delete a board out from under two people still using it at hour 23.

When the alarm fires the room erases its storage and stops existing. Opening a
link to a room that has already expired gives a fresh empty board rather than
an error, because a room name is only a string and the object is created on
demand.

Auto-delete is **not** here to stay under a Cloudflare limit — there was never
going to be one. It is here because abandoned rooms should not sit around
forever, and because a board that disappears is a real privacy feature.

### Limits

Tuned so one person cannot fill a room, and so a room can never grow past what
a browser can be sent. All in `src/index.js`.

| | |
| --- | --- |
| items in a room | 6,000 |
| total board size | 2 MB |
| points in one stroke | 4,000 |
| characters in one text item | 400 |
| people in one room | 24 |
| messages per second, per person | 80 |

Past the item or size limit the room answers `reject` rather than dropping the
work silently, so the browser can take the item back off the canvas instead of
showing something that was never kept.

---

## Local development

```bash
npx wrangler dev
```

Sockets from a same-origin page are always allowed, so `wrangler dev` needs no
special case. To exercise the whole thing locally, serve the repo root on
another port and point the Worker's proxy at it:

```bash
python3 -m http.server 8788 &        # from the repo root
npx wrangler dev --port 8787 --var APP_ORIGIN:http://127.0.0.1:8788 --var APP_PATH:/board/
```

Then open <http://127.0.0.1:8787/> in two browser windows — use two separate
profiles, or one normal and one private, so they get different client ids and
behave like two different people.

## Tail the logs

```bash
npx wrangler tail
```

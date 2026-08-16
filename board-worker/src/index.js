/* =============================================================================
 * Linear Board — board.linearit.co
 * =============================================================================
 * The relay behind the shared whiteboard. Two people open the same link and
 * draw on the same blank board; whatever one of them draws shows up on the
 * other's screen while the pen is still moving.
 *
 * There are only two moving parts in this file.
 *
 *   The Worker (default export)
 *       Answers the vanity hostname. A WebSocket upgrade on /ws?room=NAME is
 *       handed to the Durable Object for that room name. Everything else is
 *       reverse-proxied from the GitHub Pages copy of the app at
 *       www.linearit.co/board/, so there is only ever one copy of the
 *       front-end to maintain.
 *
 *   BoardRoom (a Durable Object)
 *       One instance per room name, and Cloudflare guarantees there is only
 *       ever one, running in one place. That guarantee is the whole reason a
 *       Durable Object is the right tool: without it two people could connect
 *       to two different machines and never see each other. Each room holds
 *       the open sockets, the ordered list of everything drawn or typed, and
 *       the alarm that eventually deletes the lot.
 *
 * WHAT A STROKE DOES HERE
 *   stroke_start  a new item is created and written to storage
 *   stroke_points points are appended and relayed to everyone else *at once*
 *                 (storage is only rewritten every 400ms — see persist())
 *   stroke_end    the finished stroke is written one last time
 * The relay happens before the write finishes, because the other person
 * seeing the line is the urgent part; durability is not.
 *
 * ROOMS DELETE THEMSELVES
 *   Every write pushes a Durable Object alarm out to 24 hours from that
 *   moment — rolling, not fixed, so a board two people are actively using at
 *   hour 23 does not vanish underneath them. When the alarm finally fires the
 *   room erases its storage and stops existing. Opening a link to a room that
 *   already expired just makes a new empty one, because a room name is only a
 *   string and the object is created on demand.
 *
 * ENDPOINTS
 *   GET /ws?room=NAME&cid=ID   WebSocket upgrade -> the room
 *   GET /api/health            "ok"
 *   GET /*                     reverse-proxy of APP_ORIGIN + APP_PATH
 *
 * ENV (all in wrangler.toml — this Worker has no secrets and no database)
 *   ROOMS        Durable Object namespace binding (required)
 *   APP_ORIGIN   where the front-end is hosted (default https://www.linearit.co)
 *   APP_PATH     its path on that origin (default /board/)
 * ========================================================================== */

/* ---- Limits ---------------------------------------------------------------
 * These exist so one person cannot fill a room, and so a room can never grow
 * past what a browser can be sent in one go. They are deliberately generous:
 * a busy hand-drawn board is a few hundred kilobytes.
 * ------------------------------------------------------------------------- */
const TTL_MS = 24 * 60 * 60 * 1000;  // how long after the last change a room lives
const ALARM_SLACK_MS = 5 * 60 * 1000;// don't rewrite the alarm for changes this close together
const MAX_ITEMS = 6000;              // strokes + text items in one room
const MAX_BOARD_BYTES = 2_000_000;   // total stored board size
const MAX_STROKE_POINTS = 4000;      // x/y pairs in a single stroke
const MAX_TEXT_LEN = 400;            // characters in one text item
const MAX_MSG_BYTES = 96 * 1024;     // one incoming WebSocket message
const MAX_CONNS = 24;                // people in one room at once
const PERSIST_MS = 400;              // min gap between storage writes of a live stroke
const CHUNK_BYTES = 192 * 1024;      // history is sent in pieces this big
const RATE_WINDOW_MS = 1000;         // rate limit window...
const RATE_MAX_MSGS = 80;            // ...and messages allowed inside it

const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CID_RE = /^[a-z0-9]{6,32}$/;
const ID_RE = /^[a-z0-9-]{6,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// Sites allowed to open a socket. The app is served from the Pages site and
// from this Worker's own hostname; nothing else has any business connecting.
const ALLOWED_ORIGINS = [
  "https://www.linearit.co",
  "https://linearit.co",
  "https://board.linearit.co",
  "https://cftheitguy.github.io",
];

/* ============================================================
 * The Worker
 * ============================================================ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return new Response("ok", { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (path === "/ws") return handleSocket(request, env, url);

    return proxyApp(request, env, url);
  },
};

/* Route an incoming socket into its room. The room name arrives as a query
 * parameter rather than a path segment because the browser keeps it in the URL
 * *fragment* (board.linearit.co/#quiet-blue-otter) — fragments are never sent
 * to a server, so the page reads it and passes it along explicitly. */
async function handleSocket(request, env, url) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }

  // The app is served from the Pages site and from this Worker's own
  // hostname; nothing else has any business opening a socket here. Anything
  // same-origin is fine by definition, which is also what makes `wrangler dev`
  // work without a special case.
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin) && !sameHost(origin, url)) {
    return new Response("Not allowed from this origin.", { status: 403 });
  }

  const room = String(url.searchParams.get("room") || "").toLowerCase();
  if (!ROOM_RE.test(room)) return new Response("Bad room name.", { status: 400 });

  const cid = String(url.searchParams.get("cid") || "").toLowerCase();
  if (!CID_RE.test(cid)) return new Response("Bad client id.", { status: 400 });

  // idFromName is what pins one room name to one object, worldwide.
  const id = env.ROOMS.idFromName(room);
  return env.ROOMS.get(id).fetch(request);
}

/* Serve the app itself from the Pages copy, so board.linearit.co and
 * www.linearit.co/board/ are always the same build. */
async function proxyApp(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/board/";
  const path = url.pathname === "/" ? appPath : url.pathname;

  let originResp;
  try {
    originResp = await fetch(origin + path + url.search, {
      method: "GET",
      headers: { Accept: request.headers.get("Accept") || "*/*", "Accept-Encoding": "gzip" },
      redirect: "follow",
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } catch (_) {
    return new Response("The board is briefly unavailable. Please try again in a moment.", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "20" },
    });
  }
  if (originResp.status === 404) return new Response("Not found", { status: 404 });

  const headers = new Headers(originResp.headers);
  headers.delete("set-cookie");
  headers.delete("transfer-encoding");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store, must-revalidate");
  headers.set("X-Served-By", "linear-board");
  return new Response(request.method === "HEAD" ? null : originResp.body, {
    status: originResp.status, statusText: originResp.statusText, headers,
  });
}

/* ============================================================
 * BoardRoom — one per room name
 * ============================================================
 * Storage layout:
 *   i:<10-digit sequence>  ->  one item (a stroke or a piece of text)
 * The sequence is zero-padded so that listing keys in lexical order returns
 * the items in the order they were drawn, which is the order they must be
 * repainted in for one line to sit on top of another correctly.
 *
 * Sockets use the hibernation API, so a room with people connected but nobody
 * drawing costs nothing. Hibernation can drop everything held in memory, so
 * every handler starts by calling load(), which rebuilds the item list from
 * storage if it isn't already there.
 * ========================================================================== */
export class BoardRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.items = null;          // ordered array of items; null until load()
    this.byId = null;           // id -> item
    this.keyOf = null;          // id -> storage key
    this.seq = 0;               // highest sequence used so far
    this.bytes = 0;             // rough total size of the board
    this.lastPersist = new Map(); // item id -> when it was last written
    this.rate = new Map();        // socket -> {start, n}
  }

  async load() {
    if (this.items) return;
    const items = [];
    const byId = new Map();
    const keyOf = new Map();
    let bytes = 0;
    let seq = 0;
    let cursor;

    for (;;) {
      const opts = { prefix: "i:", limit: 1000 };
      if (cursor) opts.startAfter = cursor;
      const page = await this.state.storage.list(opts);
      if (page.size === 0) break;
      for (const [key, item] of page) {
        cursor = key;
        const n = Number(key.slice(2));
        if (n > seq) seq = n;
        items.push(item);
        byId.set(item.id, item);
        keyOf.set(item.id, key);
        bytes += sizeOf(item);
      }
      if (page.size < 1000) break;
    }

    this.items = items;
    this.byId = byId;
    this.keyOf = keyOf;
    this.bytes = bytes;
    this.seq = seq;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cid = String(url.searchParams.get("cid") || "").toLowerCase();

    if (this.state.getWebSockets().length >= MAX_CONNS) {
      return new Response("This board already has as many people on it as it takes.", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    // Survives hibernation, so a woken socket still knows whose it is —
    // which is what makes "undo removes *your* last item" keep working.
    server.serializeAttachment({ cid });

    await this.load();
    await this.sendHistory(server);
    this.announcePeers();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* The whole board, in pieces small enough to fit in a WebSocket message.
   * A person who joins after five minutes of drawing needs this before they
   * see anything; their browser replays it onto a blank canvas. */
  async sendHistory(ws) {
    const expiresAt = await this.state.storage.getAlarm();
    send(ws, { t: "history_start", n: this.items.length, expiresAt });

    let batch = [];
    let batchBytes = 0;
    for (const item of this.items) {
      const size = sizeOf(item);
      if (batch.length && batchBytes + size > CHUNK_BYTES) {
        send(ws, { t: "history", items: batch });
        batch = [];
        batchBytes = 0;
      }
      batch.push(item);
      batchBytes += size;
    }
    if (batch.length) send(ws, { t: "history", items: batch });
    send(ws, { t: "history_end" });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;             // no binary protocol
    if (message.length > MAX_MSG_BYTES) return;
    if (!this.allow(ws)) return;

    let m;
    try { m = JSON.parse(message); } catch (_) { return; }
    if (!m || typeof m.t !== "string") return;

    const att = ws.deserializeAttachment() || {};
    const cid = att.cid;
    if (!cid) return;

    await this.load();

    switch (m.t) {
      case "stroke_start": return this.strokeStart(ws, cid, m);
      case "stroke_points": return this.strokePoints(ws, cid, m);
      case "stroke_end": return this.strokeEnd(ws, cid, m);
      case "text_add": return this.textAdd(ws, cid, m);
      case "undo": return this.undo(ws, cid, m);
      case "clear": return this.clear(ws);
      case "ping": return send(ws, { t: "pong" });
      default: return;
    }
  }

  webSocketClose(ws) { this.rate.delete(ws); this.announcePeers(ws); }
  webSocketError(ws) { this.rate.delete(ws); this.announcePeers(ws); }

  /* ---- The six messages ------------------------------------------------ */

  async strokeStart(ws, cid, m) {
    if (!ID_RE.test(m.id || "") || this.byId.has(m.id)) return;
    if (!this.hasRoomFor(ws, m.id)) return;

    const color = COLOR_RE.test(m.color || "") ? m.color : null;
    const width = clampNum(m.width, 0.0004, 0.06);
    const pts = cleanPoints(m.pts);
    if (!color || width === null || !pts.length) return;

    const item = { id: m.id, kind: "stroke", by: cid, color, width, pts };
    this.append(item);
    this.relay(ws, { t: "stroke_start", id: item.id, by: cid, color, width, pts });
    await this.persist(item, true);
  }

  async strokePoints(ws, cid, m) {
    const item = this.byId.get(m.id);
    if (!item || item.kind !== "stroke" || item.by !== cid) return;

    const pts = cleanPoints(m.pts);
    if (!pts.length) return;

    const room = MAX_STROKE_POINTS * 2 - item.pts.length;
    if (room <= 0) return;                     // stroke is as long as we allow
    const added = pts.length > room ? pts.slice(0, room) : pts;
    for (let i = 0; i < added.length; i++) item.pts.push(added[i]);

    // Relayed first: the other person watching the line grow is the point of
    // the whole exercise. The write behind it can take its time.
    this.relay(ws, { t: "stroke_points", id: item.id, pts: added });
    await this.persist(item, false);
  }

  async strokeEnd(ws, cid, m) {
    const item = this.byId.get(m.id);
    if (!item || item.kind !== "stroke" || item.by !== cid) return;
    this.relay(ws, { t: "stroke_end", id: item.id });
    await this.persist(item, true);
    this.lastPersist.delete(item.id);
  }

  async textAdd(ws, cid, m) {
    if (!ID_RE.test(m.id || "") || this.byId.has(m.id)) return;
    if (!this.hasRoomFor(ws, m.id)) return;

    const color = COLOR_RE.test(m.color || "") ? m.color : null;
    const x = clampNum(m.x, 0, 1);
    const y = clampNum(m.y, 0, 1);
    const size = clampNum(m.size, 0.004, 0.3);
    const text = typeof m.text === "string" ? m.text.slice(0, MAX_TEXT_LEN) : "";
    if (!color || x === null || y === null || size === null || !text.trim()) return;

    const item = { id: m.id, kind: "text", by: cid, color, x, y, size, text };
    this.append(item);
    this.relay(ws, { t: "text_add", id: item.id, by: cid, color, x, y, size, text });
    await this.persist(item, true);
  }

  /* Removes one item, and only if the person asking is the one who drew it.
   * Two people each undoing their own last thing is far less surprising than
   * one person's undo reaching across and deleting the other's work. */
  async undo(ws, cid, m) {
    const item = this.byId.get(m.id);
    if (!item || item.by !== cid) return;

    const key = this.keyOf.get(item.id);
    this.byId.delete(item.id);
    this.keyOf.delete(item.id);
    this.lastPersist.delete(item.id);
    const at = this.items.indexOf(item);
    if (at >= 0) this.items.splice(at, 1);
    this.bytes -= sizeOf(item);

    this.relay(ws, { t: "undo", id: item.id });
    if (key) await this.state.storage.delete(key);
    await this.touch();
  }

  async clear(ws) {
    this.items = [];
    this.byId = new Map();
    this.keyOf = new Map();
    this.lastPersist = new Map();
    this.bytes = 0;
    this.seq = 0;
    this.relay(ws, { t: "clear" });
    await this.state.storage.deleteAll();   // takes the alarm with it...
    await this.state.storage.setAlarm(Date.now() + TTL_MS);  // ...so set a fresh one
  }

  /* ---- Housekeeping ---------------------------------------------------- */

  append(item) {
    this.items.push(item);
    this.byId.set(item.id, item);
    this.keyOf.set(item.id, "i:" + String(++this.seq).padStart(10, "0"));
    this.bytes += sizeOf(item);
  }

  hasRoomFor(ws, id) {
    if (this.items.length < MAX_ITEMS && this.bytes < MAX_BOARD_BYTES) return true;
    // Tell the browser which item did not make it, so it can take that one
    // back off the canvas rather than showing something the room never kept.
    send(ws, { t: "reject", id, reason: "full" });
    return false;
  }

  async persist(item, force) {
    const now = Date.now();
    if (!force && now - (this.lastPersist.get(item.id) || 0) < PERSIST_MS) return;
    this.lastPersist.set(item.id, now);

    const key = this.keyOf.get(item.id);
    if (!key) return;
    await this.state.storage.put(key, item);
    await this.touch();
  }

  /* Push the delete-me alarm out to 24 hours from now. Called on every change,
   * but it only actually rewrites the alarm when the stored one has drifted
   * more than a few minutes behind — otherwise a single stroke would rewrite
   * it dozens of times for no gain. */
  async touch() {
    const target = Date.now() + TTL_MS;
    const current = await this.state.storage.getAlarm();
    if (current === null || target - current > ALARM_SLACK_MS) {
      await this.state.storage.setAlarm(target);
    }
  }

  /* 24 hours after the last change, with nobody connected or not. */
  async alarm() {
    await this.state.storage.deleteAll();
    this.items = [];
    this.byId = new Map();
    this.keyOf = new Map();
    this.lastPersist = new Map();
    this.bytes = 0;
    this.seq = 0;
    for (const ws of this.state.getWebSockets()) {
      send(ws, { t: "expired" });
      try { ws.close(1000, "expired"); } catch (_) {}
    }
  }

  /* Everyone in the room except whoever sent it — the sender already drew it
   * on their own canvas the instant their pen moved. */
  relay(from, msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === from) continue;
      try { ws.send(payload); } catch (_) {}
    }
  }

  /* How many people are on this board. Not a feature — just enough for the
   * status dot to say whether the other person has actually arrived yet. */
  announcePeers(closing) {
    const sockets = this.state.getWebSockets().filter((ws) => ws !== closing);
    const msg = JSON.stringify({ t: "peers", n: sockets.length });
    for (const ws of sockets) { try { ws.send(msg); } catch (_) {} }
  }

  allow(ws) {
    const now = Date.now();
    // Waking from hibernation hands back new socket objects, so the odd stale
    // entry can survive a close it never saw. Nothing depends on the history,
    // so the cheapest fix is to start over.
    if (this.rate.size > MAX_CONNS * 3) this.rate = new Map();
    const bucket = this.rate.get(ws);
    if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
      this.rate.set(ws, { start: now, n: 1 });
      return true;
    }
    bucket.n++;
    return bucket.n <= RATE_MAX_MSGS;
  }
}

/* ============================================================
 * Small helpers
 * ============================================================ */
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

function sameHost(origin, url) {
  try { return new URL(origin).host === url.host; } catch (_) { return false; }
}

function sizeOf(item) {
  // Close enough for a budget: two coordinates cost about as much as a short
  // number plus a comma, and everything else is a handful of short fields.
  return item.kind === "stroke" ? 120 + item.pts.length * 8 : 120 + item.text.length * 2;
}

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < lo ? lo : n > hi ? hi : n;
}

/* Points arrive as a flat array — x, y, x, y — of fractions of the board, so
 * the same board fits a phone and a 27-inch monitor without either of them
 * seeing a cropped version of it. Anything that isn't a pair of real numbers
 * between 0 and 1 is dropped rather than argued with. */
function cleanPoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const n = Math.min(raw.length - (raw.length % 2), MAX_STROKE_POINTS * 2);
  for (let i = 0; i < n; i += 2) {
    const x = Number(raw[i]);
    const y = Number(raw[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push(x < 0 ? 0 : x > 1 ? 1 : x, y < 0 ? 0 : y > 1 ? 1 : y);
  }
  return out;
}

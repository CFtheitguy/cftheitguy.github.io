/* =============================================================================
 * Linear Meet — meet.linearit.co
 * =============================================================================
 * Video and voice meetings you join with a link. No signup, no app.
 *
 * Three moving parts in this file:
 *
 *   The Worker (default export)
 *       - /ws?room=NAME&cid=ID  -> the MeetRoom Durable Object for that room
 *       - /api/sfu/...          -> proxy to the Cloudflare Realtime SFU, so the
 *                                  browser never sees REALTIME_APP_SECRET
 *       - /api/ice              -> STUN (and TURN, when a TURN key is set)
 *       - /api/status           -> are the Realtime credentials set and valid?
 *       - everything else       -> reverse-proxy of www.linearit.co/meet/, so
 *                                  there is only one copy of the front-end
 *
 *   MeetRoom (a Durable Object, one per room name)
 *       Signaling only: who is in the room, which SFU session and tracks each
 *       person publishes, mute/camera/hand state, chat, and host controls.
 *       Audio and video never pass through here — they go browser -> SFU ->
 *       browser. Nothing is written to storage except the room's lock flag,
 *       which is cleared when the last person leaves.
 *
 *   Tickets
 *       On joining, the room hands each person a short-lived HMAC ticket
 *       (signed with REALTIME_APP_SECRET). The SFU proxy and /api/ice only
 *       answer requests carrying a valid ticket, so nobody can use this Worker
 *       as a free relay without first being in a room from an allowed origin.
 *
 * ENV
 *   ROOMS                 Durable Object namespace (wrangler.toml)
 *   REALTIME_APP_ID       Realtime SFU app id (wrangler.toml; not a secret)
 *   REALTIME_APP_SECRET   Realtime SFU app secret (encrypted Secret — required)
 *   TURN_KEY_ID           optional, Cloudflare TURN key id
 *   TURN_KEY_API_TOKEN    optional, encrypted Secret for that TURN key
 *   APP_ORIGIN / APP_PATH where the front-end lives (default www.linearit.co/meet/)
 * ========================================================================== */

const MAX_PEOPLE = 16;               // people in one room at once
const MAX_MSG_BYTES = 16 * 1024;     // one incoming WebSocket message
const MAX_CHAT_LEN = 1000;           // characters in one chat message
const MAX_NAME_LEN = 40;
const MAX_TRACKS = 4;                // mic, cam, screen (+ screen audio)
const TICKET_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 1000;
const RATE_MAX_MSGS = 30;

const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CID_RE = /^[a-z0-9]{8,32}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,200}$/;
const TRACK_RE = /^[a-z0-9-]{1,64}$/;
const REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"];

const ALLOWED_ORIGINS = [
  "https://www.linearit.co",
  "https://linearit.co",
  "https://meet.linearit.co",
  "https://cftheitguy.github.io",
];

const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps/";

/* ============================================================
 * The Worker
 * ============================================================ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      if (request.method === "OPTIONS") return cors(request, url, new Response(null, { status: 204 }));
      return cors(request, url, await api(request, env, url, path));
    }
    if (path === "/ws") return handleSocket(request, env, url);
    return proxyApp(request, env, url);
  },
};

async function api(request, env, url, path) {
  if (path === "/api/health") return text("ok");
  if (path === "/api/status" && request.method === "GET") return status(env);

  const origin = request.headers.get("Origin");
  if (origin && !originAllowed(origin, url)) return json({ error: "Not allowed from this origin." }, 403);

  const ticket = request.headers.get("X-Meet-Ticket") || "";
  if (!(await checkTicket(env, ticket))) return json({ error: "Join a room first." }, 401);

  if (path === "/api/ice" && request.method === "GET") return ice(env);

  if (path === "/api/sfu/sessions/new" && request.method === "POST") return sfu(request, env, "/sessions/new");
  const m = path.match(/^\/api\/sfu\/sessions\/([^/]+)\/(tracks\/new|renegotiate|tracks\/close)$/);
  if (m && SESSION_RE.test(m[1])) {
    const want = m[2] === "tracks/new" ? "POST" : "PUT";
    if (request.method !== want) return json({ error: "Method not allowed." }, 405);
    return sfu(request, env, "/sessions/" + m[1] + "/" + m[2]);
  }
  return json({ error: "Not found." }, 404);
}

function configured(env) { return !!(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET); }

async function sfu(request, env, path) {
  if (!configured(env)) return json({ error: "Meetings aren't switched on yet (REALTIME_APP_SECRET is not set)." }, 503);
  const body = await request.text();
  if (body.length > 256 * 1024) return json({ error: "Request too large." }, 413);
  let res;
  try {
    res = await fetch(SFU_BASE + env.REALTIME_APP_ID + path, {
      method: request.method,
      headers: { Authorization: "Bearer " + env.REALTIME_APP_SECRET, "Content-Type": "application/json" },
      body: body || "{}",
    });
  } catch (_) {
    return json({ error: "The call service is unreachable." }, 502);
  }
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function status(env) {
  if (!configured(env)) return json({ configured: false, ok: false, turn: false });
  const turn = !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);
  try {
    const res = await fetch(SFU_BASE + env.REALTIME_APP_ID + "/sessions/new", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.REALTIME_APP_SECRET, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) return json({ configured: true, ok: true, turn });
    return json({ configured: true, ok: false, turn, status: res.status });
  } catch (_) {
    return json({ configured: true, ok: false, turn, error: "unreachable" });
  }
}

const STUN = [{ urls: "stun:stun.cloudflare.com:3478" }];
async function ice(env) {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + env.TURN_KEY_ID + "/credentials/generate-ice-servers", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.TURN_KEY_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length) return json({ iceServers: data.iceServers });
      }
    } catch (_) { /* fall back to STUN */ }
  }
  return json({ iceServers: STUN });
}

/* ---- Tickets: base64url(exp.room).hmac ---------------------------------- */
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("linear-meet:" + (env.REALTIME_APP_SECRET || "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}
function b64url(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeTicket(env, room) {
  const payload = (Date.now() + TICKET_TTL_MS) + "." + room;
  return payload + "." + (await hmac(env, payload));
}
async function checkTicket(env, ticket) {
  if (!env.REALTIME_APP_SECRET || typeof ticket !== "string" || ticket.length > 300) return false;
  const i = ticket.lastIndexOf(".");
  if (i < 0) return false;
  const payload = ticket.slice(0, i);
  const exp = Number(payload.split(".")[0]);
  if (!exp || exp < Date.now()) return false;
  return safeEqual(ticket.slice(i + 1), await hmac(env, payload));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---- Helpers ------------------------------------------------------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function text(s, status = 200) {
  return new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
function sameHost(origin, url) { try { return new URL(origin).host === url.host; } catch (_) { return false; } }
function originAllowed(origin, url) { return ALLOWED_ORIGINS.includes(origin) || sameHost(origin, url); }
function cors(request, url, res) {
  const origin = request.headers.get("Origin");
  if (!origin || !originAllowed(origin, url)) return res;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Meet-Ticket");
  h.set("Access-Control-Max-Age", "600");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

async function handleSocket(request, env, url) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }
  const origin = request.headers.get("Origin");
  if (origin && !originAllowed(origin, url)) return new Response("Not allowed from this origin.", { status: 403 });
  const room = String(url.searchParams.get("room") || "").toLowerCase();
  if (!ROOM_RE.test(room)) return new Response("Bad room name.", { status: 400 });
  const cid = String(url.searchParams.get("cid") || "").toLowerCase();
  if (!CID_RE.test(cid)) return new Response("Bad client id.", { status: 400 });
  return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
}

async function proxyApp(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/meet/";
  // Only the app's own folder is served; meet.linearit.co/x is the app too.
  const path = url.pathname.startsWith(appPath) ? url.pathname
    : (url.pathname.startsWith("/assets/") ? appPath + url.pathname.slice(1) : appPath);
  let res;
  try {
    res = await fetch(origin + path, { headers: { Accept: request.headers.get("Accept") || "*/*" }, redirect: "follow" });
  } catch (_) {
    return text("Linear Meet is briefly unavailable. Please try again in a moment.", 503);
  }
  if (res.status === 404) return text("Not found", 404);
  const h = new Headers(res.headers);
  h.delete("set-cookie");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cache-Control", "no-store, must-revalidate");
  h.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  h.set("X-Served-By", "linear-meet");
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers: h });
}

/* ============================================================
 * MeetRoom — one per room name
 * ============================================================
 * Each socket carries an attachment (survives hibernation):
 *   { cid, room, name, joined, joinedAt, sessionId, tracks, muted, camOff, hand }
 * "joined" is false until the person sends `hello` from the lobby.
 * The host is the earliest person still in the room, unless a host handed
 * the role on; storage holds only { host, locked }.
 * ========================================================================== */
export class MeetRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rate = new Map();
    this.closing = new Set();   // sockets closing in this invocation
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = String(url.searchParams.get("room") || "").toLowerCase();
    const cid = String(url.searchParams.get("cid") || "").toLowerCase();

    // Same browser reconnecting: drop its old socket first.
    let rejoin = false;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.cid === cid) {
        // Quietly: the same person is coming straight back on the new socket.
        rejoin = rejoin || a.joined;
        a.joined = false; ws.serializeAttachment(a);
        this.closing.add(ws);
        try { ws.close(4000, "replaced"); } catch (_) {}
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ cid, room, name: "", joined: false, rejoin, joinedAt: 0, sessionId: null, tracks: [], muted: false, camOff: false, hand: false });
    this.send(server, { t: "lobby", count: this.people().length, locked: !!(await this.state.storage.get("locked")) });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() {
    return this.state.getWebSockets().filter((ws) => !this.closing.has(ws))
      .map((ws) => ({ ws, a: ws.deserializeAttachment() })).filter((x) => x.a);
  }
  people() { return this.sockets().filter((x) => x.a.joined); }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (_) {} }
  broadcast(msg, exceptCid) {
    const s = JSON.stringify(msg);
    for (const { ws, a } of this.people()) if (a.cid !== exceptCid) { try { ws.send(s); } catch (_) {} }
  }

  async hostCid() {
    const people = this.people();
    if (!people.length) return null;
    const stored = await this.state.storage.get("host");
    if (stored && people.some((p) => p.a.cid === stored)) return stored;
    const first = people.sort((x, y) => x.a.joinedAt - y.a.joinedAt)[0].a.cid;
    await this.state.storage.put("host", first);
    return first;
  }

  async roster() {
    const host = await this.hostCid();
    const locked = !!(await this.state.storage.get("locked"));
    const people = this.people().sort((x, y) => x.a.joinedAt - y.a.joinedAt).map(({ a }) => ({
      cid: a.cid, name: a.name, sessionId: a.sessionId, tracks: a.tracks,
      muted: a.muted, camOff: a.camOff, hand: a.hand, host: a.cid === host,
    }));
    this.broadcast({ t: "roster", people, locked });
    // Lobby screens just show how many are inside.
    for (const { ws, a } of this.sockets()) if (!a.joined) this.send(ws, { t: "lobby", count: people.length, locked });
  }

  limited(ws) {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.start > RATE_WINDOW_MS) { r = { start: now, n: 0 }; this.rate.set(ws, r); }
    return ++r.n > RATE_MAX_MSGS;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return;
    if (this.limited(ws)) return;
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== "string") return;
    const a = ws.deserializeAttachment();
    if (!a) return;

    if (m.t === "ping") return this.send(ws, { t: "pong" });

    if (m.t === "hello") {
      if (!a.joined && !a.rejoin) {
        if (await this.state.storage.get("locked")) return this.send(ws, { t: "denied", reason: "locked" });
        if (this.people().length >= MAX_PEOPLE) return this.send(ws, { t: "denied", reason: "full" });
      }
      a.name = cleanName(m.name);
      a.muted = !!m.muted; a.camOff = !!m.camOff;
      if (!a.joined) { a.joined = true; a.joinedAt = Date.now(); }
      ws.serializeAttachment(a);
      this.send(ws, { t: "welcome", cid: a.cid, ticket: await makeTicket(this.env, a.room) });
      this.broadcast({ t: "notice", text: a.name + " joined" }, a.cid);
      return this.roster();
    }

    if (!a.joined) return;

    switch (m.t) {
      case "state": {
        if (m.sessionId !== undefined) a.sessionId = typeof m.sessionId === "string" && SESSION_RE.test(m.sessionId) ? m.sessionId : null;
        if (Array.isArray(m.tracks)) {
          a.tracks = m.tracks.slice(0, MAX_TRACKS)
            .filter((t) => t && TRACK_RE.test(t.trackName) && ["mic", "cam", "screen", "screenaudio"].includes(t.kind))
            .map((t) => ({ trackName: t.trackName, kind: t.kind }));
        }
        if (typeof m.muted === "boolean") a.muted = m.muted;
        if (typeof m.camOff === "boolean") a.camOff = m.camOff;
        if (typeof m.hand === "boolean") a.hand = m.hand;
        if (typeof m.name === "string") a.name = cleanName(m.name);
        ws.serializeAttachment(a);
        return this.roster();
      }
      case "chat": {
        const text = String(m.text || "").slice(0, MAX_CHAT_LEN).trim();
        if (!text) return;
        return this.broadcast({ t: "chat", from: a.cid, name: a.name, text, ts: Date.now() });
      }
      case "react": {
        if (!REACTIONS.includes(m.emoji)) return;
        return this.broadcast({ t: "react", from: a.cid, name: a.name, emoji: m.emoji });
      }
      case "host": return this.hostAction(ws, a, m);
    }
  }

  async hostAction(ws, a, m) {
    if ((await this.hostCid()) !== a.cid) return this.send(ws, { t: "notice", text: "Only the host can do that." });
    const target = this.people().find((p) => p.a.cid === m.target);
    switch (m.action) {
      case "mute":
        if (target) this.send(target.ws, { t: "force-mute", by: a.name });
        return;
      case "mute-all":
        for (const p of this.people()) if (p.a.cid !== a.cid) this.send(p.ws, { t: "force-mute", by: a.name });
        return this.broadcast({ t: "notice", text: a.name + " muted everyone" });
      case "remove":
        if (!target || target.a.cid === a.cid) return;
        this.send(target.ws, { t: "removed", by: a.name });
        this.closing.add(target.ws);
        try { target.ws.close(4001, "removed"); } catch (_) {}
        this.broadcast({ t: "notice", text: target.a.name + " was removed" });
        return this.roster();
      case "make-host":
        if (!target) return;
        await this.state.storage.put("host", target.a.cid);
        this.broadcast({ t: "notice", text: target.a.name + " is now the host" });
        return this.roster();
      case "lock":
      case "unlock":
        await this.state.storage.put("locked", m.action === "lock");
        this.broadcast({ t: "notice", text: m.action === "lock" ? "The meeting is locked — nobody else can join" : "The meeting is unlocked" });
        return this.roster();
    }
  }

  async gone(ws) {
    let a = null; try { a = ws.deserializeAttachment(); } catch (_) {}
    this.rate.delete(ws);
    const quiet = this.closing.has(ws);   // removed by the host / replaced: already announced
    this.closing.add(ws);
    if (!this.people().length) await this.state.storage.deleteAll();
    if (a && a.joined && !quiet) {
      this.broadcast({ t: "notice", text: (a.name || "Someone") + " left" }, a.cid);
    }
    await this.roster();
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
}

function cleanName(s) {
  const n = String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, MAX_NAME_LEN);
  return n || "Guest";
}

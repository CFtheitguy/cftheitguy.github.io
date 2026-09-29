/* =============================================================================
 * Linear Meet backend — lives inside the linear-chat Worker at /meet-api/*
 * =============================================================================
 * Why here: linear-chat already auto-deploys from GitHub and already holds the
 * Cloudflare Realtime credentials (REALTIME_APP_ID / REALTIME_APP_SECRET), so
 * Meet goes live on merge with nothing to set up in the Cloudflare dashboard.
 * It shares nothing with chat except the D1 binding, and uses its own tables
 * (meet_*). It needs no login: anyone with a meeting link can join.
 *
 * Signaling is polled, not a WebSocket: each browser POSTs /meet-api/sync
 * about once a second with whatever it has to say, and gets back whatever
 * happened since its cursor. (Chat's earlier Durable Object attempt caused
 * deployment trouble, so this avoids adding one.) Audio and video never touch
 * this Worker — they go browser -> Realtime SFU -> browser.
 *
 * Routes (all CORS-enabled for linearit.co):
 *   GET  /meet-api/status                  Realtime credentials set + accepted?
 *   POST /meet-api/sync                    join / heartbeat / chat / host actions
 *   GET  /meet-api/ice                     STUN or TURN servers (ticket)
 *   POST /meet-api/sfu/sessions/new        -> Realtime SFU (ticket)
 *   POST /meet-api/sfu/sessions/:id/tracks/new
 *   PUT  /meet-api/sfu/sessions/:id/renegotiate
 *   PUT  /meet-api/sfu/sessions/:id/tracks/close
 *
 * Tickets: joining returns an HMAC ticket bound to room + person, signed with
 * REALTIME_APP_SECRET. The SFU proxy and every in-room action require it, so
 * the proxy is not an open relay and nobody can act as someone else.
 * ========================================================================== */

const MAX_PEOPLE = 16;
const MAX_CHAT_LEN = 1000;
const MAX_NAME_LEN = 40;
const MAX_TRACKS = 4;
const MAX_OUT = 30;                       // queued messages accepted per sync
const MAX_SIGNAL = 24000;                 // one SDP offer/answer or ICE candidate
const GONE_MS = 20000;                    // no sync for this long = left
const TICKET_TTL_MS = 12 * 60 * 60 * 1000;
const EVENT_KEEP_MS = 60 * 60 * 1000;

const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CID_RE = /^[a-z0-9]{8,32}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,200}$/;
const TRACK_RE = /^[a-z0-9-]{1,64}$/;
const KINDS = ["mic", "cam", "screen", "screenaudio"];
const REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"];
const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps/";

const ALLOWED_ORIGINS = [
  "https://www.linearit.co",
  "https://linearit.co",
  "https://chat.linearit.co",
  "https://meet.linearit.co",
  "https://cftheitguy.github.io",
];

let MEET_SCHEMA_READY = false;

export async function handleMeet(request, env, url) {
  env = withRealtime(env);
  if (request.method === "OPTIONS") return meetCors(request, new Response(null, { status: 204 }));
  let res;
  try { res = await route(request, env, url); }
  catch (e) { res = json({ error: String((e && e.message) || e) }, (e && e.status) || 500); }
  return meetCors(request, res);
}

async function route(request, env, url) {
  const p = url.pathname;
  const m = request.method;
  if (p === "/meet-api/status" && m === "GET") return status(env);

  const origin = request.headers.get("Origin");
  if (origin && !originOk(origin)) return json({ error: "Not allowed from this origin." }, 403);

  if (p === "/meet-api/sync" && m === "POST") return sync(request, env);

  // Everything below needs a valid ticket.
  if (!(await readTicket(env, request.headers.get("X-Meet-Ticket")))) return json({ error: "Join a meeting first." }, 401);
  if (p === "/meet-api/ice" && m === "GET") return ice(env);
  if (p === "/meet-api/sfu/sessions/new" && m === "POST") return sfu(request, env, "/sessions/new");
  const sm = p.match(/^\/meet-api\/sfu\/sessions\/([^/]+)\/(tracks\/new|renegotiate|tracks\/close)$/);
  if (sm && SESSION_RE.test(sm[1])) {
    if (m !== (sm[2] === "tracks/new" ? "POST" : "PUT")) return json({ error: "Method not allowed." }, 405);
    return sfu(request, env, "/sessions/" + sm[1] + "/" + sm[2]);
  }
  return json({ error: "Not found." }, 404);
}

/* ---------------- Realtime SFU ---------------- */
// Dashboard-entered names/values can pick up stray spaces or a trailing
// newline from pasting; find the Realtime settings tolerantly and trim them.
export function withRealtime(env) {
  if (env._realtimeNames) return env;   // already normalised
  const find = (name) => {
    if (typeof env[name] === "string" && env[name].trim()) return env[name].trim();
    const k = Object.keys(env).find((x) => x.trim().toUpperCase() === name);
    return k && typeof env[k] === "string" ? env[k].trim() : "";
  };
  return Object.assign({}, env, { REALTIME_APP_ID: find("REALTIME_APP_ID"), REALTIME_APP_SECRET: find("REALTIME_APP_SECRET"), _realtimeNames: Object.keys(env).filter((k) => /realtime/i.test(k)) });
}

function configured(env) { return !!(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET); }

async function sfu(request, env, path) {
  if (!configured(env)) return json({ error: "Meetings aren't switched on yet." }, 503);
  const body = await request.text();
  if (body.length > 256 * 1024) return json({ error: "Request too large." }, 413);
  let res;
  try {
    res = await fetch(SFU_BASE + env.REALTIME_APP_ID + path, {
      method: request.method,
      headers: { Authorization: "Bearer " + env.REALTIME_APP_SECRET, "Content-Type": "application/json" },
      // The SFU rejects an empty "{}" (it validates the fields as present), so
      // a request with nothing to say is sent with no body at all.
      body: body && body.trim() !== "{}" ? body : undefined,
    });
  } catch (_) { return json({ error: "The call service is unreachable." }, 502); }
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function status(env) {
  const turn = !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);
  // Say which value is missing (never the values themselves), to make setup problems obvious.
  if (!configured(env)) return json({ configured: false, ok: false, turn, hasAppId: !!env.REALTIME_APP_ID, hasSecret: !!env.REALTIME_APP_SECRET,
    // Setting NAMES only (quoted so stray spaces show) — never values.
    realtimeNames: env._realtimeNames.map((k) => JSON.stringify(k)) });
  try {
    const res = await fetch(SFU_BASE + env.REALTIME_APP_ID + "/sessions/new", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.REALTIME_APP_SECRET, "Content-Type": "application/json" },
    });
    // Cloudflare's own error text (it never echoes the secret) makes a bad
    // App ID / secret pair diagnosable without dashboard access.
    const detail = res.ok ? undefined : (await res.text()).slice(0, 300);
    return json({ configured: true, ok: res.ok, turn, status: res.status, detail, appId: env.REALTIME_APP_ID.slice(0, 8) + "…" });
  } catch (_) { return json({ configured: true, ok: false, turn, error: "unreachable" }); }
}

async function ice(env) {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + env.TURN_KEY_ID + "/credentials/generate-ice-servers", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.TURN_KEY_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d && Array.isArray(d.iceServers) && d.iceServers.length) return json({ iceServers: d.iceServers });
      }
    } catch (_) { /* fall back to STUN */ }
  }
  return json({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
}

/* ---------------- tickets ---------------- */
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("linear-meet:" + (env.REALTIME_APP_SECRET || env.AUTH_SECRET || "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  let s = ""; for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeTicket(env, room, cid) {
  const payload = (Date.now() + TICKET_TTL_MS) + "." + room + "." + cid;
  return payload + "." + (await hmac(env, payload));
}
// Returns { room, cid } for a valid ticket, else null.
async function readTicket(env, t) {
  if (typeof t !== "string" || t.length > 300) return null;
  const parts = t.split(".");
  if (parts.length !== 4) return null;
  const [exp, room, cid, sig] = parts;
  if (!(Number(exp) > Date.now())) return null;
  const good = await hmac(env, exp + "." + room + "." + cid);
  if (sig.length !== good.length) return null;
  let d = 0; for (let i = 0; i < sig.length; i++) d |= sig.charCodeAt(i) ^ good.charCodeAt(i);
  return d === 0 ? { room, cid } : null;
}

/* ---------------- schema ---------------- */
async function ensureMeetSchema(env) {
  if (MEET_SCHEMA_READY) return;
  if (!env.DB) { const e = new Error("Database not configured."); e.status = 500; throw e; }
  const stmts = [
    "CREATE TABLE IF NOT EXISTS meet_people (room TEXT NOT NULL, cid TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, tracks TEXT NOT NULL DEFAULT '[]', muted INTEGER NOT NULL DEFAULT 0, cam_off INTEGER NOT NULL DEFAULT 0, hand INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (room, cid))",
    "CREATE TABLE IF NOT EXISTS meet_rooms (room TEXT PRIMARY KEY, host TEXT, locked INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS meet_events (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, from_cid TEXT, name TEXT, target TEXT, data TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_meet_events_room ON meet_events(room, id)",
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  MEET_SCHEMA_READY = true;
}

/* ---------------- sync ---------------- */
// Body: { room, cid, ticket?, cursor?, rosterTag?, hello?:{name,muted,camOff},
//         state?:{...}, out?:[{t:'chat'|'react'|'host', ...}], leave?:true }
// Reply: { msgs:[...same shapes the page handles...], cursor, rosterTag }
async function sync(request, env) {
  await ensureMeetSchema(env);
  const b = await request.json().catch(() => ({}));
  const room = String(b.room || "").toLowerCase();
  const cid = String(b.cid || "").toLowerCase();
  if (!ROOM_RE.test(room) || !CID_RE.test(cid)) return json({ error: "Bad room or client id." }, 400);
  const db = env.DB;
  const now = Date.now();
  const msgs = [];

  await sweep(env, room, now);

  let me = await db.prepare("SELECT * FROM meet_people WHERE room=? AND cid=?").bind(room, cid).first();
  const t = b.ticket ? await readTicket(env, b.ticket) : null;
  const authed = !!(me && t && t.room === room && t.cid === cid);

  if (me && me.removed) {
    if (authed) {
      await db.prepare("DELETE FROM meet_people WHERE room=? AND cid=?").bind(room, cid).run();
      return json({ msgs: [{ t: "removed", by: "The host" }] });
    }
    me = null;
  }

  if (b.leave) {
    if (authed) {
      await db.prepare("DELETE FROM meet_people WHERE room=? AND cid=?").bind(room, cid).run();
      await addEvent(env, room, "notice", cid, me.name, null, { text: me.name + " left" });
    }
    return json({ ok: true });
  }

  let cursor = Number(b.cursor) || 0;
  const roomRow = await db.prepare("SELECT * FROM meet_rooms WHERE room=?").bind(room).first();
  const locked = !!(roomRow && roomRow.locked);

  if (b.hello) {
    const name = cleanName(b.hello.name);
    const muted = b.hello.muted ? 1 : 0, camOff = b.hello.camOff ? 1 : 0;
    if (me && authed) {
      // Same person reconnecting: keep their place, refresh the details.
      await db.prepare("UPDATE meet_people SET name=?, muted=?, cam_off=?, last_seen=? WHERE room=? AND cid=?")
        .bind(name, muted, camOff, now, room, cid).run();
    } else {
      const count = (await db.prepare("SELECT COUNT(*) AS n FROM meet_people WHERE room=? AND removed=0").bind(room).first()).n;
      if (locked) return json({ msgs: [{ t: "denied", reason: "locked" }] });
      if (count >= MAX_PEOPLE) return json({ msgs: [{ t: "denied", reason: "full" }] });
      await db.prepare(
        "INSERT INTO meet_people (room,cid,name,session_id,tracks,muted,cam_off,hand,removed,joined_at,last_seen) VALUES (?,?,?,NULL,'[]',?,?,0,0,?,?) " +
        "ON CONFLICT(room,cid) DO UPDATE SET name=excluded.name, session_id=NULL, tracks='[]', muted=excluded.muted, cam_off=excluded.cam_off, hand=0, removed=0, joined_at=excluded.joined_at, last_seen=excluded.last_seen"
      ).bind(room, cid, name, muted, camOff, now, now).run();
      if (!roomRow) await db.prepare("INSERT OR IGNORE INTO meet_rooms (room, host, locked, updated) VALUES (?,?,0,?)").bind(room, cid, now).run();
      // A newcomer starts from "now": no replay of earlier chat.
      const top = await db.prepare("SELECT MAX(id) AS id FROM meet_events WHERE room=?").bind(room).first();
      cursor = (top && top.id) || 0;
      await addEvent(env, room, "notice", cid, name, null, { text: name + " joined" });
    }
    msgs.push({ t: "welcome", cid, ticket: await makeTicket(env, room, cid) });
    me = await db.prepare("SELECT * FROM meet_people WHERE room=? AND cid=?").bind(room, cid).first();
  } else if (!authed) {
    // Lobby peek: how many are inside, is it locked.
    const count = (await db.prepare("SELECT COUNT(*) AS n FROM meet_people WHERE room=? AND removed=0").bind(room).first()).n;
    return json({ msgs: [{ t: "lobby", count, locked }] });
  }

  // ---- in the room ----
  const s = b.state || {};
  const upd = { last_seen: now };
  if (s.sessionId !== undefined) upd.session_id = typeof s.sessionId === "string" && SESSION_RE.test(s.sessionId) ? s.sessionId : null;
  if (Array.isArray(s.tracks)) {
    upd.tracks = JSON.stringify(s.tracks.slice(0, MAX_TRACKS)
      .filter((x) => x && TRACK_RE.test(x.trackName) && KINDS.includes(x.kind))
      .map((x) => ({ trackName: x.trackName, kind: x.kind })));
  }
  if (typeof s.muted === "boolean") upd.muted = s.muted ? 1 : 0;
  if (typeof s.camOff === "boolean") upd.cam_off = s.camOff ? 1 : 0;
  if (typeof s.hand === "boolean") upd.hand = s.hand ? 1 : 0;
  const cols = Object.keys(upd);
  await db.prepare("UPDATE meet_people SET " + cols.map((c) => c + "=?").join(",") + " WHERE room=? AND cid=?")
    .bind(...cols.map((c) => upd[c]), room, cid).run();

  const host = await hostOf(env, room);
  for (const o of (Array.isArray(b.out) ? b.out.slice(0, MAX_OUT) : [])) {
    if (!o || typeof o.t !== "string") continue;
    if (o.t === "chat") {
      const text = String(o.text || "").slice(0, MAX_CHAT_LEN).trim();
      if (text) await addEvent(env, room, "chat", cid, me.name, null, { text });
    } else if (o.t === "react") {
      if (REACTIONS.includes(o.emoji)) await addEvent(env, room, "react", cid, me.name, null, { emoji: o.emoji });
    } else if (o.t === "signal") {
      // Peer-to-peer mode: pass an offer/answer/ICE candidate to one person.
      const data = JSON.stringify(o.data || null);
      if (typeof o.target === "string" && CID_RE.test(o.target) && data.length <= MAX_SIGNAL
        && await db.prepare("SELECT 1 FROM meet_people WHERE room=? AND cid=? AND removed=0").bind(room, o.target).first()) {
        await db.prepare("INSERT INTO meet_events (room, ts, kind, from_cid, name, target, data) VALUES (?,?,?,?,?,?,?)")
          .bind(room, now, "signal", cid, me.name, o.target, data).run();
      }
    } else if (o.t === "host") {
      if (host !== cid) { msgs.push({ t: "notice", text: "Only the host can do that." }); continue; }
      await hostAction(env, room, me, o);
    }
  }

  // Events since the cursor that concern this person.
  const evs = (await db.prepare(
    "SELECT * FROM meet_events WHERE room=? AND id>? AND (target IS NULL OR target=?) ORDER BY id LIMIT 200"
  ).bind(room, cursor, cid).all()).results || [];
  for (const e of evs) {
    cursor = e.id;
    const d = safeParse(e.data);
    if (e.kind === "notice") { if (e.from_cid !== cid) msgs.push({ t: "notice", text: d.text }); }
    else if (e.kind === "chat") msgs.push({ t: "chat", from: e.from_cid, name: e.name, text: d.text, ts: e.ts });
    else if (e.kind === "react") msgs.push({ t: "react", from: e.from_cid, name: e.name, emoji: d.emoji });
    else if (e.kind === "signal") msgs.push({ t: "signal", from: e.from_cid, data: safeParse(e.data, null) });
    else if (e.kind === "force-mute") msgs.push({ t: "force-mute", by: e.name });
  }

  // Roster, only when it changed since the caller's last copy.
  const rows = (await db.prepare("SELECT * FROM meet_people WHERE room=? AND removed=0 ORDER BY joined_at").bind(room).all()).results || [];
  const hostNow = await hostOf(env, room);
  const lockedNow = !!((await db.prepare("SELECT locked FROM meet_rooms WHERE room=?").bind(room).first()) || {}).locked;
  const people = rows.map((r) => ({
    cid: r.cid, name: r.name, sessionId: r.session_id, tracks: safeParse(r.tracks, []),
    muted: !!r.muted, camOff: !!r.cam_off, hand: !!r.hand, host: r.cid === hostNow,
  }));
  const rosterTag = await tag(JSON.stringify([people, lockedNow]));
  if (rosterTag !== b.rosterTag || b.hello) msgs.push({ t: "roster", people, locked: lockedNow });

  return json({ msgs, cursor, rosterTag });
}

async function hostAction(env, room, me, o) {
  const db = env.DB;
  const target = typeof o.target === "string" && CID_RE.test(o.target)
    ? await db.prepare("SELECT * FROM meet_people WHERE room=? AND cid=? AND removed=0").bind(room, o.target).first() : null;
  switch (o.action) {
    case "mute":
      if (target) await addEvent(env, room, "force-mute", me.cid, me.name, target.cid, {});
      return;
    case "mute-all": {
      const rows = (await db.prepare("SELECT cid FROM meet_people WHERE room=? AND removed=0 AND cid<>?").bind(room, me.cid).all()).results || [];
      for (const r of rows) await addEvent(env, room, "force-mute", me.cid, me.name, r.cid, {});
      return addEvent(env, room, "notice", null, me.name, null, { text: me.name + " muted everyone" });
    }
    case "remove":
      if (!target || target.cid === me.cid) return;
      await db.prepare("UPDATE meet_people SET removed=1 WHERE room=? AND cid=?").bind(room, target.cid).run();
      return addEvent(env, room, "notice", null, me.name, null, { text: target.name + " was removed" });
    case "make-host":
      if (!target) return;
      await db.prepare("UPDATE meet_rooms SET host=?, updated=? WHERE room=?").bind(target.cid, Date.now(), room).run();
      return addEvent(env, room, "notice", null, me.name, null, { text: target.name + " is now the host" });
    case "lock":
    case "unlock":
      await db.prepare("UPDATE meet_rooms SET locked=?, updated=? WHERE room=?").bind(o.action === "lock" ? 1 : 0, Date.now(), room).run();
      return addEvent(env, room, "notice", null, me.name, null,
        { text: o.action === "lock" ? "The meeting is locked — nobody else can join" : "The meeting is unlocked" });
  }
}

// The stored host if still present, otherwise whoever has been in longest.
async function hostOf(env, room) {
  const db = env.DB;
  const r = await db.prepare("SELECT host FROM meet_rooms WHERE room=?").bind(room).first();
  if (r && r.host && await db.prepare("SELECT 1 FROM meet_people WHERE room=? AND cid=? AND removed=0").bind(room, r.host).first()) return r.host;
  const first = await db.prepare("SELECT cid FROM meet_people WHERE room=? AND removed=0 ORDER BY joined_at LIMIT 1").bind(room).first();
  if (!first) return null;
  await db.prepare("INSERT INTO meet_rooms (room, host, locked, updated) VALUES (?,?,0,?) ON CONFLICT(room) DO UPDATE SET host=excluded.host, updated=excluded.updated")
    .bind(room, first.cid, Date.now()).run();
  return first.cid;
}

// Drop people who stopped syncing; clear out empty rooms and old events.
async function sweep(env, room, now) {
  const db = env.DB;
  const stale = (await db.prepare("SELECT cid, name, removed FROM meet_people WHERE room=? AND last_seen<?").bind(room, now - GONE_MS).all()).results || [];
  for (const p of stale) {
    await db.prepare("DELETE FROM meet_people WHERE room=? AND cid=?").bind(room, p.cid).run();
    if (!p.removed) await addEvent(env, room, "notice", p.cid, p.name, null, { text: p.name + " left" });
  }
  const left = await db.prepare("SELECT 1 FROM meet_people WHERE room=? LIMIT 1").bind(room).first();
  if (!left) {
    await db.prepare("DELETE FROM meet_rooms WHERE room=?").bind(room).run();
    await db.prepare("DELETE FROM meet_events WHERE room=?").bind(room).run();
  }
  if (Math.random() < 0.02) {
    await db.prepare("DELETE FROM meet_events WHERE ts<?").bind(now - EVENT_KEEP_MS).run();
    await db.prepare("DELETE FROM meet_people WHERE last_seen<?").bind(now - 10 * GONE_MS).run();
  }
}

async function addEvent(env, room, kind, fromCid, name, target, data) {
  await env.DB.prepare("INSERT INTO meet_events (room, ts, kind, from_cid, name, target, data) VALUES (?,?,?,?,?,?,?)")
    .bind(room, Date.now(), kind, fromCid, name, target, JSON.stringify(data || {})).run();
}

/* ---------------- helpers ---------------- */
function cleanName(s) {
  const n = String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, MAX_NAME_LEN);
  return n || "Guest";
}
function safeParse(s, fb = {}) { try { return JSON.parse(s || ""); } catch (_) { return fb; } }
async function tag(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d.slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function originOk(o) { return ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o); }
function meetCors(request, res) {
  const origin = request.headers.get("Origin");
  const h = new Headers(res.headers);
  if (origin && originOk(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, X-Meet-Ticket");
    h.set("Access-Control-Max-Age", "600");
  }
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

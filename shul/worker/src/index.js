/**
 * Shul Alerts — mass-SMS broadcast worker
 * =======================================
 * A small, self-contained Cloudflare Worker that texts your whole congregation
 * (zmanim changes, events, announcements). It is INTENTIONALLY separate from the
 * Linear Phone project: its own worker, its own D1 database, its own phone number.
 *
 * What it does:
 *   - Stores your subscriber list (you import it; people are never auto-added).
 *   - Queues a message to everyone and sends it in small batches (so an 800-person
 *     blast finishes reliably without hitting Cloudflare free-plan limits).
 *   - Honors STOP / START automatically (legally required) and never texts anyone
 *     who opted out.
 *
 * SMS provider: SignalWire's LaML REST API (cheapest tier-1, ~1c/text). To use a
 * different provider (e.g. Telnyx), you only rewrite providerSend() below.
 *
 * Required secrets (Cloudflare → this worker → Settings → Variables):
 *   SIGNALWIRE_SPACE     e.g. yourspace.signalwire.com
 *   SIGNALWIRE_PROJECT   the Project ID
 *   SIGNALWIRE_TOKEN     an API token
 *   SIGNALWIRE_NUMBER    the FROM number you registered, E.164 e.g. +18005551234
 *   APP_PASSWORD         password for the admin page
 *   AUTH_SECRET          a long random string (signs login tokens)
 *   ALLOW_ORIGIN         your site origin, e.g. https://cftheitguy.com
 * Optional:
 *   SMS_FOOTER           appended to each broadcast, e.g. " Reply STOP to opt out."
 *   BATCH_SIZE           recipients per /run call (default 25; keep <= 45)
 *
 * Binding:
 *   DB                   the D1 database (run schema.sql once)
 */

const STOP_WORDS  = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

    try {
      if (p === "/" && request.method === "GET") {
        return new Response("Shul Alerts online", { status: 200, headers: { "Content-Type": "text/plain" } });
      }

      // Inbound webhook from SignalWire (handles STOP / START). No auth: it's the carrier.
      if (p === "/sms/inbound" && request.method === "POST") return smsInbound(request, env);
      if (p === "/sms/status") return new Response("", { status: 200 });

      // ----- Admin API (password-protected) -----
      if (p === "/api/login") return cors(env, await login(request, env));

      if (p === "/api/subscribers" && request.method === "GET")
        return cors(env, await auth(request, env, () => listSubscribers(env, url)));
      if (p === "/api/subscribers/import" && request.method === "POST")
        return cors(env, await auth(request, env, () => importSubscribers(request, env)));
      if (p === "/api/subscribers/delete" && request.method === "POST")
        return cors(env, await auth(request, env, () => deleteSubscriber(request, env)));
      if (p === "/api/subscribers/optout" && request.method === "POST")
        return cors(env, await auth(request, env, () => setOptOut(request, env)));

      if (p === "/api/broadcast/create" && request.method === "POST")
        return cors(env, await auth(request, env, () => createBroadcast(request, env)));
      if (p === "/api/broadcast/run" && request.method === "POST")
        return cors(env, await auth(request, env, () => runBroadcast(request, env)));
      if (p === "/api/broadcast/status" && request.method === "GET")
        return cors(env, await auth(request, env, () => broadcastStatus(env, url)));
      if (p === "/api/broadcast/list" && request.method === "GET")
        return cors(env, await auth(request, env, () => listBroadcasts(env)));

      return cors(env, json({ error: "Not found" }, 404));
    } catch (err) {
      return cors(env, json({ error: String((err && err.message) || err) }, 500));
    }
  },
};

/* ============================================================ helpers */
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOW_ORIGIN || "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

// Normalize to E.164 (US default). Returns "" if it can't make a plausible number.
function e164(n) {
  let d = String(n || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) {
    const digits = d.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? "+" + digits : "";
  }
  d = d.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (d.length >= 8) return "+" + d; // already has a country code
  return "";
}

/* ============================================================ auth (HMAC bearer) */
async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function makeToken(env) {
  const payload = btoa(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }));
  return payload + "." + (await hmac(env, payload));
}
async function verifyToken(env, token) {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if ((await hmac(env, payload)) !== sig) return false;
  try { return JSON.parse(atob(payload)).exp > Date.now(); } catch { return false; }
}
async function login(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const { password } = await readBody(request);
  if (!password || password !== env.APP_PASSWORD) return json({ error: "Invalid password" }, 401);
  return json({ token: await makeToken(env) });
}
async function auth(request, env, handler) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await verifyToken(env, token))) return json({ error: "Unauthorized" }, 401);
  return await handler();
}

/* ============================================================ SMS provider */
// The ONLY provider-specific function. Swap this body to change providers.
async function providerSend(env, to, body) {
  const host = String(env.SIGNALWIRE_SPACE).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const form = new URLSearchParams({ From: env.SIGNALWIRE_NUMBER, To: to, Body: body });
  const res = await fetch(
    `https://${host}/api/laml/2010-04-01/Accounts/${env.SIGNALWIRE_PROJECT}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.SIGNALWIRE_PROJECT}:${env.SIGNALWIRE_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `provider ${res.status}`);
  }
  return await res.json().catch(() => ({}));
}

/* ============================================================ inbound STOP/START */
async function smsInbound(request, env) {
  const f = await readBody(request);
  const from = e164(f.From);
  const body = (f.Body || "").toString().trim();
  const word = body.toUpperCase().replace(/[^A-Z]/g, "");

  if (from && env.DB) {
    await env.DB.prepare("INSERT INTO inbound (number, body) VALUES (?,?)").bind(from, body).run();
    if (STOP_WORDS.has(word)) {
      await env.DB.prepare(
        "INSERT INTO subscribers (number, opted_out) VALUES (?, 1) ON CONFLICT(number) DO UPDATE SET opted_out=1"
      ).bind(from).run();
    } else if (START_WORDS.has(word)) {
      await env.DB.prepare("UPDATE subscribers SET opted_out=0 WHERE number=?").bind(from).run();
    }
  }
  // Empty TwiML — the carrier sends the required STOP/HELP auto-replies for a
  // registered number; we just record + suppress on our side.
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { "Content-Type": "text/xml" },
  });
}

/* ============================================================ subscribers */
async function listSubscribers(env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(opted_out) AS opted_out FROM subscribers"
  ).first();
  const rows = await env.DB.prepare(
    "SELECT id, name, number, opted_out FROM subscribers ORDER BY name IS NULL, name ASC, id ASC LIMIT ?"
  ).bind(limit).all();
  return json({
    total: counts?.total || 0,
    opted_out: counts?.opted_out || 0,
    active: (counts?.total || 0) - (counts?.opted_out || 0),
    subscribers: rows.results || [],
  });
}

// Accepts pasted lines or CSV. Each line: a phone number, optionally "Name, number"
// or "number, Name". The token with the most digits is treated as the number.
async function importSubscribers(request, env) {
  const b = await readBody(request);
  const text = (b.text || "").toString();
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const rows = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(name|phone|number|mobile|cell)\b/i.test(line) && /[a-z]{4,}/i.test(line) && !/\d{7,}/.test(line)) continue; // header
    const parts = line.split(/[,\t;]+/).map((s) => s.trim()).filter(Boolean);
    let numTok = "", best = -1;
    for (const part of parts.length ? parts : [line]) {
      const digits = (part.match(/\d/g) || []).length;
      if (digits > best) { best = digits; numTok = part; }
    }
    const number = e164(numTok);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    const name = parts.filter((x) => x !== numTok).join(" ").replace(/[",]/g, "").trim() || null;
    rows.push({ number, name });
  }

  if (!rows.length) return json({ imported: 0, skipped: lines.filter((l) => l.trim()).length });

  // Upsert in chunks (D1 batch limit friendly). New STOP-ed numbers stay opted out.
  const stmt = env.DB.prepare(
    "INSERT INTO subscribers (number, name) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET name=COALESCE(excluded.name, subscribers.name)"
  );
  let imported = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50).map((r) => stmt.bind(r.number, r.name));
    await env.DB.batch(chunk);
    imported += chunk.length;
  }
  return json({ imported, parsed: rows.length });
}

async function deleteSubscriber(request, env) {
  const { id } = await readBody(request);
  await env.DB.prepare("DELETE FROM subscribers WHERE id=?").bind(id).run();
  return json({ ok: true });
}
async function setOptOut(request, env) {
  const b = await readBody(request);
  const number = e164(b.number);
  const out = b.opted_out ? 1 : 0;
  await env.DB.prepare("UPDATE subscribers SET opted_out=? WHERE number=?").bind(out, number).run();
  return json({ ok: true });
}

/* ============================================================ broadcast */
// Build the job: snapshot every active subscriber into the outbox queue.
async function createBroadcast(request, env) {
  const b = await readBody(request);
  const body = (b.body || "").toString().trim();
  if (!body) return json({ error: "message body required" }, 400);

  const ins = await env.DB.prepare("INSERT INTO broadcasts (body, status) VALUES (?, 'sending')").bind(body).run();
  const broadcastId = ins.meta.last_row_id;

  await env.DB.prepare(
    "INSERT INTO outbox (broadcast_id, number) SELECT ?, number FROM subscribers WHERE opted_out = 0"
  ).bind(broadcastId).run();

  const total = (await env.DB.prepare("SELECT COUNT(*) AS c FROM outbox WHERE broadcast_id=?").bind(broadcastId).first())?.c || 0;
  await env.DB.prepare("UPDATE broadcasts SET total=? WHERE id=?").bind(total, broadcastId).run();

  if (!total) {
    await env.DB.prepare("UPDATE broadcasts SET status='done' WHERE id=?").bind(broadcastId).run();
    return json({ id: broadcastId, total: 0, done: true });
  }
  return json({ id: broadcastId, total });
}

// Drain up to BATCH_SIZE queued recipients. The admin page calls this repeatedly
// until remaining === 0, showing a progress bar. Keeping the batch small means
// each call stays well under Cloudflare's per-request subrequest limit.
async function runBroadcast(request, env) {
  const b = await readBody(request);
  const broadcastId = Number(b.id);
  if (!broadcastId) return json({ error: "id required" }, 400);

  const bc = await env.DB.prepare("SELECT id, body, total FROM broadcasts WHERE id=?").bind(broadcastId).first();
  if (!bc) return json({ error: "broadcast not found" }, 404);

  const batchSize = Math.min(Math.max(Number(env.BATCH_SIZE) || 25, 1), 45);
  const footer = env.SMS_FOOTER || "";
  const message = bc.body + footer;

  const queued = await env.DB.prepare(
    "SELECT id, number FROM outbox WHERE broadcast_id=? AND status='queued' ORDER BY id ASC LIMIT ?"
  ).bind(broadcastId, batchSize).all();
  const batch = queued.results || [];

  // Send the batch concurrently, then record each result.
  const results = await Promise.allSettled(batch.map((r) => providerSend(env, r.number, message)));
  const updates = [];
  let lastError = null;
  for (let i = 0; i < batch.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      updates.push(env.DB.prepare("UPDATE outbox SET status='sent' WHERE id=?").bind(batch[i].id));
    } else {
      const err = String(r.reason?.message || r.reason || "send failed").slice(0, 200);
      lastError = err;
      updates.push(env.DB.prepare("UPDATE outbox SET status='failed', error=? WHERE id=?").bind(err, batch[i].id));
    }
  }
  if (updates.length) await env.DB.batch(updates);

  // Recompute progress.
  const agg = await env.DB.prepare(
    "SELECT SUM(status='sent') AS sent, SUM(status='failed') AS failed, SUM(status='queued') AS remaining FROM outbox WHERE broadcast_id=?"
  ).bind(broadcastId).first();
  const sent = agg?.sent || 0, failed = agg?.failed || 0, remaining = agg?.remaining || 0;

  await env.DB.prepare("UPDATE broadcasts SET sent=?, failed=?, status=? WHERE id=?")
    .bind(sent, failed, remaining ? "sending" : "done", broadcastId).run();

  return json({ id: broadcastId, total: bc.total, sent, failed, remaining, done: remaining === 0, lastError });
}

async function broadcastStatus(env, url) {
  const id = Number(url.searchParams.get("id"));
  const bc = await env.DB.prepare("SELECT id, body, total, sent, failed, status, created_at FROM broadcasts WHERE id=?").bind(id).first();
  if (!bc) return json({ error: "not found" }, 404);
  return json(bc);
}
async function listBroadcasts(env) {
  const rows = await env.DB.prepare(
    "SELECT id, body, total, sent, failed, status, created_at FROM broadcasts ORDER BY id DESC LIMIT 50"
  ).all();
  return json({ broadcasts: rows.results || [] });
}

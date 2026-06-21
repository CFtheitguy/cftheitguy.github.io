/**
 * Linear Tech — IVR + Linear Phone softphone API
 * ==============================================
 * One Cloudflare Worker, three jobs:
 *   1. The existing professional IVR (paths /ivr, /ivr/menu, /ivr/vm) — preserved
 *      verbatim; all menu options route to the cell. Voicemail is now also saved
 *      to D1 so it shows up in the Linear Phone app.
 *   2. Softphone API (/api/*) — login, texting, calls, contacts, voicemail.
 *   3. WebRTC token (/api/token) — mints a SignalWire RELAY JWT for the browser.
 *
 * Paste this whole file into Cloudflare → Workers → linear-ivr → Edit code.
 *
 * The voice webhook on your number stays the same (…/ivr) — nothing to change
 * there. To enable texting + the app, add the bindings/secrets in phone/DEPLOY.md.
 *
 * Bindings:  DB  (D1 database — optional for IVR, required for app)
 * Secrets (app only):
 *   SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT, SIGNALWIRE_TOKEN, SIGNALWIRE_NUMBER,
 *   APP_PASSWORD, AUTH_SECRET, ALLOW_ORIGIN, GOOGLE_VOICE_NUMBER
 *   SUBSCRIBER_REFERENCE — Call Fabric Subscriber name the browser logs in as
 *                          (e.g. "linearphone"). The SWML handler rings it at
 *                          /private/<SUBSCRIBER_REFERENCE>. Optional:
 *                          SUBSCRIBER_ADDRESS to override the full address.
 */

// ===== CONFIGURATION (existing IVR) =====
const CELL_NUMBER = "+18456041462";
const VOICE = "Polly.Kendra";
const LANGUAGE = "en-US";
const SPEECH_RATE = "99%";
const DIAL_TIMEOUT_SECONDS = 60;

// ===== BUSINESS HOURS =====
const BUSINESS_TIMEZONE = "America/New_York";
const BUSINESS_DAYS_MON_THU = new Set(["Mon", "Tue", "Wed", "Thu"]);
const BUSINESS_DAY_FRI = "Fri";
const MON_THU_START_HOUR = 9;
const MON_THU_END_HOUR = 17;
const FRI_START_HOUR = 9;
const FRI_END_HOUR = 13;

// ===== WORKER ENTRYPOINT =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // CORS preflight for the app
    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

    try {
      // ---------- Existing IVR (unchanged behavior) ----------
      if (p === "/" && request.method === "GET") {
        return new Response("Linear Tech IVR Online", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      if (p === "/ivr" && request.method === "POST") {
        return twimlResponse(renderIvr(url));
      }
      if (p === "/ivr/menu" && request.method === "POST") {
        const form = await request.formData();
        const digits = (form.get("Digits") || "").toString().trim();
        return twimlResponse(routeDigits(digits, url, env));
      }
      // Browser didn't answer → try Google Voice
      if (p === "/ivr/cell-fallback" && request.method === "POST") {
        const form = await request.formData();
        const dialStatus = (form.get("DialCallStatus") || "").toString();
        if (dialStatus === "completed") return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
        return twimlResponse(dialCell(env, url));
      }
      if (p === "/ivr/vm" && request.method === "POST") {
        const form = await request.formData();
        ctx.waitUntil(saveVoicemail(env, form)); // store for the app, don't delay the caller
        return twimlResponse(renderVmThanks());
      }

      // ---------- Inbound SMS ----------
      if (p === "/sms/inbound" && request.method === "POST") return smsInbound(request, env, ctx);
      if (p === "/sms/status") return new Response("", { status: 200 });

      // ---------- Inbound voice via SWML (Call Fabric: ring browser → cell) ----------
      if (p === "/swml/voice" && request.method === "POST") return swmlResponse(swmlVoice(env));

      // ---------- Softphone API ----------
      if (p === "/api/login")  return cors(env, await login(request, env));
      if (p === "/api/token")  return cors(env, await requireAuth(request, env, () => mintRtcToken(env)));
      if (p === "/api/threads")     return cors(env, await requireAuth(request, env, () => listThreads(env)));
      if (p === "/api/thread")      return cors(env, await requireAuth(request, env, () => getThread(env, url)));
      if (p === "/api/thread/read") return cors(env, await requireAuth(request, env, () => markRead(request, env)));
      if (p === "/api/sms/send")    return cors(env, await requireAuth(request, env, () => sendSms(request, env)));
      if (p === "/api/calls" && request.method === "GET")  return cors(env, await requireAuth(request, env, () => listCalls(env)));
      if (p === "/api/calls" && request.method === "POST") return cors(env, await requireAuth(request, env, () => logCall(request, env)));
      if (p === "/api/voicemail")   return cors(env, await requireAuth(request, env, () => listVoicemail(env)));
      if (p === "/api/contacts" && request.method === "GET")  return cors(env, await requireAuth(request, env, () => listContacts(env)));
      if (p === "/api/contacts" && request.method === "POST") return cors(env, await requireAuth(request, env, () => saveContact(request, env)));
      if (p === "/api/contacts/import" && request.method === "POST") return cors(env, await requireAuth(request, env, () => importContacts(request, env)));
      if (p === "/api/contacts/delete") return cors(env, await requireAuth(request, env, () => deleteContact(request, env)));

      return cors(env, json({ error: "Not found" }, 404));
    } catch (err) {
      return cors(env, json({ error: String(err && err.message || err) }, 500));
    }
  }
};

/* ============================================================
 * EXISTING IVR — preserved
 * ============================================================ */
function renderIvr(url) {
  const action = new URL("/ivr/menu", url.origin).toString();
  const inHours = isBusinessHoursNow();

  const businessGreeting = `
    Thank you for calling Linear Tech.
    For support, press 1.
    For sales, press 2.
    For billing, press 3.
    Or stay on the line to speak with someone.
  `;
  const afterHoursGreeting = `
    Thank you for calling Linear Tech.
    Our office is currently closed.
    If your request is important, please send an email to support at linearit dot co.
    Please leave your name, callback number, and a brief message after the tone.
  `;
  const sayText = inHours ? businessGreeting : afterHoursGreeting;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${xmlEscape(action)}" method="POST" numDigits="1" timeout="5">
    ${saySsml(sayText)}
  </Gather>
  <Redirect method="POST">${xmlEscape(action)}</Redirect>
</Response>`;
}

function routeDigits(digits, url, env) {
  const back = xmlEscape(new URL("/ivr", url.origin).toString());
  const inHours = isBusinessHoursNow();

  if (digits === "9") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${back}</Redirect>
</Response>`;
  }

  if (!digits || digits === "1" || digits === "2" || digits === "3") {
    if (inHours) {
      const msg = { "1": "Connecting support.", "2": "Connecting sales.", "3": "Connecting billing." }[digits] || "Please hold while we connect your call.";
      return dialCellWithGreeting(msg, env, url);
    }
    return dialCellWithGreeting("Thank you for holding. We will be right with you.", env, url);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Sorry, that is not a valid option.")}
  <Redirect method="POST">${back}</Redirect>
</Response>`;
}

// cXML fallback path (used only if the number still points at /ivr instead of
// the SWML handler): greet, then ring Google Voice (which has its own voicemail).
function dialCellWithGreeting(message, env, url) {
  const cell = env.GOOGLE_VOICE_NUMBER || CELL_NUMBER;
  const vm = xmlEscape(new URL("/ivr/vm", url.origin).toString());
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml(message)}
  <Dial timeout="25" action="${vm}" method="POST" answerOnBridge="true" callerId="${xmlEscape(env.SIGNALWIRE_NUMBER || "")}">
    <Number>${xmlEscape(cell)}</Number>
  </Dial>
</Response>`;
}

// Step 2: ring Google Voice (25s). If no answer → /ivr/vm (voicemail)
function dialCell(env, url) {
  const cell = env.GOOGLE_VOICE_NUMBER || CELL_NUMBER;
  const vm = xmlEscape(new URL("/ivr/vm", url.origin).toString());
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" action="${vm}" method="POST" answerOnBridge="true">
    <Number>${xmlEscape(cell)}</Number>
  </Dial>
</Response>`;
}

/* ============================================================
 * SWML inbound handler (Call Fabric) — the browser-ringing path
 * ------------------------------------------------------------
 * Point the SignalWire number at this URL:
 *   Phone Number → Handle calls using → "a SWML Script"
 *     → check "Use External URL for SWML Script handler?"
 *     → URL: https://<worker>/swml/voice  (POST)
 *
 * Flow: greeting → connect serially to the browser Subscriber (18s),
 * then to Google Voice (25s, which has its own voicemail). No fragile
 * recording step — Google Voice handles the voicemail.
 * ============================================================ */
function swmlVoice(env) {
  const inHours = isBusinessHoursNow();
  const greeting = inHours
    ? "Thank you for calling Linear Tech. Please hold while we connect you."
    : "Thank you for calling Linear Tech. Our office is currently closed. Please hold while we try to reach someone, or leave a message after the tone.";
  const reference = env.SUBSCRIBER_REFERENCE || "linearphone";
  const subscriber = env.SUBSCRIBER_ADDRESS || ("/private/" + reference);
  const cell = env.GOOGLE_VOICE_NUMBER || CELL_NUMBER;
  const did = env.SIGNALWIRE_NUMBER || "+18456042025";

  return {
    version: "1.0.0",
    sections: {
      main: [
        { play: { urls: ["say:" + greeting] } },
        {
          connect: {
            serial: [
              { to: subscriber, timeout: 18 },
              { to: cell, from: did, timeout: 25 },
            ],
          },
        },
      ],
    },
  };
}

function renderVmPrompt(url, promptText) {
  const vmCallback = new URL("/ivr/vm", url.origin).toString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml(promptText)}
  <Record method="POST" action="${xmlEscape(vmCallback)}" maxLength="120" transcribe="true" transcribeCallback="${xmlEscape(vmCallback)}" />
</Response>`;
}

function renderVmThanks() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Your message has been recorded. Thank you for calling Linear Tech. Goodbye.")}
  <Hangup/>
</Response>`;
}

function isBusinessHoursNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE, weekday: "short", hour: "2-digit", hour12: false
  }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  if (!weekday || Number.isNaN(hour)) return true;
  if (BUSINESS_DAYS_MON_THU.has(weekday)) return hour >= MON_THU_START_HOUR && hour < MON_THU_END_HOUR;
  if (weekday === BUSINESS_DAY_FRI) return hour >= FRI_START_HOUR && hour < FRI_END_HOUR;
  return false;
}

function saySsml(text) {
  return `<Say voice="${VOICE}" language="${LANGUAGE}">
    <speak><prosody rate="${SPEECH_RATE}">${xmlEscape(normalizeSpeech(text))}</prosody></speak>
  </Say>`;
}
function normalizeSpeech(text) { return String(text).replace(/\s+/g, " ").trim(); }
function twimlResponse(xml) { return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } }); }
function swmlResponse(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } }); }
function xmlEscape(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Save a voicemail (and missed call) so it appears in the app. Best-effort.
async function saveVoicemail(env, form) {
  if (!env.DB) return;
  const number = e164(form.get("From") || form.get("Caller") || "");
  let url = (form.get("RecordingUrl") || "").toString();
  if (url && !/\.(mp3|wav)$/i.test(url)) url += ".mp3";
  const transcript = (form.get("TranscriptionText") || "").toString() || null;
  const sid = (form.get("CallSid") || "").toString() || null;
  try {
    await env.DB.prepare("INSERT INTO voicemail (number, recording_url, transcript, sid) VALUES (?,?,?,?)")
      .bind(number, url || null, transcript, sid).run();
    await env.DB.prepare("INSERT INTO calls (number, direction, status, sid) VALUES (?, 'in', 'missed', ?)")
      .bind(number, sid).run();
  } catch (_) {}
}

/* ============================================================
 * Shared helpers
 * ============================================================ */
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

async function readForm(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

const e164 = (n) => {
  let d = String(n || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  d = d.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "+" + d;
};

/* ============================================================
 * Auth — signed bearer tokens (HMAC-SHA256), no cookies
 * ============================================================ */
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
  const { password } = await readForm(request);
  if (!password || password !== env.APP_PASSWORD) return json({ error: "Invalid password" }, 401);
  return json({ token: await makeToken(env) });
}
async function requireAuth(request, env, handler) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await verifyToken(env, token))) return json({ error: "Unauthorized" }, 401);
  return await handler();
}

/* ============================================================
 * SignalWire REST helpers
 * ============================================================ */
function swAuth(env) { return "Basic " + btoa(`${env.SIGNALWIRE_PROJECT}:${env.SIGNALWIRE_TOKEN}`); }
function swBase(env) {
  const host = String(env.SIGNALWIRE_SPACE).replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${host}`;
}

// Mint a Call Fabric Subscriber Access Token (SAT) for the browser SDK.
// The browser registers as this Subscriber and can both place and RECEIVE calls.
// If the Subscriber doesn't exist yet we create it automatically (so there's no
// manual dashboard step). The same identity is what SWML `connect` rings at
// /private/<reference>.
function subscriberEmail(env) {
  const ref = env.SUBSCRIBER_REFERENCE || "linearphone";
  if (env.SUBSCRIBER_EMAIL) return env.SUBSCRIBER_EMAIL;
  return ref.includes("@") ? ref : `${ref}@linearit.co`;
}

async function mintSubscriberToken(env, reference) {
  return fetch(`${swBase(env)}/api/fabric/subscribers/tokens`, {
    method: "POST",
    headers: { Authorization: swAuth(env), "Content-Type": "application/json" },
    body: JSON.stringify({ reference }),
  });
}

async function mintRtcToken(env) {
  const reference = subscriberEmail(env);

  // Try to mint a token. If the Subscriber doesn't exist yet, create it and retry.
  let res = await mintSubscriberToken(env, reference);
  if (!res.ok) {
    await fetch(`${swBase(env)}/api/fabric/resources/subscribers`, {
      method: "POST",
      headers: { Authorization: swAuth(env), "Content-Type": "application/json" },
      body: JSON.stringify({ email: reference, display_name: "Linear Phone" }),
    }).catch(() => {});
    res = await mintSubscriberToken(env, reference);
  }
  if (!res.ok) return json({ error: `Token mint failed (${res.status}): ${await res.text()}` }, 502);
  const data = await res.json();
  return json({ token: data.token });
}

/* ============================================================
 * Texting
 * ============================================================ */
async function sendSms(request, env) {
  const { to, body } = await readForm(request);
  if (!to || !body) return json({ error: "to and body required" }, 400);
  const dest = e164(to);
  const form = new URLSearchParams({ From: env.SIGNALWIRE_NUMBER, To: dest, Body: body });
  const res = await fetch(
    `${swBase(env)}/api/laml/2010-04-01/Accounts/${env.SIGNALWIRE_PROJECT}/Messages.json`,
    { method: "POST", headers: { Authorization: swAuth(env), "Content-Type": "application/x-www-form-urlencoded" }, body: form }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: data.message || `Send failed (${res.status})` }, 502);
  await env.DB.prepare("INSERT INTO messages (number, direction, body, sid, is_read) VALUES (?, 'out', ?, ?, 1)")
    .bind(dest, body, data.sid || null).run();
  return json({ ok: true, sid: data.sid });
}

async function smsInbound(request, env, ctx) {
  const f = await readForm(request);
  const from = e164(f.From);
  const body = (f.Body || "").toString();
  if (env.DB) {
    await env.DB.prepare("INSERT INTO messages (number, direction, body, sid, is_read) VALUES (?, 'in', ?, ?, 0)")
      .bind(from, body, f.MessageSid || null).run();
  }

  // Owner command routing: a text FROM the owner's phone that starts with
  // "task" or "help" is forwarded to a Power Automate HTTP trigger, which
  // creates a Microsoft To-Do task or emails help@linearit.co (NinjaOne ticket).
  const owner = e164(env.OWNER_NUMBER || CELL_NUMBER);
  const m = body.match(/^\s*(task|help)\b[\s:,\-]*([\s\S]*)$/i);
  if (env.AUTOMATE_URL && from === owner && m) {
    const command = m[1].toLowerCase();
    const text = (m[2] || "").trim();
    const fwd = fetch(env.AUTOMATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, text, body, from }),
    }).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(fwd); else await fwd;
  }

  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { headers: { "Content-Type": "text/xml" } });
}

async function listThreads(env) {
  const rows = await env.DB.prepare(`
    SELECT m.number, m.body AS last_body, m.direction AS last_dir, m.created_at AS last_at,
           (SELECT COUNT(*) FROM messages u WHERE u.number=m.number AND u.direction='in' AND u.is_read=0) AS unread
    FROM messages m
    JOIN (SELECT number, MAX(id) AS mid FROM messages GROUP BY number) t ON t.mid = m.id
    ORDER BY m.created_at DESC
  `).all();
  const threads = (rows.results || []).map(r => ({ ...r, unread: r.unread > 0 }));
  return json({ threads });
}
async function getThread(env, url) {
  const number = e164(url.searchParams.get("number"));
  const rows = await env.DB.prepare(
    "SELECT id, direction, body, created_at FROM messages WHERE number=? ORDER BY id ASC LIMIT 500"
  ).bind(number).all();
  return json({ messages: rows.results || [] });
}
async function markRead(request, env) {
  const { number } = await readForm(request);
  await env.DB.prepare("UPDATE messages SET is_read=1 WHERE number=? AND direction='in'").bind(e164(number)).run();
  return json({ ok: true });
}

/* ============================================================
 * Calls
 * ============================================================ */
async function listCalls(env) {
  const rows = await env.DB.prepare(
    "SELECT id, number, direction, status, duration, created_at FROM calls ORDER BY id DESC LIMIT 200"
  ).all();
  return json({ calls: rows.results || [] });
}
async function logCall(request, env) {
  const c = await readForm(request);
  await env.DB.prepare("INSERT INTO calls (number, direction, status, duration, sid) VALUES (?,?,?,?,?)")
    .bind(e164(c.number), c.direction || "out", c.status || "completed", c.duration || 0, c.sid || null).run();
  return json({ ok: true });
}

/* ============================================================
 * Voicemail
 * ============================================================ */
async function listVoicemail(env) {
  const rows = await env.DB.prepare(
    "SELECT id, number, recording_url, transcript, created_at FROM voicemail ORDER BY id DESC LIMIT 100"
  ).all();
  return json({ voicemail: rows.results || [] });
}

/* ============================================================
 * Contacts
 * ============================================================ */
// Make sure the contacts table exists (self-heal if the DB was set up before
// this table was added, which otherwise makes saves/loads fail silently).
async function ensureContactsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, number TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_number ON contacts(number)"
  ).run();
}

async function listContacts(env) {
  await ensureContactsTable(env);
  const rows = await env.DB.prepare("SELECT id, name, number FROM contacts ORDER BY name ASC").all();
  return json({ contacts: rows.results || [] });
}
async function saveContact(request, env) {
  await ensureContactsTable(env);
  const c = await readForm(request);
  const number = e164(c.number);
  if (!c.name || !number) return json({ error: "name and number required" }, 400);
  if (c.id) {
    await env.DB.prepare("UPDATE contacts SET name=?, number=? WHERE id=?").bind(c.name, number, c.id).run();
  } else {
    await env.DB.prepare("INSERT INTO contacts (name, number) VALUES (?,?) ON CONFLICT(number) DO UPDATE SET name=excluded.name")
      .bind(c.name, number).run();
  }
  return json({ ok: true });
}
async function deleteContact(request, env) {
  await ensureContactsTable(env);
  const { id } = await readForm(request);
  await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id).run();
  return json({ ok: true });
}
// Bulk import (e.g. from a parsed .vcf). Body: { contacts: [{name, number}, ...] }
async function importContacts(request, env) {
  await ensureContactsTable(env);
  const body = await readForm(request);
  let list = body.contacts;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch (_) { list = []; } }
  if (!Array.isArray(list)) return json({ error: "contacts array required" }, 400);

  const stmt = env.DB.prepare(
    "INSERT INTO contacts (name, number) VALUES (?,?) ON CONFLICT(number) DO UPDATE SET name=excluded.name"
  );
  const batch = [];
  for (const c of list) {
    const name = ((c && c.name) || "").toString().trim();
    const number = e164(c && c.number);
    if (!name || !number || number.length < 8) continue; // skip junk
    batch.push(stmt.bind(name, number));
  }
  if (!batch.length) return json({ imported: 0 });
  // Chunk to stay within D1 batch limits.
  let imported = 0;
  for (let i = 0; i < batch.length; i += 50) {
    await env.DB.batch(batch.slice(i, i + 50));
    imported += Math.min(50, batch.length - i);
  }
  return json({ imported });
}

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
 *   APP_PASSWORD, AUTH_SECRET, ALLOW_ORIGIN
 *   (optional) RELAY_CONTEXT
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
        return twimlResponse(routeDigits(digits, url));
      }
      if (p === "/ivr/vm" && request.method === "POST") {
        const form = await request.formData();
        ctx.waitUntil(saveVoicemail(env, form)); // store for the app, don't delay the caller
        return twimlResponse(renderVmThanks());
      }

      // ---------- Inbound SMS ----------
      if (p === "/sms/inbound" && request.method === "POST") return smsInbound(request, env);
      if (p === "/sms/status") return new Response("", { status: 200 });

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

function routeDigits(digits, url) {
  const back = xmlEscape(new URL("/ivr", url.origin).toString());
  const inHours = isBusinessHoursNow();

  if (!digits) {
    if (inHours) {
      return dial(`<Number>${xmlEscape(CELL_NUMBER)}</Number>`, "Please hold while we connect your call.", back);
    }
    return renderVmPrompt(url, "Please leave a message after the tone.");
  }

  if (digits === "9") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${back}</Redirect>
</Response>`;
  }

  if (inHours) {
    if (digits === "1") return dial(`<Number>${xmlEscape(CELL_NUMBER)}</Number>`, "Connecting support.", back);
    if (digits === "2") return dial(`<Number>${xmlEscape(CELL_NUMBER)}</Number>`, "Connecting sales.", back);
    if (digits === "3") return dial(`<Number>${xmlEscape(CELL_NUMBER)}</Number>`, "Connecting billing.", back);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Sorry, that is not a valid option.")}
  <Redirect method="POST">${back}</Redirect>
</Response>`;
}

function dial(target, message, back) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml(message)}
  <Dial timeout="${DIAL_TIMEOUT_SECONDS}" answerOnBridge="true">
    ${target}
  </Dial>
  ${saySsml("We were unable to connect your call.")}
  <Redirect method="POST">${back}</Redirect>
</Response>`;
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

// Mint a RELAY JWT for the browser SDK (short-lived, safe to expose).
async function mintRtcToken(env) {
  const body = new URLSearchParams();
  if (env.RELAY_CONTEXT) body.set("resource", env.RELAY_CONTEXT);
  body.set("expires_in", "3600");
  const res = await fetch(`${swBase(env)}/api/relay/rest/jwt`, {
    method: "POST",
    headers: { Authorization: swAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return json({ error: `Token mint failed (${res.status}): ${await res.text()}` }, 502);
  const data = await res.json();
  return json({ token: data.jwt_token, project: env.SIGNALWIRE_PROJECT });
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

async function smsInbound(request, env) {
  const f = await readForm(request);
  const from = e164(f.From);
  if (env.DB) {
    await env.DB.prepare("INSERT INTO messages (number, direction, body, sid, is_read) VALUES (?, 'in', ?, ?, 0)")
      .bind(from, f.Body || "", f.MessageSid || null).run();
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
async function listContacts(env) {
  const rows = await env.DB.prepare("SELECT id, name, number FROM contacts ORDER BY name ASC").all();
  return json({ contacts: rows.results || [] });
}
async function saveContact(request, env) {
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
  const { id } = await readForm(request);
  await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id).run();
  return json({ ok: true });
}

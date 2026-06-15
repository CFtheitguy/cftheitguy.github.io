/**
 * Linear Phone — Cloudflare Worker API + SignalWire IVR
 * =====================================================
 * One worker that does three jobs:
 *   1. SignalWire webhooks  (inbound voice IVR, inbound SMS, status callbacks)
 *   2. Softphone API        (/api/* — auth, texting, calls, contacts, voicemail)
 *   3. WebRTC token minting  (/api/token — subscriber token for the browser SDK)
 *
 * Paste this whole file into Cloudflare → Workers → linear-ivr → Edit code.
 * Configure bindings/secrets in Settings (see worker/README.md).
 *
 * Required bindings:
 *   DB                    D1 database  (run worker/schema.sql first)
 * Required secrets (Settings → Variables and Secrets):
 *   SIGNALWIRE_SPACE      e.g. yourspace.signalwire.com
 *   SIGNALWIRE_PROJECT    SignalWire Project ID (UUID)
 *   SIGNALWIRE_TOKEN      SignalWire API token  (PT...)
 *   SIGNALWIRE_NUMBER     +18456042025
 *   APP_PASSWORD          the password you type on the login screen
 *   AUTH_SECRET           a long random string used to sign session tokens
 *   ALLOW_ORIGIN          https://linearit.co   (or https://www.linearit.co)
 * Optional secrets:
 *   RELAY_CONTEXT         RELAY context name for inbound browser calls (e.g. "linearphone")
 *   FORWARD_NUMBER        fallback cell to ring on inbound (e.g. +1845...)
 *   SIP_ADDRESS           SIP address to ring on inbound, instead of FORWARD_NUMBER
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- CORS preflight ----
    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

    try {
      // ===== SignalWire webhooks (no app-auth; verified by SignalWire signature optionally) =====
      if (path === "/voice" || path === "/") return await voiceWebhook(request, env, path);
      if (path === "/voice/status") return await voiceStatus(request, env);
      if (path === "/voice/voicemail") return await voicemailWebhook(request, env);
      if (path === "/sms/inbound") return await smsInbound(request, env);
      if (path === "/sms/status") return new Response("", { status: 200 });

      // ===== Softphone API =====
      if (path === "/api/login")  return cors(env, await login(request, env));
      if (path === "/api/token")  return cors(env, await requireAuth(request, env, () => mintRtcToken(env)));

      if (path === "/api/threads")     return cors(env, await requireAuth(request, env, () => listThreads(env)));
      if (path === "/api/thread")      return cors(env, await requireAuth(request, env, () => getThread(env, url)));
      if (path === "/api/thread/read") return cors(env, await requireAuth(request, env, () => markRead(request, env)));
      if (path === "/api/sms/send")    return cors(env, await requireAuth(request, env, () => sendSms(request, env)));

      if (path === "/api/calls" && request.method === "GET")  return cors(env, await requireAuth(request, env, () => listCalls(env)));
      if (path === "/api/calls" && request.method === "POST") return cors(env, await requireAuth(request, env, () => logCall(request, env)));

      if (path === "/api/voicemail") return cors(env, await requireAuth(request, env, () => listVoicemail(env)));

      if (path === "/api/contacts" && request.method === "GET")  return cors(env, await requireAuth(request, env, () => listContacts(env)));
      if (path === "/api/contacts" && request.method === "POST") return cors(env, await requireAuth(request, env, () => saveContact(request, env)));
      if (path === "/api/contacts/delete") return cors(env, await requireAuth(request, env, () => deleteContact(request, env)));

      return cors(env, json({ error: "Not found" }, 404));
    } catch (err) {
      return cors(env, json({ error: String(err && err.message || err) }, 500));
    }
  },
};

/* ============================================================
 * Helpers
 * ============================================================ */
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const xml = (body) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "Content-Type": "text/xml" } });

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
  const payload = btoa(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })); // 30 days
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
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!(await verifyToken(env, token))) return json({ error: "Unauthorized" }, 401);
  return await handler();
}

/* ============================================================
 * SignalWire REST helpers
 * ============================================================ */
function swAuth(env) {
  return "Basic " + btoa(`${env.SIGNALWIRE_PROJECT}:${env.SIGNALWIRE_TOKEN}`);
}
function swBase(env) {
  // SIGNALWIRE_SPACE may be "space.signalwire.com" or a full host
  const host = String(env.SIGNALWIRE_SPACE).replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${host}`;
}

/* ============================================================
 * WebRTC token  (/api/token)
 * ------------------------------------------------------------
 * Mints a RELAY JWT the browser SDK uses to connect and place/
 * receive WebRTC calls. JWTs are short-lived (default 15 min) and
 * safe to expose to the browser. The frontend re-requests as needed.
 *   POST /api/relay/rest/jwt  (Basic auth: ProjectID:APIToken)
 *   -> { jwt_token, refresh_token }
 * ============================================================ */
async function mintRtcToken(env) {
  const body = new URLSearchParams();
  if (env.RELAY_CONTEXT) body.set("resource", env.RELAY_CONTEXT); // inbound context (optional)
  body.set("expires_in", "3600"); // seconds (1h)
  const res = await fetch(`${swBase(env)}/api/relay/rest/jwt`, {
    method: "POST",
    headers: { Authorization: swAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return json({ error: `Token mint failed (${res.status}): ${await res.text()}` }, 502);
  const data = await res.json();
  // The browser only needs the JWT; keep refresh_token server-side.
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
  await env.DB.prepare("INSERT INTO messages (number, direction, body, sid, is_read) VALUES (?, 'in', ?, ?, 0)")
    .bind(from, f.Body || "", f.MessageSid || null).run();
  return xml("<Response></Response>");
}

async function listThreads(env) {
  // latest message per number + unread count
  const rows = await env.DB.prepare(`
    SELECT m.number,
           m.body  AS last_body,
           m.direction AS last_dir,
           m.created_at AS last_at,
           (SELECT COUNT(*) FROM messages u WHERE u.number = m.number AND u.direction='in' AND u.is_read=0) AS unread
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
  await env.DB.prepare(
    "INSERT INTO calls (number, direction, status, duration, sid) VALUES (?,?,?,?,?)"
  ).bind(e164(c.number), c.direction || "out", c.status || "completed", c.duration || 0, c.sid || null).run();
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
async function voicemailWebhook(request, env) {
  const f = await readForm(request);
  const from = e164(f.From || f.Caller);
  let url = f.RecordingUrl || "";
  if (url && !/\.(mp3|wav)$/i.test(url)) url += ".mp3";
  await env.DB.prepare(
    "INSERT INTO voicemail (number, recording_url, transcript, sid) VALUES (?,?,?,?)"
  ).bind(from, url, f.TranscriptionText || null, f.CallSid || null).run();
  // also log the missed call
  await env.DB.prepare("INSERT INTO calls (number, direction, status, sid) VALUES (?, 'in', 'missed', ?)")
    .bind(from, f.CallSid || null).run();
  return xml("<Response><Say voice=\"polly.Joanna\">Thank you. Your message has been received. Goodbye.</Say><Hangup/></Response>");
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

/* ============================================================
 * Voice IVR webhook  (recreated from docs/ivr-script.md)
 * ------------------------------------------------------------
 * Behavior:
 *   - Rings the browser softphone first (Dial to the subscriber).
 *   - If unanswered, plays the IVR menu / takes a voicemail.
 *
 * NOTE: the exact verb used to ring a Call Fabric subscriber from
 * cXML is wired up after confirming the routing model — see
 * worker/README.md "Inbound routing". For now this serves the IVR.
 * ============================================================ */
async function voiceWebhook(request, env, path) {
  if (path === "/") {
    // health check / SignalWire sometimes hits root
    if (request.method === "GET") return new Response("Linear Tech IVR Online", { status: 200 });
  }
  const f = await readForm(request).catch(() => ({}));
  const digits = f.Digits;
  const host = new URL(request.url).host;
  const action = `https://${host}/voice`;

  // Business hours: Mon–Fri 9am–6pm America/New_York
  const open = isBusinessHours();

  if (digits) {
    const ext = { "1": "Technical Support", "2": "Sales and New Services", "3": "Billing and Accounts" }[digits];
    if (digits === "9") return xml(menu(action, open));
    if (ext) {
      return xml(`<Response>
        <Say voice="polly.Joanna">Connecting you to ${ext}. Please hold.</Say>
        <Dial timeout="20" callerId="${env.SIGNALWIRE_NUMBER}"
              action="https://${host}/voice/voicemail" method="POST">
          ${dialTarget(env)}
        </Dial>
      </Response>`);
    }
  }

  if (!open) {
    return xml(`<Response>
      <Say voice="polly.Joanna">Thank you for calling Linear Tech. Our office is currently closed.</Say>
      <Say voice="polly.Joanna">Please leave a message with your name, company, and callback number after the tone, and we will return your call on the next business day. You can also email us anytime at support@linearit.co.</Say>
      <Record maxLength="120" playBeep="true" transcribe="true"
              action="https://${host}/voice/voicemail"
              transcribeCallback="https://${host}/voice/voicemail" />
      <Say voice="polly.Joanna">We did not receive a recording. Goodbye.</Say>
    </Response>`);
  }

  // Open: ring the softphone, then fall through to the menu.
  return xml(`<Response>
    <Dial timeout="18" callerId="${env.SIGNALWIRE_NUMBER}">
      ${dialTarget(env)}
    </Dial>
    ${menu(action, open)}
  </Response>`);
}

function menu(action, open) {
  return `<Response>
    <Gather numDigits="1" timeout="6" action="${action}" method="POST">
      <Say voice="polly.Joanna">Thank you for calling Linear Tech. We're glad you reached us.</Say>
      <Say voice="polly.Joanna">For Technical Support, press 1. For Sales and New Services, press 2. For Billing and Accounts, press 3. To repeat these options, press 9.</Say>
    </Gather>
    <Say voice="polly.Joanna">We did not receive a selection. Goodbye.</Say>
  </Response>`;
}

// What to ring for inbound calls. Until the Call Fabric subscriber
// routing is confirmed, this can be a SIP address or a forwarding number.
function dialTarget(env) {
  if (env.FORWARD_NUMBER) return `<Number>${env.FORWARD_NUMBER}</Number>`;
  if (env.SIP_ADDRESS)    return `<Sip>${env.SIP_ADDRESS}</Sip>`;
  return ""; // softphone routing wired in README step
}

async function voiceStatus(request, env) {
  const f = await readForm(request).catch(() => ({}));
  if (f.CallSid && f.From) {
    const dir = (f.Direction || "").includes("outbound") ? "out" : "in";
    const other = dir === "out" ? f.To : f.From;
    await env.DB.prepare("INSERT INTO calls (number, direction, status, duration, sid) VALUES (?,?,?,?,?)")
      .bind(e164(other), dir, f.CallStatus || "completed", parseInt(f.CallDuration || "0", 10), f.CallSid).run();
  }
  return new Response("", { status: 200 });
}

function isBusinessHours() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = now.getDay(), hr = now.getHours();
  return day >= 1 && day <= 5 && hr >= 9 && hr < 18;
}

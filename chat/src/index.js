/**
 * Linear Chat — chat.linearit.co
 * ==============================================================
 * One self-contained Cloudflare Worker that is the WHOLE app:
 *   • GET  /            → serves the chat web app (single-page UI)
 *   • POST /api/auth/*  → email login with an MFA code (no passwords)
 *   • /api/groups, /api/groups/{id}/members, /api/groups/{id}/messages
 *
 * Roles:
 *   • Admins create groups and add/remove members (by email).
 *   • Members sign in by email, get a one-time code, and chat with their team.
 *
 * Bind the Worker to the custom domain  chat.linearit.co  and you're live.
 *
 * Bindings
 *   DB                 D1 database (required). Run schema.sql once, or let the
 *                      Worker self-heal — it creates the tables on first call.
 *
 * Secrets / variables
 *   AUTH_SECRET        long random string — signs session tokens & hashes codes
 *   ADMIN_EMAILS       comma/space separated emails allowed to create groups.
 *                      If empty, the very first person to sign in becomes admin.
 *   EMAIL_FROM         From: address, e.g.  Linear Chat <chat@linearit.co>
 *
 * Email delivery — set ONE of these (otherwise codes can only be read in DEV):
 *   RESEND_API_KEY     send via Resend  (https://resend.com)
 *   EMAIL_WEBHOOK_URL  POST {to,subject,text,html,from} to a webhook
 *                      (e.g. a Power Automate flow that sends from Outlook 365)
 *
 * Optional
 *   DEV_MODE = "1"     return the login code in the API response (testing only)
 *   RESTRICT_TO_MEMBERS = "1"   only let known admins/members request a code
 *   ALLOW_ORIGIN       CORS origin for the API (default "*"; the bundled app is
 *                      same-origin so it doesn't need CORS)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

    try {
      if (p === "/health") return new Response("ok", { status: 200 });
      if (p.startsWith("/api/")) {
        return cors(env, await handleApi(request, env, url, p, method));
      }
      // Everything else serves the app shell (client-side routing).
      return htmlResponse(APP_HTML);
    } catch (err) {
      const status = (err && err.status) || 500;
      return cors(env, json({ error: String((err && err.message) || err) }, status));
    }
  },
};

/* ============================================================
 * API router
 * ============================================================ */
async function handleApi(request, env, url, p, method) {
  await ensureSchema(env);

  // ---- Public (no token) ----
  if (p === "/api/auth/request" && method === "POST") return authRequest(request, env);
  if (p === "/api/auth/verify" && method === "POST") return authVerify(request, env);

  // ---- Authenticated ----
  const claims = await authClaims(request, env);
  if (!claims) return json({ error: "Unauthorized" }, 401);
  const email = claims.email;

  if (p === "/api/me" && method === "GET") return getMe(env, email);
  if (p === "/api/me" && method === "POST") return updateMe(request, env, email);
  if (p === "/api/groups" && method === "GET") return listGroups(env, email);
  if (p === "/api/groups" && method === "POST") return createGroup(request, env, email);

  const m = p.match(/^\/api\/groups\/(\d+)\/(members\/remove|members|messages)$/);
  if (m) {
    const gid = Number(m[1]);
    const sub = m[2];
    if (sub === "members" && method === "GET") return listMembers(env, email, gid);
    if (sub === "members" && method === "POST") return addMember(request, env, email, gid);
    if (sub === "members/remove" && method === "POST") return removeMember(request, env, email, gid);
    if (sub === "messages" && method === "GET") return listMessages(env, email, gid, url);
    if (sub === "messages" && method === "POST") return postMessage(request, env, email, gid);
  }

  return json({ error: "Not found" }, 404);
}

/* ============================================================
 * Auth — email + MFA code
 * ============================================================ */
async function authRequest(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  if (env.RESTRICT_TO_MEMBERS === "1" && !(await emailAllowed(env, email))) {
    return json({ error: "This email isn't authorized yet. Ask your group admin to add you." }, 403);
  }

  const now = Date.now();
  await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(now).run();

  // Cooldown: don't issue a new code if one was sent in the last 45s.
  const recent = await env.DB
    .prepare("SELECT created_at FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (recent && now - Number(recent.created_at) < 45000) {
    return json({ error: "A code was just sent. Please wait a moment before requesting another." }, 429);
  }

  // Invalidate any earlier codes for this email.
  await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE email=? AND consumed=0").bind(email).run();

  const code = genCode();
  const codeHash = await hashCode(env, email, code);
  await env.DB
    .prepare("INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES (?,?,?,?)")
    .bind(email, codeHash, now + 10 * 60 * 1000, now).run();

  const sent = await sendLoginEmail(env, email, code);
  const out = { ok: true };
  if (env.DEV_MODE === "1") out.dev_code = code;
  if (!sent && env.DEV_MODE !== "1") {
    return json({ error: "Couldn't send the email — email delivery isn't configured yet." }, 502);
  }
  return json(out);
}

async function authVerify(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  const code = String(body.code || "").trim();
  if (!validEmail(email) || !/^\d{4,8}$/.test(code)) return json({ error: "Invalid email or code." }, 400);

  const now = Date.now();
  const row = await env.DB
    .prepare("SELECT * FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (!row) return json({ error: "No active code. Request a new one." }, 400);
  if (Number(row.expires_at) < now) return json({ error: "That code expired. Request a new one." }, 400);
  if (Number(row.attempts) >= 5) {
    await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE id=?").bind(row.id).run();
    return json({ error: "Too many attempts. Request a new code." }, 429);
  }

  const hash = await hashCode(env, email, code);
  if (!timingSafeEqual(hash, row.code_hash)) {
    await env.DB.prepare("UPDATE login_codes SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
    return json({ error: "Incorrect code." }, 401);
  }

  await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE id=?").bind(row.id).run();
  const user = await upsertUser(env, email);
  const token = await makeToken(env, { email });
  return json({ token, user: publicUser(user) });
}

async function emailAllowed(env, email) {
  if (isAdminEmail(env, email)) return true;
  const u = await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first();
  if (u) return true;
  const m = await env.DB.prepare("SELECT 1 FROM group_members WHERE email=?").bind(email).first();
  return !!m;
}

async function upsertUser(env, email) {
  let user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  let isAdmin = isAdminEmail(env, email) ? 1 : 0;
  if (!user) {
    // Bootstrap: if no admin emails are configured and the system is empty,
    // the first person to sign in becomes the admin so you can get started.
    if (!isAdmin && !hasAdminEmails(env)) {
      const anyUser = await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
      if (!anyUser) isAdmin = 1;
    }
    await env.DB.prepare("INSERT INTO users (email, name, is_admin) VALUES (?,?,?)").bind(email, null, isAdmin).run();
    user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  } else if (isAdmin && !user.is_admin) {
    await env.DB.prepare("UPDATE users SET is_admin=1 WHERE email=?").bind(email).run();
    user.is_admin = 1;
  }
  return user;
}

/* ============================================================
 * Me
 * ============================================================ */
async function getMe(env, email) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  if (!u) return json({ error: "Unknown user" }, 401);
  return json({ user: publicUser(u) });
}
async function updateMe(request, env, email) {
  const body = await readBody(request);
  const name = String(body.name || "").trim().slice(0, 80) || null;
  await env.DB.prepare("UPDATE users SET name=? WHERE email=?").bind(name, email).run();
  const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  return json({ user: publicUser(u) });
}

/* ============================================================
 * Groups
 * ============================================================ */
async function listGroups(env, email) {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, gm.role,
            (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count,
            (SELECT body FROM messages msg WHERE msg.group_id = g.id ORDER BY msg.id DESC LIMIT 1) AS last_body,
            (SELECT COALESCE(sender_name, sender_email) FROM messages msg WHERE msg.group_id = g.id ORDER BY msg.id DESC LIMIT 1) AS last_sender,
            (SELECT created_at FROM messages msg WHERE msg.group_id = g.id ORDER BY msg.id DESC LIMIT 1) AS last_at
       FROM group_members gm
       JOIN chat_groups g ON g.id = gm.group_id
      WHERE gm.email = ?
      ORDER BY (last_at IS NULL), last_at DESC, g.id DESC`
  ).bind(email).all();
  return json({ groups: rows.results || [] });
}

async function createGroup(request, env, email) {
  const u = await env.DB.prepare("SELECT is_admin FROM users WHERE email=?").bind(email).first();
  if (!u || !u.is_admin) return json({ error: "Only admins can create groups." }, 403);

  const body = await readBody(request);
  const name = String(body.name || "").trim().slice(0, 100);
  if (!name) return json({ error: "Group name is required." }, 400);

  const res = await env.DB.prepare("INSERT INTO chat_groups (name, created_by) VALUES (?,?)").bind(name, email).run();
  const gid = res.meta.last_row_id;
  await env.DB.prepare("INSERT INTO group_members (group_id, email, role) VALUES (?,?, 'admin')").bind(gid, email).run();

  // Optional initial members passed from the UI.
  let members = body.members;
  if (typeof members === "string") { try { members = JSON.parse(members); } catch (_) { members = []; } }
  if (Array.isArray(members)) {
    for (const raw of members) {
      const e = normEmail(raw);
      if (validEmail(e) && e !== email) {
        await upsertUser(env, e);
        await env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, email, role) VALUES (?,?, 'member')").bind(gid, e).run();
        await sendInviteEmail(env, e, name).catch(() => {});
      }
    }
  }

  return json({ group: { id: gid, name, role: "admin", member_count: 1, last_body: null } });
}

/* ============================================================
 * Members
 * ============================================================ */
async function listMembers(env, email, gid) {
  await requireMember(env, gid, email);
  const rows = await env.DB.prepare(
    `SELECT gm.email, gm.role, u.name
       FROM group_members gm
       LEFT JOIN users u ON u.email = gm.email
      WHERE gm.group_id = ?
      ORDER BY (gm.role = 'admin') DESC, COALESCE(u.name, gm.email) ASC`
  ).bind(gid).all();
  return json({ members: rows.results || [] });
}

async function addMember(request, env, email, gid) {
  const me = await requireMember(env, gid, email);
  if (me.role !== "admin") return json({ error: "Only the group admin can add members." }, 403);

  const body = await readBody(request);
  const newEmail = normEmail(body.email);
  if (!validEmail(newEmail)) return json({ error: "Enter a valid email." }, 400);

  await upsertUser(env, newEmail);
  if (body.name) {
    await env.DB.prepare("UPDATE users SET name=COALESCE(name, ?) WHERE email=?")
      .bind(String(body.name).trim().slice(0, 80), newEmail).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, email, role) VALUES (?,?, 'member')").bind(gid, newEmail).run();

  const g = await env.DB.prepare("SELECT name FROM chat_groups WHERE id=?").bind(gid).first();
  await sendInviteEmail(env, newEmail, g ? g.name : "a group").catch(() => {});
  return json({ ok: true });
}

async function removeMember(request, env, email, gid) {
  const me = await requireMember(env, gid, email);
  if (me.role !== "admin") return json({ error: "Only the group admin can remove members." }, 403);

  const body = await readBody(request);
  const target = normEmail(body.email);
  if (target === email) return json({ error: "You can't remove yourself." }, 400);
  await env.DB.prepare("DELETE FROM group_members WHERE group_id=? AND email=?").bind(gid, target).run();
  return json({ ok: true });
}

/* ============================================================
 * Messages
 * ============================================================ */
async function listMessages(env, email, gid, url) {
  await requireMember(env, gid, email);
  const after = Number(url.searchParams.get("after") || 0) || 0;
  let rows;
  if (after > 0) {
    rows = await env.DB.prepare(
      "SELECT id, sender_email, sender_name, body, created_at FROM messages WHERE group_id=? AND id>? ORDER BY id ASC LIMIT 200"
    ).bind(gid, after).all();
    return json({ messages: rows.results || [] });
  }
  rows = await env.DB.prepare(
    "SELECT id, sender_email, sender_name, body, created_at FROM messages WHERE group_id=? ORDER BY id DESC LIMIT 100"
  ).bind(gid).all();
  return json({ messages: (rows.results || []).reverse() });
}

async function postMessage(request, env, email, gid) {
  await requireMember(env, gid, email);
  const body = await readBody(request);
  const text = String(body.body || "").trim();
  if (!text) return json({ error: "Message is empty." }, 400);
  if (text.length > 4000) return json({ error: "Message is too long." }, 400);

  const u = await env.DB.prepare("SELECT name FROM users WHERE email=?").bind(email).first();
  const name = u && u.name ? u.name : null;
  const res = await env.DB
    .prepare("INSERT INTO messages (group_id, sender_email, sender_name, body) VALUES (?,?,?,?)")
    .bind(gid, email, name, text).run();
  const row = await env.DB
    .prepare("SELECT id, sender_email, sender_name, body, created_at FROM messages WHERE id=?")
    .bind(res.meta.last_row_id).first();
  return json({ message: row });
}

/* ============================================================
 * Membership helpers
 * ============================================================ */
async function membership(env, gid, email) {
  return env.DB.prepare("SELECT * FROM group_members WHERE group_id=? AND email=?").bind(gid, email).first();
}
async function requireMember(env, gid, email) {
  const m = await membership(env, gid, email);
  if (!m) { const e = new Error("You're not a member of this group."); e.status = 403; throw e; }
  return m;
}

/* ============================================================
 * Admin email config
 * ============================================================ */
function adminEmailSet(env) {
  return String(env.ADMIN_EMAILS || "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function hasAdminEmails(env) { return adminEmailSet(env).length > 0; }
function isAdminEmail(env, email) { return adminEmailSet(env).includes(normEmail(email)); }
function publicUser(u) { return { email: u.email, name: u.name || null, is_admin: !!u.is_admin }; }

/* ============================================================
 * Email delivery (provider-agnostic)
 * ============================================================ */
async function sendLoginEmail(env, email, code) {
  return sendEmail(env, {
    to: email,
    subject: "Your Linear Chat code: " + code,
    text: "Your Linear Chat verification code is " + code +
      "\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.",
    html: loginEmailHtml(code),
  });
}
function loginEmailHtml(code) {
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:420px;margin:auto;padding:24px">' +
    '<h2 style="margin:0 0 8px">Linear Chat</h2>' +
    '<p style="color:#444;margin:0 0 16px">Use this code to sign in:</p>' +
    '<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center">' + code + "</div>" +
    '<p style="color:#888;font-size:13px;margin:16px 0 0">This code expires in 10 minutes. If you didn\'t request it, you can ignore this email.</p>' +
    "</div>";
}
async function sendInviteEmail(env, email, groupName) {
  return sendEmail(env, {
    to: email,
    subject: "You were added to " + groupName + " on Linear Chat",
    text: 'You\'ve been added to the group "' + groupName + '" on Linear Chat.\n\n' +
      "Sign in at https://chat.linearit.co using this email (" + email + "). You'll get a one-time code to verify.",
    html: '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:460px;margin:auto;padding:24px">' +
      '<h2 style="margin:0 0 8px">Linear Chat</h2>' +
      '<p style="color:#444">You were added to the group <strong>' + escHtmlServer(groupName) + "</strong>.</p>" +
      '<p style="color:#444">Sign in at <a href="https://chat.linearit.co">chat.linearit.co</a> with this email (' +
      escHtmlServer(email) + "). You'll get a one-time code to verify.</p></div>",
  });
}
async function sendEmail(env, msg) {
  try {
    if (env.RESEND_API_KEY) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.EMAIL_FROM || "Linear Chat <onboarding@resend.dev>",
          to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
        }),
      });
      return res.ok;
    }
    if (env.EMAIL_WEBHOOK_URL) {
      const res = await fetch(env.EMAIL_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, from: env.EMAIL_FROM || "" }),
      });
      return res.ok;
    }
  } catch (_) { /* fall through to "not sent" */ }
  return false;
}

/* ============================================================
 * Crypto: HMAC session tokens, code hashing
 * ============================================================ */
function b64url(bytes) {
  const s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlStr(str) { return b64url(new TextEncoder().encode(str)); }
function b64urlDecodeToStr(b64) {
  let s = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function hmacSign(env, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.AUTH_SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(sig);
}
async function makeToken(env, claims) {
  const payload = b64urlStr(JSON.stringify(Object.assign({ exp: Date.now() + 30 * 24 * 3600 * 1000 }, claims)));
  return payload + "." + (await hmacSign(env, payload));
}
async function authClaims(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if ((await hmacSign(env, payload)) !== sig) return null;
  try {
    const claims = JSON.parse(b64urlDecodeToStr(payload));
    if (!claims.exp || claims.exp < Date.now() || !claims.email) return null;
    return claims;
  } catch (_) { return null; }
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hashCode(env, email, code) { return sha256Hex((env.AUTH_SECRET || "dev-secret") + "|" + email + "|" + code); }
function genCode() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"); }
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ============================================================
 * Small helpers
 * ============================================================ */
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function escHtmlServer(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { return await request.json(); } catch (_) { return {}; } }
  try { const fd = await request.formData(); return Object.fromEntries(fd.entries()); } catch (_) { return {}; }
}
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
function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
}

/* ============================================================
 * Schema self-heal (so you don't strictly need to run schema.sql)
 * ============================================================ */
let SCHEMA_READY = false;
async function ensureSchema(env) {
  if (SCHEMA_READY) return;
  if (!env.DB) { const e = new Error("Database not configured — bind a D1 database as DB."); e.status = 500; throw e; }
  const stmts = [
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email)",
    "CREATE TABLE IF NOT EXISTS chat_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(group_id, email))",
    "CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_members_email ON group_members(email)",
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, sender_email TEXT NOT NULL, sender_name TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id)",
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  SCHEMA_READY = true;
}

/* ============================================================
 * The web app (served at GET /).
 * NOTE: the inline <script> below deliberately uses string
 * concatenation and single quotes — no backticks / ${} — so it
 * doesn't clash with this outer template literal.
 * ============================================================ */
const APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>Linear Chat</title>
  <link rel="icon" href="https://cftheitguy.github.io/favicon.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    html, body { height: 100%; }
    .msgs::-webkit-scrollbar { width: 8px; }
    .msgs::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 8px; }
  </style>
</head>
<body class="bg-gray-100 text-gray-900 antialiased">

  <!-- ============ AUTH SCREEN ============ -->
  <div id="authScreen" class="hidden min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-sm border w-full max-w-sm p-6">
      <img src="https://cftheitguy.github.io/assets/logo.png" alt="Linear IT" class="h-8 mb-5">
      <h1 class="text-xl font-bold">Linear Chat</h1>

      <!-- step 1: email -->
      <div id="emailStep" class="mt-5 space-y-3">
        <p class="text-sm text-gray-500">Sign in with your email. We'll send you a one-time code.</p>
        <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@company.com"
          class="w-full rounded-lg border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black">
        <button id="sendBtn" onclick="sendCode()"
          class="w-full bg-black text-white rounded-lg py-2.5 text-sm font-medium hover:bg-gray-800 transition">Send code</button>
      </div>

      <!-- step 2: code -->
      <div id="codeStep" class="mt-5 space-y-3 hidden">
        <p class="text-sm text-gray-500">Enter the 6-digit code we sent to
          <span id="codeEmailLabel" class="font-medium text-gray-700"></span>.</p>
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"
          class="w-full rounded-lg border px-3 py-2.5 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-black">
        <p id="devNote" class="hidden text-xs text-amber-600 bg-amber-50 rounded px-2 py-1"></p>
        <button id="verifyBtn" onclick="verifyCode()"
          class="w-full bg-black text-white rounded-lg py-2.5 text-sm font-medium hover:bg-gray-800 transition">Verify &amp; sign in</button>
        <div class="flex justify-between text-xs">
          <button onclick="backToEmail()" class="text-gray-500 hover:text-black underline">Use a different email</button>
          <button onclick="sendCode()" class="text-gray-500 hover:text-black underline">Resend code</button>
        </div>
      </div>

      <p id="authErr" class="hidden text-red-500 text-xs mt-3"></p>
    </div>
  </div>

  <!-- ============ APP SCREEN ============ -->
  <div id="appScreen" class="hidden">
    <div class="flex h-screen overflow-hidden">

      <!-- sidebar -->
      <aside id="sidebar" class="w-full md:w-80 bg-white border-r flex flex-col">
        <div class="px-4 py-3 border-b flex items-center justify-between">
          <img src="https://cftheitguy.github.io/assets/logo.png" alt="Linear IT" class="h-6">
          <button onclick="openMe()" class="text-xs text-gray-500 hover:text-black underline">Account</button>
        </div>
        <div class="px-4 py-3 border-b flex items-center justify-between">
          <h2 class="font-semibold text-sm">Groups</h2>
          <button id="newGroupBtn" onclick="createGroup()" class="hidden text-sm bg-black text-white rounded-lg px-3 py-1.5 hover:bg-gray-800">+ New</button>
        </div>
        <div id="groupList" class="flex-1 overflow-y-auto p-2 space-y-1"></div>
        <div class="px-4 py-3 border-t text-xs text-gray-400 flex items-center justify-between">
          <span id="whoami" class="truncate"></span>
          <button onclick="logout()" class="hover:text-black underline shrink-0 ml-2">Sign out</button>
        </div>
      </aside>

      <!-- chat -->
      <section id="chatPane" class="flex-1 flex-col bg-gray-50 hidden md:flex">
        <div id="chatEmpty" class="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Select a group to start chatting.
        </div>

        <div id="chatActive" class="hidden flex-1 flex flex-col min-h-0">
          <header class="bg-white border-b px-4 py-3 flex items-center gap-3">
            <button onclick="backToList()" class="md:hidden text-gray-500 hover:text-black">&larr;</button>
            <div class="min-w-0 flex-1">
              <h2 id="chatTitle" class="font-semibold truncate"></h2>
              <p id="chatSub" class="text-xs text-gray-400 truncate"></p>
            </div>
            <button id="membersBtn" onclick="openMembers()" class="hidden text-sm text-gray-500 hover:text-black underline">Members</button>
          </header>

          <div id="messages" class="msgs flex-1 overflow-y-auto p-4 space-y-2"></div>

          <form onsubmit="return sendMsg(event)" class="bg-white border-t p-3 flex items-end gap-2">
            <textarea id="composerInput" rows="1" placeholder="Type a message…" onkeydown="composerKey(event)"
              class="flex-1 resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black max-h-32"></textarea>
            <button type="submit" class="bg-black text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-gray-800">Send</button>
          </form>
        </div>
      </section>
    </div>
  </div>

  <!-- ============ MEMBERS MODAL ============ -->
  <div id="membersModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30">
    <div class="bg-white rounded-2xl shadow-lg w-full max-w-md p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Members</h3>
        <button onclick="closeModal('membersModal')" class="text-gray-400 hover:text-black text-xl leading-none">&times;</button>
      </div>
      <div id="addMemberRow" class="hidden flex gap-2 mb-3">
        <input id="newMemberEmail" type="email" placeholder="teammate@company.com"
          class="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black">
        <button onclick="addMember()" class="bg-black text-white rounded-lg px-3 py-2 text-sm hover:bg-gray-800">Add</button>
      </div>
      <div id="memberList" class="max-h-72 overflow-y-auto"></div>
    </div>
  </div>

  <!-- ============ ACCOUNT MODAL ============ -->
  <div id="meModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30">
    <div class="bg-white rounded-2xl shadow-lg w-full max-w-sm p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Your account</h3>
        <button onclick="closeModal('meModal')" class="text-gray-400 hover:text-black text-xl leading-none">&times;</button>
      </div>
      <label class="text-xs text-gray-500">Email</label>
      <p id="meEmail" class="text-sm font-medium mb-3"></p>
      <label class="text-xs text-gray-500">Display name</label>
      <div class="flex gap-2 mt-1">
        <input id="meName" type="text" placeholder="Your name"
          class="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black">
        <button onclick="saveName()" class="bg-black text-white rounded-lg px-3 py-2 text-sm hover:bg-gray-800">Save</button>
      </div>
    </div>
  </div>

  <script>
    var API = '';                 // same origin as this Worker
    var token = localStorage.getItem('chat_token') || '';
    var me = null;
    var groups = [];
    var active = null;
    var lastMsgId = 0;
    var poll = null;
    var pendingEmail = '';

    function $(id){ return document.getElementById(id); }
    function show(id){ $(id).classList.remove('hidden'); }
    function hide(id){ $(id).classList.add('hidden'); }
    function closeModal(id){ hide(id); }
    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function isMobile(){ return window.matchMedia('(max-width: 767px)').matches; }
    function setBusy(id, on){ var b=$(id); if(!b) return; b.disabled=on; b.classList.toggle('opacity-60', on); }
    function authErr(msg){ var e=$('authErr'); e.textContent=msg; e.classList.remove('hidden'); }

    async function api(path, opts){
      opts = opts || {};
      opts.headers = Object.assign({ 'Content-Type':'application/json' }, opts.headers || {});
      if(token) opts.headers['Authorization'] = 'Bearer ' + token;
      var res = await fetch(API + path, opts);
      var data = {};
      try { data = await res.json(); } catch(e){}
      if(!res.ok){
        var err = new Error(data.error || ('Request failed (' + res.status + ')'));
        err.status = res.status;
        throw err;
      }
      return data;
    }

    /* ---------- auth ---------- */
    async function sendCode(){
      var email = $('email').value.trim().toLowerCase();
      if(!email){ authErr('Enter your email.'); return; }
      hide('authErr'); setBusy('sendBtn', true);
      try {
        var r = await api('/api/auth/request', { method:'POST', body: JSON.stringify({ email: email }) });
        pendingEmail = email;
        $('codeEmailLabel').textContent = email;
        hide('emailStep'); show('codeStep');
        if(r.dev_code){ $('code').value = r.dev_code; $('devNote').textContent = 'Dev mode — your code is ' + r.dev_code; show('devNote'); }
        $('code').focus();
      } catch(e){ authErr(e.message); }
      setBusy('sendBtn', false);
    }
    function backToEmail(){ hide('codeStep'); show('emailStep'); hide('authErr'); $('code').value=''; }
    async function verifyCode(){
      var code = $('code').value.trim();
      if(!code){ authErr('Enter the code.'); return; }
      hide('authErr'); setBusy('verifyBtn', true);
      try {
        var r = await api('/api/auth/verify', { method:'POST', body: JSON.stringify({ email: pendingEmail, code: code }) });
        token = r.token; localStorage.setItem('chat_token', token);
        me = r.user; enterApp();
      } catch(e){ authErr(e.message); }
      setBusy('verifyBtn', false);
    }

    /* ---------- app shell ---------- */
    async function enterApp(){
      hide('authScreen'); show('appScreen');
      $('whoami').textContent = me.name || me.email;
      if(me.is_admin){ show('newGroupBtn'); } else { hide('newGroupBtn'); }
      if(!isMobile()){ $('chatPane').classList.remove('hidden'); }
      await loadGroups();
    }

    async function loadGroups(){
      try {
        var r = await api('/api/groups');
        groups = r.groups || [];
        renderGroups();
      } catch(e){ if(e.status===401) return logout(); }
    }

    function renderGroups(){
      var el = $('groupList'); el.innerHTML = '';
      if(!groups.length){
        el.innerHTML = '<p class="text-sm text-gray-400 px-3 py-6 text-center">' +
          (me.is_admin ? 'No groups yet. Tap <b>+ New</b> to create one.' : 'You\\'re not in any groups yet.') + '</p>';
        return;
      }
      groups.forEach(function(g){
        var b = document.createElement('button');
        b.className = 'w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-100 transition ' + (active && active.id===g.id ? 'bg-gray-100' : '');
        var sub = g.last_body
          ? esc((g.last_sender ? g.last_sender + ': ' : '') + g.last_body)
          : (g.member_count + ' member' + (g.member_count===1 ? '' : 's'));
        b.innerHTML = '<div class="flex items-center justify-between gap-2">' +
            '<span class="font-medium truncate">' + esc(g.name) + '</span>' +
            (g.role==='admin' ? '<span class="text-[10px] uppercase tracking-wide bg-gray-200 text-gray-600 rounded px-1.5 py-0.5 shrink-0">admin</span>' : '') +
          '</div>' +
          '<div class="text-xs text-gray-400 truncate mt-0.5">' + sub + '</div>';
        b.onclick = function(){ openGroup(g); };
        el.appendChild(b);
      });
    }

    /* ---------- one group ---------- */
    async function openGroup(g){
      active = g; lastMsgId = 0;
      renderGroups();
      hide('chatEmpty'); show('chatActive');
      $('chatTitle').textContent = g.name;
      $('chatSub').textContent = (g.role==='admin' ? 'Admin · ' : '') + g.member_count + ' member' + (g.member_count===1 ? '' : 's');
      if(g.role==='admin'){ show('membersBtn'); } else { hide('membersBtn'); }
      $('messages').innerHTML = '<p class="text-center text-sm text-gray-400 py-6">Loading…</p>';
      if(isMobile()){ hide('sidebar'); $('chatPane').classList.remove('hidden'); $('chatPane').classList.add('flex'); }
      await loadMessages(true);
      startPoll();
      $('composerInput').focus();
    }
    function backToList(){
      stopPoll(); active = null; renderGroups();
      if(isMobile()){ show('sidebar'); $('chatPane').classList.add('hidden'); $('chatPane').classList.remove('flex'); }
    }

    async function loadMessages(forceScroll){
      if(!active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/messages' + (lastMsgId ? ('?after=' + lastMsgId) : ''));
        var msgs = r.messages || [];
        var box = $('messages');
        var nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
        if(lastMsgId===0){ box.innerHTML=''; }
        msgs.forEach(addMessage);
        if(msgs.length){ lastMsgId = msgs[msgs.length-1].id; }
        if(forceScroll || nearBottom){ scrollBottom(); }
      } catch(e){ if(e.status===403 || e.status===401){ stopPoll(); } }
    }

    function addMessage(m){
      var mine = me && m.sender_email === me.email;
      var wrap = document.createElement('div');
      wrap.className = 'flex ' + (mine ? 'justify-end' : 'justify-start');
      var bubble = document.createElement('div');
      bubble.className = 'max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ' + (mine ? 'bg-black text-white' : 'bg-white text-gray-900 border');
      if(!mine){
        var who = document.createElement('div');
        who.className = 'text-xs font-medium text-gray-500 mb-0.5';
        who.textContent = m.sender_name || m.sender_email;
        bubble.appendChild(who);
      }
      var body = document.createElement('div');
      body.className = 'text-sm whitespace-pre-wrap break-words';
      body.textContent = m.body;                 // textContent → no XSS
      bubble.appendChild(body);
      var time = document.createElement('div');
      time.className = 'text-[10px] mt-1 ' + (mine ? 'text-gray-300 text-right' : 'text-gray-400');
      time.textContent = fmtTime(m.created_at);
      bubble.appendChild(time);
      wrap.appendChild(bubble);
      $('messages').appendChild(wrap);
    }

    function scrollBottom(){ var b=$('messages'); b.scrollTop = b.scrollHeight; }
    function fmtTime(s){
      if(!s) return '';
      var d = new Date(s.indexOf('Z')<0 && s.indexOf('T')<0 ? s.replace(' ','T') + 'Z' : s);
      if(isNaN(d)) return '';
      return d.toLocaleString(undefined, { hour:'2-digit', minute:'2-digit' });
    }

    function composerKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMsg(); } }
    async function sendMsg(e){
      if(e) e.preventDefault();
      var inp = $('composerInput'); var body = inp.value.trim();
      if(!body || !active) return false;
      inp.value=''; inp.style.height='auto';
      try {
        var r = await api('/api/groups/' + active.id + '/messages', { method:'POST', body: JSON.stringify({ body: body }) });
        if(r.message){ addMessage(r.message); lastMsgId = r.message.id; scrollBottom(); }
      } catch(err){ inp.value = body; alert(err.message); }
      return false;
    }

    function startPoll(){ stopPoll(); poll = setInterval(function(){ loadMessages(false); }, 3000); }
    function stopPoll(){ if(poll){ clearInterval(poll); poll=null; } }

    /* ---------- create group ---------- */
    async function createGroup(){
      var name = prompt('Name your group:');
      if(!name || !name.trim()) return;
      try {
        var r = await api('/api/groups', { method:'POST', body: JSON.stringify({ name: name.trim() }) });
        await loadGroups();
        if(r.group) openGroup(r.group);
      } catch(e){ alert(e.message); }
    }

    /* ---------- members ---------- */
    async function openMembers(){
      if(!active) return;
      show('membersModal');
      if(active.role==='admin'){ show('addMemberRow'); } else { hide('addMemberRow'); }
      $('memberList').innerHTML = '<p class="text-sm text-gray-400 py-4 text-center">Loading…</p>';
      try {
        var r = await api('/api/groups/' + active.id + '/members');
        var list = $('memberList'); list.innerHTML='';
        (r.members || []).forEach(function(mem){
          var row = document.createElement('div');
          row.className = 'flex items-center justify-between py-2 border-b last:border-0';
          var left = document.createElement('div');
          left.innerHTML = '<div class="text-sm font-medium">' + esc(mem.name || mem.email) + '</div>' +
            '<div class="text-xs text-gray-400">' + esc(mem.email) + (mem.role==='admin' ? ' · admin' : '') + '</div>';
          row.appendChild(left);
          if(active.role==='admin' && mem.email !== me.email){
            var del = document.createElement('button');
            del.className = 'text-xs text-red-500 hover:underline';
            del.textContent = 'Remove';
            del.onclick = function(){ removeMember(mem.email); };
            row.appendChild(del);
          }
          list.appendChild(row);
        });
      } catch(e){ $('memberList').innerHTML = '<p class="text-sm text-red-500 py-4 text-center">' + esc(e.message) + '</p>'; }
    }
    async function addMember(){
      var email = $('newMemberEmail').value.trim().toLowerCase();
      if(!email) return;
      try {
        await api('/api/groups/' + active.id + '/members', { method:'POST', body: JSON.stringify({ email: email }) });
        $('newMemberEmail').value='';
        active.member_count = (active.member_count||0) + 1;
        openMembers(); loadGroups();
      } catch(e){ alert(e.message); }
    }
    async function removeMember(email){
      if(!confirm('Remove ' + email + ' from this group?')) return;
      try {
        await api('/api/groups/' + active.id + '/members/remove', { method:'POST', body: JSON.stringify({ email: email }) });
        active.member_count = Math.max(1, (active.member_count||1) - 1);
        openMembers(); loadGroups();
      } catch(e){ alert(e.message); }
    }

    /* ---------- account ---------- */
    function openMe(){ $('meEmail').textContent = me.email; $('meName').value = me.name || ''; show('meModal'); }
    async function saveName(){
      var name = $('meName').value.trim();
      try {
        var r = await api('/api/me', { method:'POST', body: JSON.stringify({ name: name }) });
        me = r.user; $('whoami').textContent = me.name || me.email; closeModal('meModal');
      } catch(e){ alert(e.message); }
    }

    function logout(){ localStorage.removeItem('chat_token'); token=''; me=null; stopPoll(); location.reload(); }

    /* ---------- composer auto-grow ---------- */
    document.addEventListener('input', function(e){
      if(e.target && e.target.id==='composerInput'){
        e.target.style.height='auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px';
      }
    });

    /* ---------- boot ---------- */
    (async function init(){
      if(token){
        try { var r = await api('/api/me'); me = r.user; return enterApp(); }
        catch(e){ localStorage.removeItem('chat_token'); token=''; }
      }
      show('authScreen');
      $('email').focus();
    })();
  </script>
</body>
</html>`;

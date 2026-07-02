/**
 * Linear Chat — chat.linearit.co
 * ==============================================================
 * One self-contained Cloudflare Worker that is the WHOLE app:
 *   • GET  /            → serves the chat web app (single-page UI)
 *   • POST /api/auth/*  → email login with an MFA code (no passwords)
 *   • groups, members, messages, threaded replies, reactions, attachments
 *
 * Roles:
 *   • Admins create groups and add/remove members (by email).
 *   • Members sign in by email, get a one-time code, and chat with their team.
 *
 * Bind the Worker to the custom domain  chat.linearit.co  and you're live.
 *
 * Bindings
 *   DB                 D1 database (required). Run schema.sql once, or let the
 *                      Worker self-heal — it creates/migrates tables on demand.
 *   FILES              R2 bucket (optional). Required for attachments. If it's
 *                      not bound, file upload is disabled and chat still works.
 *
 * Secrets / variables
 *   AUTH_SECRET        long random string — signs tokens, codes & file links
 *   ADMIN_EMAILS       comma/space separated emails allowed to create groups.
 *                      If empty, the very first person to sign in becomes admin.
 *   EMAIL_FROM         From: address, e.g.  Linear Chat <chat@linearit.co>
 *   MAX_UPLOAD_MB      max attachment size in MB (default 20)
 *
 * Email delivery — set ONE of these (otherwise codes can only be read in DEV):
 *   RESEND_API_KEY     send via Resend  (https://resend.com)
 *   EMAIL_WEBHOOK_URL  POST {to,subject,text,html,from} to a webhook
 *
 * Optional
 *   DEV_MODE = "1"     return the login code in the API response (testing only)
 *   RESTRICT_TO_MEMBERS = "1"   only let known admins/members request a code
 *   ALLOW_ORIGIN       CORS origin for the API (default "*")
 */

const MAX_EMOJI = ["👍", "❤️", "😂", "🎉", "✅", "👀", "🙏", "🔥"];

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
  if (p === "/api/config" && method === "GET") return getConfig(env);
  if (method === "GET") {
    const fm = p.match(/^\/api\/files\/(\d+)$/);
    if (fm) return serveFile(env, url, Number(fm[1]));
  }

  // ---- Authenticated ----
  const claims = await authClaims(request, env);
  if (!claims) return json({ error: "Unauthorized" }, 401);
  const email = claims.email;

  if (p === "/api/me" && method === "GET") return getMe(env, email);
  if (p === "/api/me" && method === "POST") return updateMe(request, env, email);
  if (p === "/api/groups" && method === "GET") return listGroups(env, email);
  if (p === "/api/groups" && method === "POST") return createGroup(request, env, email);

  let m;
  if ((m = p.match(/^\/api\/groups\/(\d+)\/messages\/(\d+)\/thread$/))) {
    if (method === "GET") return getThread(env, email, Number(m[1]), Number(m[2]), url);
  }
  if ((m = p.match(/^\/api\/messages\/(\d+)\/react$/))) {
    if (method === "POST") return react(request, env, email, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/groups\/(\d+)\/(members\/remove|members|messages|badges|call)$/))) {
    const gid = Number(m[1]);
    const sub = m[2];
    if (sub === "members" && method === "GET") return listMembers(env, email, gid);
    if (sub === "members" && method === "POST") return addMember(request, env, email, gid);
    if (sub === "members/remove" && method === "POST") return removeMember(request, env, email, gid);
    if (sub === "messages" && method === "GET") return listMessages(env, email, gid, url);
    if (sub === "messages" && method === "POST") return postMessage(request, env, email, gid);
    if (sub === "badges" && method === "POST") return badges(request, env, email, gid);
    if (sub === "call" && method === "POST") return startCall(request, env, email, gid);
  }

  return json({ error: "Not found" }, 404);
}

function getConfig(env) {
  return json({
    attachments_enabled: !!env.FILES,
    max_upload_mb: Number(env.MAX_UPLOAD_MB || 20),
    emoji: MAX_EMOJI,
    calls_enabled: true,
    jitsi_domain: env.JITSI_DOMAIN || "meet.jit.si",
  });
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

  const recent = await env.DB
    .prepare("SELECT created_at FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (recent && now - Number(recent.created_at) < 45000) {
    return json({ error: "A code was just sent. Please wait a moment before requesting another." }, 429);
  }

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
 * Messages + threads
 * ============================================================ */
async function listMessages(env, email, gid, url) {
  await requireMember(env, gid, email);
  const after = Number(url.searchParams.get("after") || 0) || 0;
  let rows;
  if (after > 0) {
    rows = (await env.DB.prepare(
      "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, created_at FROM messages WHERE group_id=? AND parent_id IS NULL AND id>? ORDER BY id ASC LIMIT 200"
    ).bind(gid, after).all()).results || [];
  } else {
    rows = ((await env.DB.prepare(
      "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, created_at FROM messages WHERE group_id=? AND parent_id IS NULL ORDER BY id DESC LIMIT 100"
    ).bind(gid).all()).results || []).reverse();
  }
  await enrich(env, email, rows);
  return json({ messages: rows });
}

async function getThread(env, email, gid, mid, url) {
  await requireMember(env, gid, email);
  const parent = await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, created_at, group_id FROM messages WHERE id=? AND group_id=?"
  ).bind(mid, gid).first();
  if (!parent) return json({ error: "Thread not found." }, 404);

  const after = Number(url.searchParams.get("after") || 0) || 0;
  const replies = (await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, created_at FROM messages WHERE parent_id=? AND id>? ORDER BY id ASC LIMIT 500"
  ).bind(mid, after).all()).results || [];
  await enrich(env, email, replies);

  let p = null;
  if (after === 0) { [p] = await enrich(env, email, [parent]); }
  return json({ parent: p, messages: replies });
}

async function postMessage(request, env, email, gid) {
  await requireMember(env, gid, email);

  const ct = request.headers.get("content-type") || "";
  let body = "";
  let parentId = null;
  let files = [];
  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    body = String(fd.get("body") || "").trim();
    parentId = fd.get("parent_id") ? Number(fd.get("parent_id")) : null;
    for (const f of fd.getAll("files")) {
      if (f && typeof f === "object" && typeof f.arrayBuffer === "function") files.push(f);
    }
  } else {
    const j = await readBody(request);
    body = String(j.body || "").trim();
    parentId = j.parent_id ? Number(j.parent_id) : null;
  }

  if (parentId) {
    const parent = await env.DB.prepare("SELECT id, group_id, parent_id FROM messages WHERE id=?").bind(parentId).first();
    if (!parent || parent.group_id !== gid) return json({ error: "Reply target not found." }, 400);
    if (parent.parent_id) parentId = parent.parent_id; // flatten to one level
  }

  if (!body && files.length === 0) return json({ error: "Message is empty." }, 400);
  if (body.length > 4000) return json({ error: "Message is too long." }, 400);

  if (files.length) {
    if (!env.FILES) return json({ error: "Attachments aren't enabled. Bind an R2 bucket named FILES." }, 400);
    const maxBytes = Number(env.MAX_UPLOAD_MB || 20) * 1024 * 1024;
    for (const f of files) {
      if (f.size > maxBytes) return json({ error: "File too large (max " + (env.MAX_UPLOAD_MB || 20) + " MB)." }, 400);
    }
    if (files.length > 10) return json({ error: "Too many files (max 10)." }, 400);
  }

  const u = await env.DB.prepare("SELECT name FROM users WHERE email=?").bind(email).first();
  const name = u && u.name ? u.name : null;
  // Store "" rather than NULL: databases first created by the original schema
  // have body TEXT NOT NULL, and attachment-only messages have no text.
  const res = await env.DB
    .prepare("INSERT INTO messages (group_id, parent_id, sender_email, sender_name, body) VALUES (?,?,?,?,?)")
    .bind(gid, parentId, email, name, body || "").run();
  const id = res.meta.last_row_id;

  for (const f of files) {
    const safe = String(f.name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 100) || "file";
    const key = "g" + gid + "/" + id + "/" + crypto.randomUUID() + "-" + safe;
    await env.FILES.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type || "application/octet-stream" } });
    await env.DB.prepare(
      "INSERT INTO attachments (message_id, group_id, r2_key, filename, content_type, size) VALUES (?,?,?,?,?,?)"
    ).bind(id, gid, key, safe, f.type || "application/octet-stream", f.size || 0).run();
  }

  const row = await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, created_at FROM messages WHERE id=?"
  ).bind(id).first();
  const [enriched] = await enrich(env, email, [row]);
  return json({ message: enriched, parent_id: parentId });
}

/* ============================================================
 * Reactions
 * ============================================================ */
async function react(request, env, email, mid) {
  const msg = await env.DB.prepare("SELECT id, group_id FROM messages WHERE id=?").bind(mid).first();
  if (!msg) return json({ error: "Message not found." }, 404);
  await requireMember(env, msg.group_id, email);

  const body = await readBody(request);
  const emoji = String(body.emoji || "");
  if (!MAX_EMOJI.includes(emoji)) return json({ error: "Invalid reaction." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM reactions WHERE message_id=? AND email=? AND emoji=?")
    .bind(mid, email, emoji).first();
  if (existing) {
    await env.DB.prepare("DELETE FROM reactions WHERE id=?").bind(existing.id).run();
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO reactions (message_id, email, emoji) VALUES (?,?,?)").bind(mid, email, emoji).run();
  }
  return json({ message_id: mid, reactions: await reactionsFor(env, email, mid) });
}

async function reactionsFor(env, email, mid) {
  const rx = await env.DB.prepare("SELECT emoji, email FROM reactions WHERE message_id=?").bind(mid).all();
  const agg = {};
  for (const r of rx.results || []) {
    const e = (agg[r.emoji] = agg[r.emoji] || { emoji: r.emoji, count: 0, mine: false });
    e.count++;
    if (r.email === email) e.mine = true;
  }
  return Object.values(agg);
}

/* ============================================================
 * Live "badges" — reactions + reply counts for visible messages
 * ============================================================ */
async function badges(request, env, email, gid) {
  await requireMember(env, gid, email);
  const body = await readBody(request);
  let ids = body.ids;
  if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch (_) { ids = []; } }
  if (!Array.isArray(ids) || !ids.length) return json({ reactions: {}, replies: {} });
  ids = ids.map(Number).filter((n) => n > 0).slice(0, 300);
  if (!ids.length) return json({ reactions: {}, replies: {} });
  const ph = ids.map(() => "?").join(",");

  const rx = await env.DB.prepare("SELECT message_id, emoji, email FROM reactions WHERE message_id IN (" + ph + ")").bind(...ids).all();
  const rmap = {};
  for (const r of rx.results || []) {
    const mm = (rmap[r.message_id] = rmap[r.message_id] || {});
    const e = (mm[r.emoji] = mm[r.emoji] || { emoji: r.emoji, count: 0, mine: false });
    e.count++;
    if (r.email === email) e.mine = true;
  }
  const reactions = {};
  for (const k in rmap) reactions[k] = Object.values(rmap[k]);

  const rc = await env.DB.prepare("SELECT parent_id, COUNT(*) c FROM messages WHERE parent_id IN (" + ph + ") GROUP BY parent_id").bind(...ids).all();
  const replies = {};
  for (const r of rc.results || []) replies[r.parent_id] = r.c;

  return json({ reactions, replies });
}

/* ============================================================
 * Enrichment: attach reactions, attachments, reply_count to rows
 * ============================================================ */
async function enrich(env, email, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => Number(r.id));
  const ph = ids.map(() => "?").join(",");

  const rx = await env.DB.prepare("SELECT message_id, emoji, email FROM reactions WHERE message_id IN (" + ph + ")").bind(...ids).all();
  const rmap = {};
  for (const r of rx.results || []) {
    const mm = (rmap[r.message_id] = rmap[r.message_id] || {});
    const e = (mm[r.emoji] = mm[r.emoji] || { emoji: r.emoji, count: 0, mine: false });
    e.count++;
    if (r.email === email) e.mine = true;
  }

  const at = await env.DB.prepare("SELECT id, message_id, filename, content_type, size FROM attachments WHERE message_id IN (" + ph + ")").bind(...ids).all();
  const amap = {};
  for (const a of at.results || []) {
    (amap[a.message_id] = amap[a.message_id] || []).push({
      id: a.id, filename: a.filename, content_type: a.content_type, size: a.size,
      url: await signedFileUrl(env, a.id),
    });
  }

  const rc = await env.DB.prepare("SELECT parent_id, COUNT(*) c FROM messages WHERE parent_id IN (" + ph + ") GROUP BY parent_id").bind(...ids).all();
  const cmap = {};
  for (const r of rc.results || []) cmap[r.parent_id] = r.c;

  for (const r of rows) {
    r.reactions = rmap[r.id] ? Object.values(rmap[r.id]) : [];
    r.attachments = amap[r.id] || [];
    r.reply_count = cmap[r.id] || 0;
    if (r.meta && typeof r.meta === "string") { try { r.meta = JSON.parse(r.meta); } catch (_) { r.meta = null; } }
  }
  return rows;
}

/* ============================================================
 * Calls (Jitsi today; swap the provider later for Cloudflare Realtime)
 * ============================================================ */
async function startCall(request, env, email, gid) {
  await requireMember(env, gid, email);
  const b = await readBody(request);
  const mode = b.mode === "audio" ? "audio" : "video";
  const room = "linear-" + gid + "-" + randToken(10);
  const meta = JSON.stringify({ provider: "jitsi", room, domain: env.JITSI_DOMAIN || "meet.jit.si", mode, by: email });
  const u = await env.DB.prepare("SELECT name FROM users WHERE email=?").bind(email).first();
  const name = u && u.name ? u.name : null;
  const label = mode === "audio" ? "Voice call started" : "Video call started";
  const res = await env.DB
    .prepare("INSERT INTO messages (group_id, sender_email, sender_name, body, kind, meta) VALUES (?,?,?,?, 'call', ?)")
    .bind(gid, email, name, label, meta).run();
  const row = await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, created_at FROM messages WHERE id=?"
  ).bind(res.meta.last_row_id).first();
  const [enriched] = await enrich(env, email, [row]);
  return json({ message: enriched });
}
function randToken(n) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (let i = 0; i < n; i++) s += a[r[i] % a.length];
  return s;
}

/* ============================================================
 * Attachments: signed URLs + R2 serving
 * ============================================================ */
async function signedFileUrl(env, id) {
  const exp = Date.now() + 24 * 3600 * 1000;
  const sig = await hmacSign(env, "file:" + id + ":" + exp);
  return "/api/files/" + id + "?e=" + exp + "&t=" + sig;
}
async function serveFile(env, url, id) {
  const exp = Number(url.searchParams.get("e") || 0);
  const t = url.searchParams.get("t") || "";
  if (!exp || exp < Date.now()) return new Response("Link expired", { status: 403 });
  const good = await hmacSign(env, "file:" + id + ":" + exp);
  if (!timingSafeEqual(t, good)) return new Response("Bad signature", { status: 403 });
  if (!env.FILES) return new Response("Not configured", { status: 404 });

  const row = await env.DB.prepare("SELECT r2_key, filename, content_type FROM attachments WHERE id=?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return new Response("Not found", { status: 404 });

  const type = row.content_type || "application/octet-stream";
  const inline = /^(image|audio|video)\//.test(type) || type === "application/pdf";
  const h = new Headers();
  h.set("Content-Type", type);
  h.set("Content-Disposition", (inline ? "inline" : "attachment") + '; filename="' + String(row.filename || "file").replace(/"/g, "") + '"');
  h.set("Cache-Control", "private, max-age=86400");
  return new Response(obj.body, { headers: h });
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
  } catch (_) { /* fall through */ }
  return false;
}

/* ============================================================
 * Crypto: HMAC tokens, code hashing, signed file links
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
    // strict-origin-when-cross-origin (not no-referrer): lets embedded players
    // like YouTube see the embedding origin, which they require to play.
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" },
  });
}

/* ============================================================
 * Schema self-heal + migrations
 * ============================================================ */
let SCHEMA_READY = false;
async function ensureSchema(env) {
  if (SCHEMA_READY) return;
  if (!env.DB) { const e = new Error("Database not configured — bind a D1 database as DB."); e.status = 500; throw e; }
  const base = [
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email)",
    "CREATE TABLE IF NOT EXISTS chat_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(group_id, email))",
    "CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_members_email ON group_members(email)",
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, parent_id INTEGER, sender_email TEXT NOT NULL, sender_name TEXT, body TEXT, kind TEXT NOT NULL DEFAULT 'text', meta TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id)",
  ];
  for (const s of base) await env.DB.prepare(s).run();

  // Migrations for older databases (ignore "duplicate column" errors).
  const migrations = [
    "ALTER TABLE messages ADD COLUMN parent_id INTEGER",
    "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'",
    "ALTER TABLE messages ADD COLUMN meta TEXT",
  ];
  for (const a of migrations) {
    try { await env.DB.prepare(a).run(); } catch (_) { /* already exists */ }
  }

  const more = [
    "CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)",
    "CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, email TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(message_id, email, emoji))",
    "CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id)",
    "CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, group_id INTEGER NOT NULL, r2_key TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT, size INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id)",
  ];
  for (const s of more) await env.DB.prepare(s).run();

  SCHEMA_READY = true;
}

/* ============================================================
 * The web app (served at GET /).
 * NOTE: the inline <script> deliberately uses string concatenation
 * and single quotes — no backticks / ${} — so it doesn't clash with
 * this outer template literal.
 * ============================================================ */
const APP_HTML = `<!doctype html>
<!-- linear-chat: auto-deployed from GitHub via Cloudflare Workers Builds -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>Linear Chat</title>
  <link rel="icon" href="https://cftheitguy.github.io/favicon.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    html, body { height: 100%; }
    .msgs::-webkit-scrollbar, .thr::-webkit-scrollbar { width: 8px; }
    .msgs::-webkit-scrollbar-thumb, .thr::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 8px; }
    /* React/Reply buttons: hidden until you hover (desktop) or tap (touch) the message */
    .msg-actions { opacity: 0; pointer-events: none; transition: opacity .12s; }
    @media (hover: hover) { .group:hover .msg-actions { opacity: 1; pointer-events: auto; } }
    .msg-actions.show { opacity: 1; pointer-events: auto; }
  </style>
</head>
<body class="bg-gray-100 text-gray-900 antialiased">

  <!-- ============ AUTH SCREEN ============ -->
  <div id="authScreen" class="hidden min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-sm border w-full max-w-sm p-6">
      <img src="https://cftheitguy.github.io/assets/logo.png" alt="Linear IT" class="h-8 mb-5">
      <h1 class="text-xl font-bold">Linear Chat</h1>
      <div id="emailStep" class="mt-5 space-y-3">
        <p class="text-sm text-gray-500">Sign in with your email. We'll send you a one-time code.</p>
        <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@company.com"
          class="w-full rounded-lg border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black">
        <button id="sendBtn" onclick="sendCode()"
          class="w-full bg-black text-white rounded-lg py-2.5 text-sm font-medium hover:bg-gray-800 transition">Send code</button>
      </div>
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
            <button id="callAudioBtn" onclick="startCall('audio')" class="hidden text-xl leading-none hover:opacity-70" title="Start voice call">📞</button>
            <button id="callVideoBtn" onclick="startCall('video')" class="hidden text-xl leading-none hover:opacity-70" title="Start video call">🎥</button>
            <button id="membersBtn" onclick="openMembers()" class="hidden text-sm text-gray-500 hover:text-black underline">Members</button>
          </header>
          <div id="messages" class="msgs flex-1 overflow-y-auto p-4 space-y-1"></div>
          <div id="fileChips" class="hidden flex flex-wrap gap-2 px-3 pt-2 bg-white border-t"></div>
          <form id="composerForm" onsubmit="return sendMain(event)" class="bg-white border-t p-3 flex items-end gap-2">
            <input id="fileInput" type="file" multiple class="hidden" onchange="onPickFiles(this, mainFiles)">
            <button type="button" id="attachBtn" onclick="document.getElementById('fileInput').click()" title="Attach files"
              class="text-gray-500 hover:text-black text-xl leading-none px-1">📎</button>
            <button type="button" id="recBtn" onclick="startRec()" title="Record voice note"
              class="text-gray-500 hover:text-black text-xl leading-none px-1">🎤</button>
            <textarea id="composerInput" rows="1" placeholder="Type a message…" onkeydown="composerKey(event)"
              class="flex-1 resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black max-h-32"></textarea>
            <button type="submit" class="bg-black text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-gray-800">Send</button>
          </form>
          <!-- voice-note recording bar (shown while recording) -->
          <div id="recBar" class="hidden bg-white border-t p-3 flex items-center gap-3">
            <span class="flex items-center gap-2 text-red-600 font-medium">
              <span class="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse"></span>
              <span id="recTime">0:00</span>
            </span>
            <span class="text-sm text-gray-400 flex-1">Recording voice note…</span>
            <button type="button" onclick="cancelRec()" class="text-sm text-gray-500 hover:text-black">Cancel</button>
            <button type="button" onclick="stopRecAndSend()" class="bg-black text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-gray-800">Send</button>
          </div>
        </div>
      </section>

      <!-- thread panel -->
      <aside id="threadPanel" class="hidden fixed inset-0 z-20 bg-white md:static md:inset-auto md:z-auto md:w-96 md:border-l flex flex-col">
        <header class="bg-white border-b px-4 py-3 flex items-center gap-3">
          <button onclick="closeThread()" class="text-gray-500 hover:text-black">&larr;</button>
          <h2 class="font-semibold flex-1">Thread</h2>
        </header>
        <div id="threadMessages" class="thr flex-1 overflow-y-auto p-4 space-y-1"></div>
        <div id="threadChips" class="hidden flex flex-wrap gap-2 px-3 pt-2 bg-white border-t"></div>
        <form onsubmit="return sendThread(event)" class="bg-white border-t p-3 flex items-end gap-2">
          <input id="threadFileInput" type="file" multiple class="hidden" onchange="onPickFiles(this, threadFiles)">
          <button type="button" onclick="document.getElementById('threadFileInput').click()" title="Attach files"
            class="text-gray-500 hover:text-black text-xl leading-none px-1">📎</button>
          <textarea id="threadInput" rows="1" placeholder="Reply…" onkeydown="threadKey(event)"
            class="flex-1 resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black max-h-32"></textarea>
          <button type="submit" class="bg-black text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-gray-800">Reply</button>
        </form>
      </aside>
    </div>
  </div>

  <!-- emoji picker popover -->
  <div id="emojiPicker" class="hidden fixed z-40 bg-white border rounded-xl shadow-lg p-1 flex gap-1"></div>

  <!-- members modal -->
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

  <!-- account modal -->
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

  <!-- call overlay (Jitsi) -->
  <div id="callOverlay" class="hidden fixed inset-0 z-50 bg-black flex flex-col">
    <div class="flex items-center justify-between px-4 py-2 bg-gray-900 text-white shrink-0">
      <span id="callTitle" class="text-sm font-medium">Call</span>
      <button onclick="endCall()" class="bg-red-600 hover:bg-red-700 text-white rounded-lg px-3 py-1.5 text-sm font-medium">Leave call</button>
    </div>
    <div id="callFrame" class="flex-1 min-h-0"></div>
  </div>

  <script>
    var API = '';
    var token = localStorage.getItem('chat_token') || '';
    var me = null, config = { emoji: ['👍','❤️','😂','🎉','✅'], attachments_enabled: false, max_upload_mb: 20, calls_enabled: true, jitsi_domain: 'meet.jit.si' };
    var jitsiApi = null;
    var groups = [], active = null;
    var lastMsgId = 0, poll = null, pollTick = 0;
    var pendingEmail = '';
    var msgModel = {};            // id -> message object (latest)
    var topIds = {};              // top-level message ids rendered in main list
    var activeThread = null, threadLastId = 0, threadPoll = null;
    var mainFiles = { files: [], input: null, chips: 'fileChips' };
    var threadFiles = { files: [], input: null, chips: 'threadChips' };

    function $(id){ return document.getElementById(id); }
    function show(id){ $(id).classList.remove('hidden'); }
    function hide(id){ $(id).classList.add('hidden'); }
    function closeModal(id){ hide(id); }
    function ce(tag, cls){ var e=document.createElement(tag); if(cls) e.className=cls; return e; }
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
      if(!res.ok){ var err = new Error(data.error || ('Request failed (' + res.status + ')')); err.status = res.status; throw err; }
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
      try { config = await api('/api/config'); } catch(e){}
      if(!config.attachments_enabled){ $('attachBtn').classList.add('hidden'); }
      // Voice notes need R2 (attachments) + a browser that can record.
      if(!config.attachments_enabled || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || !window.MediaRecorder){ $('recBtn').classList.add('hidden'); }
      await loadGroups();
    }

    async function loadGroups(){
      try { var r = await api('/api/groups'); groups = r.groups || []; renderGroups(); }
      catch(e){ if(e.status===401) return logout(); }
    }
    function renderGroups(){
      var el = $('groupList'); el.innerHTML = '';
      if(!groups.length){
        el.innerHTML = '<p class="text-sm text-gray-400 px-3 py-6 text-center">' +
          (me.is_admin ? 'No groups yet. Tap <b>+ New</b> to create one.' : 'You\\'re not in any groups yet.') + '</p>';
        return;
      }
      groups.forEach(function(g){
        var b = ce('button', 'w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-100 transition ' + (active && active.id===g.id ? 'bg-gray-100' : ''));
        var sub = g.last_body ? esc((g.last_sender ? g.last_sender + ': ' : '') + g.last_body)
                              : (g.member_count + ' member' + (g.member_count===1 ? '' : 's'));
        b.innerHTML = '<div class="flex items-center justify-between gap-2">' +
            '<span class="font-medium truncate">' + esc(g.name) + '</span>' +
            (g.role==='admin' ? '<span class="text-[10px] uppercase tracking-wide bg-gray-200 text-gray-600 rounded px-1.5 py-0.5 shrink-0">admin</span>' : '') +
          '</div><div class="text-xs text-gray-400 truncate mt-0.5">' + sub + '</div>';
        b.onclick = function(){ openGroup(g); };
        el.appendChild(b);
      });
    }

    /* ---------- one group ---------- */
    async function openGroup(g){
      active = g; lastMsgId = 0; msgModel = {}; topIds = {};
      closeThread();
      renderGroups();
      hide('chatEmpty'); show('chatActive');
      $('chatTitle').textContent = g.name;
      $('chatSub').textContent = (g.role==='admin' ? 'Admin · ' : '') + g.member_count + ' member' + (g.member_count===1 ? '' : 's');
      if(g.role==='admin'){ show('membersBtn'); } else { hide('membersBtn'); }
      if(config.calls_enabled){ show('callAudioBtn'); show('callVideoBtn'); }
      $('messages').innerHTML = '<p class="text-center text-sm text-gray-400 py-6">Loading…</p>';
      if(isMobile()){ hide('sidebar'); $('chatPane').classList.remove('hidden'); $('chatPane').classList.add('flex'); }
      await loadMessages(true);
      startPoll();
      $('composerInput').focus();
    }
    function backToList(){
      stopPoll(); active = null; closeThread(); renderGroups();
      if(isMobile()){ show('sidebar'); $('chatPane').classList.add('hidden'); $('chatPane').classList.remove('flex'); }
    }

    async function loadMessages(forceScroll){
      if(!active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/messages' + (lastMsgId ? ('?after=' + lastMsgId) : ''));
        var msgs = r.messages || [];
        var box = $('messages');
        var nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 100;
        if(lastMsgId===0){ box.innerHTML=''; }
        msgs.forEach(function(m){ appendTop(m); });
        if(msgs.length){ lastMsgId = msgs[msgs.length-1].id; }
        if(forceScroll || nearBottom){ scrollBottom(); }
      } catch(e){ if(e.status===403 || e.status===401){ stopPoll(); } }
    }
    function appendTop(m){ msgModel[m.id]=m; topIds[m.id]=true; $('messages').appendChild(renderMessage(m, {})); }
    function scrollBottom(){ var b=$('messages'); b.scrollTop = b.scrollHeight; }

    function fmtTime(s){
      if(!s) return '';
      var d = new Date((s.indexOf('Z')<0 && s.indexOf('T')<0) ? s.replace(' ','T') + 'Z' : s);
      if(isNaN(d)) return '';
      return d.toLocaleString(undefined, { hour:'2-digit', minute:'2-digit' });
    }
    function fmtSize(b){ if(!b) return ''; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(0)+' KB'; return (b/1048576).toFixed(1)+' MB'; }

    /* ---------- render a message ---------- */
    function renderMessage(m, opts){
      opts = opts || {};
      msgModel[m.id] = m;
      if(m.kind==='call' && m.meta){ return renderCallCard(m); }
      var mine = me && m.sender_email === me.email;
      var row = ce('div', 'group flex ' + (mine ? 'justify-end' : 'justify-start'));
      var col = ce('div', 'max-w-[80%] flex flex-col ' + (mine ? 'items-end' : 'items-start'));

      var bubble = ce('div', 'rounded-2xl px-3 py-2 shadow-sm ' + (mine ? 'bg-black text-white' : 'bg-white text-gray-900 border'));
      if(!mine){ var who = ce('div','text-xs font-medium text-gray-500 mb-0.5'); who.textContent = m.sender_name || m.sender_email; bubble.appendChild(who); }
      if(m.body){ var b = ce('div','text-sm whitespace-pre-wrap break-words'); appendBodyWithLinks(b, m.body, mine); bubble.appendChild(b); }
      if(m.attachments && m.attachments.length){ bubble.appendChild(renderAttachments(m.attachments, mine)); }
      var time = ce('div','text-[10px] mt-1 ' + (mine ? 'text-gray-300 text-right' : 'text-gray-400')); time.textContent = fmtTime(m.created_at); bubble.appendChild(time);
      col.appendChild(bubble);
      if(m.body){ var emb = buildEmbeds(m.body); if(emb) col.appendChild(emb); }

      var rx = ce('div','flex flex-wrap gap-1 mt-1'); rx.setAttribute('data-rx', m.id); col.appendChild(rx); renderReactions(rx, m);

      var meta = ce('div','flex items-center gap-3 mt-0.5 text-xs text-gray-400');
      // React + Reply live in .msg-actions (revealed on hover/tap); reply-count stays visible.
      var actions = ce('div','msg-actions flex items-center gap-3');
      var reactBtn = ce('button','hover:text-black'); reactBtn.textContent='🙂'; reactBtn.title='React'; reactBtn.onclick=function(ev){ openEmojiPicker(ev, m.id); }; actions.appendChild(reactBtn);
      if(!opts.inThread){
        var replyBtn = ce('button','hover:text-black'); replyBtn.textContent='↩ Reply'; replyBtn.onclick=function(){ openThread(m.id); }; actions.appendChild(replyBtn);
      }
      meta.appendChild(actions);
      if(!opts.inThread){
        var rc = ce('button','hover:text-black font-medium'); rc.setAttribute('data-rc', m.id);
        if(m.reply_count>0){ rc.textContent = '💬 ' + m.reply_count + ' repl' + (m.reply_count===1?'y':'ies'); } else { rc.classList.add('hidden'); }
        rc.onclick=function(){ openThread(m.id); }; meta.appendChild(rc);
      }
      col.appendChild(meta);
      // Touch devices have no hover — tap the message bubble to reveal its actions.
      row.addEventListener('click', function(e){
        if(!window.matchMedia('(hover: none)').matches) return;
        if(e.target.closest('a,button,iframe,video,audio,img,input,textarea')) return;
        actions.classList.toggle('show');
      });
      row.appendChild(col);
      return row;
    }

    function renderAttachments(atts, mine){
      var wrap = ce('div','mt-2 space-y-2');
      atts.forEach(function(a){
        if(/^image\\//.test(a.content_type || '')){
          var img = ce('img','rounded-lg max-h-60 cursor-pointer border'); img.src=a.url; img.alt=a.filename; img.loading='lazy';
          img.onclick=function(){ window.open(a.url,'_blank'); };
          wrap.appendChild(img);
        } else if(/^audio\\//.test(a.content_type || '')){
          var au = ce('audio','w-56 sm:w-64'); au.src=a.url; au.controls=true; au.preload='metadata';
          wrap.appendChild(au);
        } else if(/^video\\//.test(a.content_type || '')){
          var vid = ce('video','w-64 sm:w-80 rounded-lg border'); vid.src=a.url; vid.controls=true; vid.preload='metadata';
          wrap.appendChild(vid);
        } else {
          var link = ce('a','flex items-center gap-2 rounded-lg border px-3 py-2 ' + (mine ? 'bg-white/10 border-white/20 text-white' : 'bg-gray-50 hover:bg-gray-100'));
          link.href=a.url; link.setAttribute('download', a.filename); link.target='_blank';
          link.innerHTML = '<span>📎</span><span class="text-sm truncate">' + esc(a.filename) + '</span><span class="text-xs opacity-60 shrink-0">' + fmtSize(a.size) + '</span>';
          wrap.appendChild(link);
        }
      });
      return wrap;
    }

    function renderReactions(container, m){
      container.innerHTML = '';
      (m.reactions || []).forEach(function(rx){
        var chip = ce('button','text-xs rounded-full px-2 py-0.5 border ' + (rx.mine ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'));
        chip.textContent = rx.emoji + ' ' + rx.count;
        chip.onclick = function(){ toggleReact(m.id, rx.emoji); };
        container.appendChild(chip);
      });
    }

    /* ---------- link detection + media embeds (YouTube etc.) ----------
       NOTE: regexes use new RegExp('...') with doubled backslashes so they
       survive this file being embedded in the Worker's template literal. */
    function isHttpUrl(u){ u=String(u).toLowerCase(); return u.slice(0,7)==='http://' || u.slice(0,8)==='https://'; }
    function findUrls(text){ return String(text).match(/https?:\\/\\/[^\\s<]+/g) || []; }
    function ytId(u){ var m=String(u).match(/(?:youtube\\.com\\/watch\\?[^#]*?\\bv=|youtu\\.be\\/|youtube\\.com\\/(?:embed|shorts|v|live)\\/)([A-Za-z0-9_-]{11})/i); return m?m[1]:null; }
    function vimeoId(u){ var m=String(u).match(/vimeo\\.com\\/(?:video\\/)?([0-9]+)/i); return m?m[1]:null; }
    function isImgUrl(u){ return /\\.(png|jpe?g|gif|webp|bmp|svg)([?#]|$)/i.test(u); }
    function isVidUrl(u){ return /\\.(mp4|webm|ogv|mov)([?#]|$)/i.test(u); }
    function isAudUrl(u){ return /\\.(mp3|ogg|wav|m4a)([?#]|$)/i.test(u); }

    function appendBodyWithLinks(container, text, mine){
      var parts = String(text).split(/(https?:\\/\\/[^\\s<]+)/);
      parts.forEach(function(part){
        if(!part) return;
        if(isHttpUrl(part)){
          var a = ce('a','underline break-all ' + (mine ? 'text-blue-200' : 'text-blue-600'));
          a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = part;
          container.appendChild(a);
        } else { container.appendChild(document.createTextNode(part)); }
      });
    }

    function buildEmbeds(text){
      var urls = findUrls(text).slice(0,5), wrap=null, count=0, seen={};
      urls.forEach(function(u){
        if(count>=3 || seen[u]) return; seen[u]=1;
        var node = buildOneEmbed(u);
        if(node){ if(!wrap) wrap = ce('div','mt-1 space-y-2'); wrap.appendChild(node); count++; }
      });
      return wrap;
    }

    function buildOneEmbed(u){
      var yid = ytId(u);
      if(yid){
        // Click-to-play: show the thumbnail, swap to the player on click (light + Slack-like)
        var box = ce('div','relative w-72 sm:w-96 aspect-video rounded-lg overflow-hidden border bg-black cursor-pointer');
        var thumb = ce('img','w-full h-full object-cover'); thumb.src='https://img.youtube.com/vi/'+yid+'/hqdefault.jpg'; thumb.loading='lazy'; thumb.alt='YouTube video';
        var play = ce('div','absolute inset-0 flex items-center justify-center');
        var pin = ce('div','rounded-full w-14 h-14 flex items-center justify-center text-white text-2xl'); pin.style.background='rgba(0,0,0,0.6)'; pin.textContent='▶';
        play.appendChild(pin); box.appendChild(thumb); box.appendChild(play);
        box.onclick = function(){
          var f = ce('iframe','w-full h-full');
          f.src='https://www.youtube.com/embed/'+yid+'?autoplay=1&origin='+encodeURIComponent(location.origin);
          f.setAttribute('frameborder','0');
          f.setAttribute('allow','accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
          f.setAttribute('allowfullscreen','');
          box.innerHTML=''; box.classList.remove('cursor-pointer'); box.onclick=null; box.appendChild(f);
        };
        return box;
      }
      var vid = vimeoId(u);
      if(vid){
        var vb = ce('div','w-72 sm:w-96 aspect-video');
        var vf = ce('iframe','w-full h-full rounded-lg border'); vf.src='https://player.vimeo.com/video/'+vid;
        vf.setAttribute('allow','autoplay; fullscreen; picture-in-picture'); vf.setAttribute('allowfullscreen',''); vf.loading='lazy';
        vb.appendChild(vf); return vb;
      }
      if(isImgUrl(u)){ var img=ce('img','max-w-xs max-h-72 rounded-lg border cursor-pointer'); img.src=u; img.loading='lazy'; img.onclick=function(){ window.open(u,'_blank'); }; return img; }
      if(isVidUrl(u)){ var v=ce('video','w-72 sm:w-96 rounded-lg border'); v.src=u; v.controls=true; return v; }
      if(isAudUrl(u)){ var a=ce('audio','w-64'); a.src=u; a.controls=true; return a; }
      return null;
    }

    /* ---------- call card ---------- */
    function renderCallCard(m){
      var row = ce('div','flex justify-center my-2');
      var card = ce('div','rounded-2xl border bg-white px-4 py-3 shadow-sm text-center max-w-xs');
      var audio = m.meta.mode === 'audio';
      var t = ce('div','text-sm font-medium'); t.textContent = (audio ? '📞 ' : '🎥 ') + (audio ? 'Voice call' : 'Video call'); card.appendChild(t);
      var who = ce('div','text-xs text-gray-400 mb-2'); who.textContent = 'Started by ' + (m.sender_name || m.sender_email) + ' · ' + fmtTime(m.created_at); card.appendChild(who);
      var join = ce('button','text-sm bg-black text-white rounded-lg px-4 py-1.5 hover:bg-gray-800'); join.textContent = 'Join'; join.onclick = function(){ joinCall(m.meta); };
      card.appendChild(join);
      row.appendChild(card);
      return row;
    }

    /* ---------- calls (Jitsi) ---------- */
    async function startCall(mode){
      if(!active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/call', { method:'POST', body: JSON.stringify({ mode: mode }) });
        if(r.message){ appendTop(r.message); scrollBottom(); lastMsgId = Math.max(lastMsgId, r.message.id); startJitsi(r.message.meta.room, r.message.meta.mode); }
      } catch(e){ alert(e.message); }
    }
    function joinCall(meta){ if(meta && meta.room){ startJitsi(meta.room, meta.mode || 'video'); } }
    function loadJitsiScript(){
      return new Promise(function(resolve, reject){
        if(window.JitsiMeetExternalAPI) return resolve();
        var s = document.createElement('script');
        s.src = 'https://' + (config.jitsi_domain || 'meet.jit.si') + '/external_api.js';
        s.onload = function(){ resolve(); }; s.onerror = function(){ reject(new Error('Could not load the call library.')); };
        document.head.appendChild(s);
      });
    }
    function startJitsi(room, mode){
      var domain = config.jitsi_domain || 'meet.jit.si';
      show('callOverlay');
      $('callTitle').textContent = (mode==='audio' ? '📞 Voice call' : '🎥 Video call');
      loadJitsiScript().then(function(){
        if(jitsiApi){ try { jitsiApi.dispose(); } catch(e){} jitsiApi = null; }
        $('callFrame').innerHTML = '';
        jitsiApi = new JitsiMeetExternalAPI(domain, {
          roomName: room,
          parentNode: $('callFrame'),
          width: '100%', height: '100%',
          userInfo: { displayName: (me && (me.name || me.email)) || 'Guest' },
          configOverwrite: { startWithVideoMuted: (mode==='audio'), prejoinPageEnabled: false, disableDeepLinking: true },
          interfaceConfigOverwrite: { MOBILE_APP_PROMO: false }
        });
        jitsiApi.addEventListener('readyToClose', endCall);
      }).catch(function(){
        // fallback: open the room in a new tab
        window.open('https://' + domain + '/' + room, '_blank');
        hide('callOverlay');
      });
    }
    function endCall(){ if(jitsiApi){ try { jitsiApi.dispose(); } catch(e){} jitsiApi = null; } $('callFrame').innerHTML = ''; hide('callOverlay'); }

    /* ---------- voice notes (record → upload as an audio attachment) ---------- */
    var recRecorder = null, recStream = null, recChunks = [], recTimer = null, recStart = 0, recDiscard = false, recMime = '';
    function pickRecMime(){
      var c = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'];
      for(var i=0;i<c.length;i++){ try { if(window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch(e){} }
      return '';
    }
    function recExt(type){ type = type || ''; if(type.indexOf('webm')>=0) return 'webm'; if(type.indexOf('mp4')>=0) return 'm4a'; if(type.indexOf('ogg')>=0) return 'ogg'; if(type.indexOf('wav')>=0) return 'wav'; return 'webm'; }
    function showRecBar(on){ if(on){ hide('composerForm'); show('recBar'); } else { show('composerForm'); hide('recBar'); } }
    function updateRecTime(){ var s=Math.floor((Date.now()-recStart)/1000); var m=Math.floor(s/60); var ss=s%60; $('recTime').textContent = m + ':' + (ss<10?'0':'') + ss; }
    function stopRecStream(){ if(recStream){ recStream.getTracks().forEach(function(t){ t.stop(); }); recStream=null; } if(recTimer){ clearInterval(recTimer); recTimer=null; } showRecBar(false); }
    async function startRec(){
      if(!active) return;
      if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || !window.MediaRecorder){ alert('Voice recording is not supported on this browser.'); return; }
      try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch(e){ alert('Microphone access was blocked. Allow mic access to record a voice note.'); return; }
      recChunks = []; recDiscard = false; recMime = pickRecMime();
      try { recRecorder = recMime ? new MediaRecorder(recStream, { mimeType: recMime }) : new MediaRecorder(recStream); }
      catch(e){ try { recRecorder = new MediaRecorder(recStream); } catch(e2){ alert('Could not start recording.'); stopRecStream(); return; } }
      recRecorder.ondataavailable = function(ev){ if(ev.data && ev.data.size>0) recChunks.push(ev.data); };
      recRecorder.onstop = function(){
        var type = (recRecorder && recRecorder.mimeType) || recMime || 'audio/webm';
        stopRecStream();
        if(recDiscard) return;
        var blob = new Blob(recChunks, { type: type });
        if(blob.size>0) sendVoiceNote(blob, type);
      };
      recRecorder.start();
      recStart = Date.now(); showRecBar(true); updateRecTime(); recTimer = setInterval(updateRecTime, 250);
    }
    function stopRecAndSend(){ if(recRecorder && recRecorder.state!=='inactive'){ recDiscard=false; recRecorder.stop(); } }
    function cancelRec(){ recDiscard=true; if(recRecorder && recRecorder.state!=='inactive'){ recRecorder.stop(); } else { stopRecStream(); } }
    async function sendVoiceNote(blob, type){
      if(!active) return;
      var file = new File([blob], 'voice-note-' + Date.now() + '.' + recExt(type), { type: type });
      try {
        var fd = new FormData(); fd.append('body',''); fd.append('files', file);
        var res = await fetch(API + '/api/groups/' + active.id + '/messages', { method:'POST', headers:{ Authorization:'Bearer ' + token }, body: fd });
        var data = {}; try { data = await res.json(); } catch(e){}
        if(!res.ok) throw new Error(data.error || 'Upload failed');
        if(data.message){ appendTop(data.message); scrollBottom(); lastMsgId = Math.max(lastMsgId, data.message.id); }
      } catch(err){ alert(err.message); }
    }

    /* ---------- reactions ---------- */
    function openEmojiPicker(ev, mid){
      var pick = $('emojiPicker'); pick.innerHTML='';
      (config.emoji || []).forEach(function(em){
        var btn = ce('button','text-xl hover:scale-125 transition px-1'); btn.textContent=em;
        btn.onclick=function(){ toggleReact(mid, em); hide('emojiPicker'); };
        pick.appendChild(btn);
      });
      pick.style.left = Math.min(ev.clientX, window.innerWidth-220) + 'px';
      pick.style.top = Math.max(ev.clientY - 50, 10) + 'px';
      show('emojiPicker');
    }
    document.addEventListener('click', function(ev){
      var pick = $('emojiPicker');
      if(pick && !pick.classList.contains('hidden') && !pick.contains(ev.target) && !(ev.target.title==='React')){ hide('emojiPicker'); }
    });
    async function toggleReact(mid, emoji){
      try {
        var r = await api('/api/messages/' + mid + '/react', { method:'POST', body: JSON.stringify({ emoji: emoji }) });
        if(msgModel[mid]){ msgModel[mid].reactions = r.reactions; }
        document.querySelectorAll('[data-rx="' + mid + '"]').forEach(function(c){ if(msgModel[mid]) renderReactions(c, msgModel[mid]); });
      } catch(e){ alert(e.message); }
    }

    /* ---------- live badges (reactions + reply counts) ---------- */
    async function refreshBadges(){
      if(!active) return;
      var ids = Object.keys(topIds).map(Number);
      if(!ids.length) return;
      try {
        var r = await api('/api/groups/' + active.id + '/badges', { method:'POST', body: JSON.stringify({ ids: ids }) });
        ids.forEach(function(id){
          if(!msgModel[id]) return;
          msgModel[id].reactions = r.reactions[id] || [];
          document.querySelectorAll('[data-rx="' + id + '"]').forEach(function(c){ renderReactions(c, msgModel[id]); });
          var rc = r.replies[id] || 0; msgModel[id].reply_count = rc;
          document.querySelectorAll('[data-rc="' + id + '"]').forEach(function(b){
            if(rc>0){ b.textContent = '💬 ' + rc + ' repl' + (rc===1?'y':'ies'); b.classList.remove('hidden'); } else { b.classList.add('hidden'); }
          });
        });
      } catch(e){}
    }

    function startPoll(){ stopPoll(); pollTick=0; poll = setInterval(function(){ pollTick++; loadMessages(false); if(pollTick % 2 === 0) refreshBadges(); }, 3000); }
    function stopPoll(){ if(poll){ clearInterval(poll); poll=null; } }

    /* ---------- threads ---------- */
    async function openThread(pid){
      activeThread = pid; threadLastId = 0;
      show('threadPanel');
      $('threadMessages').innerHTML = '<p class="text-center text-sm text-gray-400 py-6">Loading…</p>';
      await loadThread(true);
      startThreadPoll();
      $('threadInput').focus();
    }
    function closeThread(){ stopThreadPoll(); activeThread = null; threadLastId = 0; threadFiles.files=[]; renderChips(threadFiles); hide('threadPanel'); }
    async function loadThread(force){
      if(activeThread==null || !active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/messages/' + activeThread + '/thread' + (threadLastId ? ('?after=' + threadLastId) : ''));
        var box = $('threadMessages');
        if(threadLastId===0){
          box.innerHTML='';
          if(r.parent){ box.appendChild(renderMessage(r.parent, { inThread:true })); }
          var lbl = ce('div','text-xs text-gray-400 border-t pt-2 mt-2'); lbl.textContent='Replies'; box.appendChild(lbl);
        }
        (r.messages || []).forEach(function(m){ box.appendChild(renderMessage(m, { inThread:true })); });
        if(r.messages && r.messages.length){ threadLastId = r.messages[r.messages.length-1].id; }
        if(force){ box.scrollTop = box.scrollHeight; }
      } catch(e){ if(e.status===403 || e.status===401){ stopThreadPoll(); } }
    }
    function startThreadPoll(){ stopThreadPoll(); threadPoll = setInterval(function(){ loadThread(false); }, 3000); }
    function stopThreadPoll(){ if(threadPoll){ clearInterval(threadPoll); threadPoll=null; } }

    /* ---------- composer + attachments ---------- */
    function composerKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMain(); } }
    function threadKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendThread(); } }
    function onPickFiles(input, state){
      var maxBytes = (config.max_upload_mb || 20) * 1024 * 1024;
      for(var i=0;i<input.files.length;i++){
        var f = input.files[i];
        if(f.size > maxBytes){ alert('"' + f.name + '" is larger than ' + (config.max_upload_mb||20) + ' MB.'); continue; }
        if(state.files.length >= 10){ alert('Up to 10 files.'); break; }
        state.files.push(f);
      }
      input.value=''; renderChips(state);
    }
    function renderChips(state){
      var box = $(state.chips); box.innerHTML='';
      if(!state.files.length){ box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      state.files.forEach(function(f, idx){
        var chip = ce('div','flex items-center gap-2 bg-gray-100 rounded-lg px-2 py-1 text-xs');
        chip.innerHTML = '<span class="truncate max-w-[140px]">' + esc(f.name) + '</span><span class="text-gray-400">' + fmtSize(f.size) + '</span>';
        var x = ce('button','text-gray-400 hover:text-red-500'); x.textContent='✕';
        x.onclick=function(){ state.files.splice(idx,1); renderChips(state); };
        chip.appendChild(x); box.appendChild(chip);
      });
    }

    function sendMain(e){ if(e) e.preventDefault(); submitMessage(null, 'composerInput', mainFiles); return false; }
    function sendThread(e){ if(e) e.preventDefault(); submitMessage(activeThread, 'threadInput', threadFiles); return false; }

    async function submitMessage(parentId, inputId, state){
      var inp = $(inputId); var body = inp.value.trim();
      if(!body && !state.files.length) return;
      if(!active) return;
      var files = state.files.slice();
      inp.value=''; inp.style.height='auto'; state.files=[]; renderChips(state);
      try {
        var res;
        if(files.length){
          var fd = new FormData();
          fd.append('body', body);
          if(parentId) fd.append('parent_id', String(parentId));
          files.forEach(function(f){ fd.append('files', f); });
          res = await fetch(API + '/api/groups/' + active.id + '/messages', { method:'POST', headers:{ Authorization:'Bearer ' + token }, body: fd });
        } else {
          res = await fetch(API + '/api/groups/' + active.id + '/messages', { method:'POST', headers:{ Authorization:'Bearer ' + token, 'Content-Type':'application/json' }, body: JSON.stringify({ body: body, parent_id: parentId || null }) });
        }
        var data = {}; try { data = await res.json(); } catch(e){}
        if(!res.ok) throw new Error(data.error || 'Send failed');
        var m = data.message;
        if(m){
          msgModel[m.id] = m;
          if(parentId){
            $('threadMessages').appendChild(renderMessage(m, { inThread:true }));
            $('threadMessages').scrollTop = $('threadMessages').scrollHeight;
            threadLastId = Math.max(threadLastId, m.id);
            if(msgModel[parentId]){
              msgModel[parentId].reply_count = (msgModel[parentId].reply_count||0) + 1;
              var c = msgModel[parentId].reply_count;
              document.querySelectorAll('[data-rc="' + parentId + '"]').forEach(function(b){ b.textContent='💬 ' + c + ' repl' + (c===1?'y':'ies'); b.classList.remove('hidden'); });
            }
          } else {
            appendTop(m); scrollBottom(); lastMsgId = Math.max(lastMsgId, m.id);
          }
        }
      } catch(err){ inp.value = body; alert(err.message); }
    }

    /* ---------- create group ---------- */
    async function createGroup(){
      var name = prompt('Name your group:');
      if(!name || !name.trim()) return;
      try { var r = await api('/api/groups', { method:'POST', body: JSON.stringify({ name: name.trim() }) }); await loadGroups(); if(r.group) openGroup(r.group); }
      catch(e){ alert(e.message); }
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
          var rowEl = ce('div','flex items-center justify-between py-2 border-b last:border-0');
          var left = ce('div'); left.innerHTML = '<div class="text-sm font-medium">' + esc(mem.name || mem.email) + '</div><div class="text-xs text-gray-400">' + esc(mem.email) + (mem.role==='admin' ? ' · admin' : '') + '</div>';
          rowEl.appendChild(left);
          if(active.role==='admin' && mem.email !== me.email){
            var del = ce('button','text-xs text-red-500 hover:underline'); del.textContent='Remove'; del.onclick=function(){ removeMember(mem.email); };
            rowEl.appendChild(del);
          }
          list.appendChild(rowEl);
        });
      } catch(e){ $('memberList').innerHTML = '<p class="text-sm text-red-500 py-4 text-center">' + esc(e.message) + '</p>'; }
    }
    async function addMember(){
      var email = $('newMemberEmail').value.trim().toLowerCase();
      if(!email) return;
      try { await api('/api/groups/' + active.id + '/members', { method:'POST', body: JSON.stringify({ email: email }) }); $('newMemberEmail').value=''; active.member_count=(active.member_count||0)+1; openMembers(); loadGroups(); }
      catch(e){ alert(e.message); }
    }
    async function removeMember(email){
      if(!confirm('Remove ' + email + ' from this group?')) return;
      try { await api('/api/groups/' + active.id + '/members/remove', { method:'POST', body: JSON.stringify({ email: email }) }); active.member_count=Math.max(1,(active.member_count||1)-1); openMembers(); loadGroups(); }
      catch(e){ alert(e.message); }
    }

    /* ---------- account ---------- */
    function openMe(){ $('meEmail').textContent = me.email; $('meName').value = me.name || ''; show('meModal'); }
    async function saveName(){
      var name = $('meName').value.trim();
      try { var r = await api('/api/me', { method:'POST', body: JSON.stringify({ name: name }) }); me = r.user; $('whoami').textContent = me.name || me.email; closeModal('meModal'); }
      catch(e){ alert(e.message); }
    }
    function logout(){ localStorage.removeItem('chat_token'); token=''; me=null; stopPoll(); stopThreadPoll(); location.reload(); }

    /* ---------- composer auto-grow ---------- */
    document.addEventListener('input', function(e){
      if(e.target && (e.target.id==='composerInput' || e.target.id==='threadInput')){
        e.target.style.height='auto'; e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px';
      }
    });

    /* ---------- boot ---------- */
    (async function init(){
      if(token){
        try { var r = await api('/api/me'); me = r.user; return enterApp(); }
        catch(e){ localStorage.removeItem('chat_token'); token=''; }
      }
      show('authScreen'); $('email').focus();
    })();
  </script>
</body>
</html>`;

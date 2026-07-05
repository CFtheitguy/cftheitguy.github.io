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
      if (p === "/manifest.webmanifest") return manifestResponse();
      if (p === "/sw.js") return swResponse();
      if (p.startsWith("/api/")) {
        return cors(env, await handleApi(request, env, ctx, url, p, method));
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
async function handleApi(request, env, ctx, url, p, method) {
  await ensureSchema(env);

  // ---- Public (no token) ----
  if (p === "/api/auth/request" && method === "POST") return authRequest(request, env);
  if (p === "/api/auth/verify" && method === "POST") return authVerify(request, env);
  if (p === "/api/config" && method === "GET") return getConfig(env);
  if (method === "GET") {
    const fm = p.match(/^\/api\/files\/(\d+)$/);
    if (fm) return serveFile(request, env, url, Number(fm[1]));
    if (p === "/api/blob") return serveBlob(env, url);
  }

  // ---- Authenticated ----
  const claims = await authClaims(request, env);
  if (!claims) return json({ error: "Unauthorized" }, 401);
  const email = claims.email;

  if (p === "/api/me" && method === "GET") return getMe(env, email);
  if (p === "/api/me" && method === "POST") return updateMe(request, env, email);
  if (p === "/api/me/avatar" && method === "POST") return uploadAvatar(request, env, email);
  if (p === "/api/directory" && method === "GET") return directory(env, email);
  if (p === "/api/dm" && method === "POST") return openDm(request, env, email);
  if (p === "/api/push/key" && method === "GET") return pushKey(env);
  if (p === "/api/push/subscribe" && method === "POST") return subscribePush(request, env, email);
  if (p === "/api/push/unsubscribe" && method === "POST") return unsubscribePush(request, env, email);

  // Cloudflare Realtime: SFU proxy (keeps the app secret server-side) + signaling
  if (p === "/api/calls/sfu/sessions/new" && method === "POST") return sfuProxy(request, env, "/sessions/new");
  { const cm = p.match(/^\/api\/calls\/sfu\/sessions\/([A-Za-z0-9._-]+)\/tracks\/new$/); if (cm && method === "POST") return sfuProxy(request, env, "/sessions/" + cm[1] + "/tracks/new"); }
  { const cm = p.match(/^\/api\/calls\/sfu\/sessions\/([A-Za-z0-9._-]+)\/renegotiate$/); if (cm && method === "PUT") return sfuProxy(request, env, "/sessions/" + cm[1] + "/renegotiate"); }
  { const cm = p.match(/^\/api\/calls\/sfu\/sessions\/([A-Za-z0-9._-]+)\/tracks\/close$/); if (cm && method === "PUT") return sfuProxy(request, env, "/sessions/" + cm[1] + "/tracks/close"); }
  { const cm = p.match(/^\/api\/calls\/([A-Za-z0-9_-]+)\/(join|state|leave)$/); if (cm && method === "POST") return callSignal(request, env, email, cm[1], cm[2]); }
  if (p === "/api/calls/status" && method === "GET") return callStatus(env);

  if (p === "/api/groups" && method === "GET") return listGroups(env, email);
  if (p === "/api/groups" && method === "POST") return createGroup(request, env, email);

  let m;
  if ((m = p.match(/^\/api\/groups\/(\d+)\/messages\/(\d+)\/thread$/))) {
    if (method === "GET") return getThread(env, email, Number(m[1]), Number(m[2]), url);
  }
  if ((m = p.match(/^\/api\/messages\/(\d+)\/react$/))) {
    if (method === "POST") return react(request, env, email, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/messages\/(\d+)\/(edit|delete|pin)$/))) {
    if (m[2] === "edit" && method === "POST") return editMessage(request, env, email, Number(m[1]));
    if (m[2] === "delete" && method === "POST") return deleteMessage(env, email, Number(m[1]));
    if (m[2] === "pin" && method === "POST") return pinMessage(request, env, email, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/groups\/(\d+)\/(members\/remove|members|messages|badges|call|read|pins|icon)$/))) {
    const gid = Number(m[1]);
    const sub = m[2];
    if (sub === "icon" && method === "POST") return uploadGroupIcon(request, env, email, gid);
    if (sub === "members" && method === "GET") return listMembers(env, email, gid);
    if (sub === "members" && method === "POST") return addMember(request, env, email, gid);
    if (sub === "members/remove" && method === "POST") return removeMember(request, env, email, gid);
    if (sub === "messages" && method === "GET") return listMessages(env, email, gid, url);
    if (sub === "messages" && method === "POST") return postMessage(request, env, ctx, email, gid);
    if (sub === "badges" && method === "POST") return badges(request, env, email, gid);
    if (sub === "call" && method === "POST") return startCall(request, env, email, gid);
    if (sub === "read" && method === "POST") return markRead(request, env, email, gid);
    if (sub === "pins" && method === "GET") return listPins(env, email, gid);
  }

  return json({ error: "Not found" }, 404);
}

function getConfig(env) {
  return json({
    attachments_enabled: !!env.FILES,
    max_upload_mb: Number(env.MAX_UPLOAD_MB || 20),
    emoji: MAX_EMOJI,
    calls_enabled: true,
    calls_provider: callsConfigured(env) ? "cloudflare" : "jitsi",
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
  return json({ token, user: await userPublic(env, user) });
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
  return json({ user: await userPublic(env, u) });
}
async function updateMe(request, env, email) {
  const body = await readBody(request);
  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, 80) || null;
    await env.DB.prepare("UPDATE users SET name=? WHERE email=?").bind(name, email).run();
  }
  if (typeof body.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(body.accent)) {
    await env.DB.prepare("UPDATE users SET accent=? WHERE email=?").bind(body.accent, email).run();
  }
  if (typeof body.wallpaper === "string" && /^[a-z]{2,12}$/.test(body.wallpaper)) {
    await env.DB.prepare("UPDATE users SET wallpaper=? WHERE email=?").bind(body.wallpaper, email).run();
  }
  const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  return json({ user: await userPublic(env, u) });
}

/* ============================================================
 * Groups
 * ============================================================ */
async function listGroups(env, email) {
  const rows = (await env.DB.prepare(
    `SELECT g.id, g.name, g.is_dm, g.icon_key, gm.role,
            (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count,
            (SELECT body FROM messages msg WHERE msg.group_id = g.id AND msg.deleted=0 ORDER BY msg.id DESC LIMIT 1) AS last_body,
            (SELECT COALESCE(sender_name, sender_email) FROM messages msg WHERE msg.group_id = g.id AND msg.deleted=0 ORDER BY msg.id DESC LIMIT 1) AS last_sender,
            (SELECT created_at FROM messages msg WHERE msg.group_id = g.id AND msg.deleted=0 ORDER BY msg.id DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*) FROM messages msg WHERE msg.group_id = g.id AND msg.parent_id IS NULL AND msg.deleted=0 AND msg.sender_email <> ?
                     AND msg.id > COALESCE((SELECT last_read_id FROM reads r WHERE r.email = ? AND r.group_id = g.id), 0)) AS unread
       FROM group_members gm
       JOIN chat_groups g ON g.id = gm.group_id
      WHERE gm.email = ?
      ORDER BY (last_at IS NULL), last_at DESC, g.id DESC`
  ).bind(email, email, email).all()).results || [];
  for (const g of rows) {
    g.is_dm = !!g.is_dm;
    if (g.is_dm) {
      const other = await env.DB.prepare(
        "SELECT gm.email, u.name, u.avatar_key FROM group_members gm LEFT JOIN users u ON u.email=gm.email WHERE gm.group_id=? AND gm.email<>? LIMIT 1"
      ).bind(g.id, email).first();
      if (other) { g.name = other.name || other.email; g.other_email = other.email; g.avatar_url = other.avatar_key ? await signedBlobUrl(env, other.avatar_key) : null; }
    } else if (g.icon_key) {
      g.icon_url = await signedBlobUrl(env, g.icon_key);
    }
    delete g.icon_key;
  }
  return json({ groups: rows });
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
  const rows = (await env.DB.prepare(
    `SELECT gm.email, gm.role, u.name, u.avatar_key
       FROM group_members gm
       LEFT JOIN users u ON u.email = gm.email
      WHERE gm.group_id = ?
      ORDER BY (gm.role = 'admin') DESC, COALESCE(u.name, gm.email) ASC`
  ).bind(gid).all()).results || [];
  for (const m of rows) { m.avatar_url = m.avatar_key ? await signedBlobUrl(env, m.avatar_key) : null; delete m.avatar_key; }
  return json({ members: rows });
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
      "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE group_id=? AND parent_id IS NULL AND id>? ORDER BY id ASC LIMIT 200"
    ).bind(gid, after).all()).results || [];
  } else {
    rows = ((await env.DB.prepare(
      "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE group_id=? AND parent_id IS NULL ORDER BY id DESC LIMIT 100"
    ).bind(gid).all()).results || []).reverse();
  }
  await enrich(env, email, rows);
  return json({ messages: rows });
}

async function getThread(env, email, gid, mid, url) {
  await requireMember(env, gid, email);
  const parent = await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at, group_id FROM messages WHERE id=? AND group_id=?"
  ).bind(mid, gid).first();
  if (!parent) return json({ error: "Thread not found." }, 404);

  const after = Number(url.searchParams.get("after") || 0) || 0;
  const replies = (await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE parent_id=? AND id>? ORDER BY id ASC LIMIT 500"
  ).bind(mid, after).all()).results || [];
  await enrich(env, email, replies);

  let p = null;
  if (after === 0) { [p] = await enrich(env, email, [parent]); }
  return json({ parent: p, messages: replies });
}

async function postMessage(request, env, ctx, email, gid) {
  await requireMember(env, gid, email);

  const ct = request.headers.get("content-type") || "";
  let body = "";
  let parentId = null;
  let files = [];
  let mentions = [];
  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    body = String(fd.get("body") || "").trim();
    parentId = fd.get("parent_id") ? Number(fd.get("parent_id")) : null;
    mentions = parseMentions(fd.get("mentions"));
    for (const f of fd.getAll("files")) {
      if (f && typeof f === "object" && typeof f.arrayBuffer === "function") files.push(f);
    }
  } else {
    const j = await readBody(request);
    body = String(j.body || "").trim();
    parentId = j.parent_id ? Number(j.parent_id) : null;
    mentions = parseMentions(j.mentions);
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

  for (const mEmail of mentions) {
    const mem = await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id=? AND email=?").bind(gid, mEmail).first();
    if (mem) await env.DB.prepare("INSERT INTO mentions (message_id, group_id, email) VALUES (?,?,?)").bind(id, gid, mEmail).run();
  }

  const row = await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE id=?"
  ).bind(id).first();
  const [enriched] = await enrich(env, email, [row]);

  // Push notifications to the other members (fire-and-forget; the service
  // worker suppresses the OS banner when the app is focused).
  const notify = notifyForMessage(env, gid, email, name, body, id, mentions).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notify);

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
  if (!isEmoji(emoji)) return json({ error: "Invalid reaction." }, 400);

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

  const mn = await env.DB.prepare("SELECT m.message_id, m.email, u.name FROM mentions m LEFT JOIN users u ON u.email=m.email WHERE m.message_id IN (" + ph + ")").bind(...ids).all();
  const mmap = {};
  for (const r of mn.results || []) { (mmap[r.message_id] = mmap[r.message_id] || []).push({ email: r.email, name: r.name || null }); }

  const senders = [...new Set(rows.map((r) => r.sender_email))];
  const avmap = {};
  if (senders.length) {
    const aph = senders.map(() => "?").join(",");
    const av = await env.DB.prepare("SELECT email, avatar_key FROM users WHERE email IN (" + aph + ")").bind(...senders).all();
    for (const u of av.results || []) { if (u.avatar_key) avmap[u.email] = await signedBlobUrl(env, u.avatar_key); }
  }

  for (const r of rows) {
    r.reply_count = cmap[r.id] || 0;
    r.edited = !!r.edited_at;
    r.pinned = !!r.pinned;
    r.mentions = mmap[r.id] || [];
    r.sender_avatar = avmap[r.sender_email] || null;
    if (r.deleted) {
      r.deleted = true; r.body = null; r.reactions = []; r.attachments = []; r.meta = null; r.pinned = false;
      continue;
    }
    r.deleted = false;
    r.reactions = rmap[r.id] ? Object.values(rmap[r.id]) : [];
    r.attachments = amap[r.id] || [];
    if (r.meta && typeof r.meta === "string") { try { r.meta = JSON.parse(r.meta); } catch (_) { r.meta = null; } }
  }
  return rows;
}

/* ============================================================
 * Edit / delete (author-only) + read markers
 * ============================================================ */
async function editMessage(request, env, email, mid) {
  const msg = await env.DB.prepare("SELECT id, group_id, sender_email, deleted FROM messages WHERE id=?").bind(mid).first();
  if (!msg) return json({ error: "Message not found." }, 404);
  await requireMember(env, msg.group_id, email);
  if (msg.sender_email !== email) return json({ error: "You can only edit your own messages." }, 403);
  if (msg.deleted) return json({ error: "That message was deleted." }, 400);
  const body = await readBody(request);
  const text = String(body.body || "").trim();
  if (!text) return json({ error: "Message can't be empty." }, 400);
  if (text.length > 4000) return json({ error: "Message is too long." }, 400);
  await env.DB.prepare("UPDATE messages SET body=?, edited_at=datetime('now') WHERE id=?").bind(text, mid).run();
  const row = await env.DB.prepare("SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE id=?").bind(mid).first();
  const [enriched] = await enrich(env, email, [row]);
  return json({ message: enriched });
}

async function deleteMessage(env, email, mid) {
  const msg = await env.DB.prepare("SELECT id, group_id, sender_email FROM messages WHERE id=?").bind(mid).first();
  if (!msg) return json({ error: "Message not found." }, 404);
  await requireMember(env, msg.group_id, email);
  // Authorization: you can only delete a message you wrote.
  if (msg.sender_email !== email) return json({ error: "You can only delete your own messages." }, 403);
  const atts = await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id=?").bind(mid).all();
  if (env.FILES) { for (const a of atts.results || []) { try { await env.FILES.delete(a.r2_key); } catch (_) {} } }
  await env.DB.prepare("DELETE FROM attachments WHERE message_id=?").bind(mid).run();
  await env.DB.prepare("DELETE FROM reactions WHERE message_id=?").bind(mid).run();
  await env.DB.prepare("UPDATE messages SET deleted=1, body='' WHERE id=?").bind(mid).run();
  return json({ ok: true, id: mid });
}

async function markRead(request, env, email, gid) {
  await requireMember(env, gid, email);
  const body = await readBody(request);
  const lastId = Number(body.last_id || 0) || 0;
  await env.DB.prepare(
    "INSERT INTO reads (email, group_id, last_read_id) VALUES (?,?,?) ON CONFLICT(email, group_id) DO UPDATE SET last_read_id=MAX(last_read_id, excluded.last_read_id)"
  ).bind(email, gid, lastId).run();
  return json({ ok: true });
}

// A message a group member may pin/unpin (any member; Slack-style).
async function pinMessage(request, env, email, mid) {
  const msg = await env.DB.prepare("SELECT id, group_id, deleted FROM messages WHERE id=?").bind(mid).first();
  if (!msg) return json({ error: "Message not found." }, 404);
  await requireMember(env, msg.group_id, email);
  if (msg.deleted) return json({ error: "That message was deleted." }, 400);
  const body = await readBody(request);
  const pin = body.pin === true || body.pin === "true" || body.pin === 1 || body.pin === "1";
  await env.DB.prepare("UPDATE messages SET pinned=? WHERE id=?").bind(pin ? 1 : 0, mid).run();
  return json({ ok: true, id: mid, pinned: pin });
}

async function listPins(env, email, gid) {
  await requireMember(env, gid, email);
  const rows = (await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE group_id=? AND pinned=1 AND deleted=0 ORDER BY id DESC LIMIT 50"
  ).bind(gid).all()).results || [];
  await enrich(env, email, rows);
  return json({ pins: rows });
}

function parseMentions(v) {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { v = []; } }
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) { const e = normEmail(x); if (validEmail(e) && out.indexOf(e) < 0) out.push(e); }
  return out.slice(0, 20);
}

/* ============================================================
 * Calls (Jitsi today; swap the provider later for Cloudflare Realtime)
 * ============================================================ */
async function startCall(request, env, email, gid) {
  await requireMember(env, gid, email);
  const b = await readBody(request);
  const mode = b.mode === "audio" ? "audio" : "video";
  const room = "linear-" + gid + "-" + randToken(10);
  const provider = callsConfigured(env) ? "cloudflare" : "jitsi";
  const u = await env.DB.prepare("SELECT name FROM users WHERE email=?").bind(email).first();
  const name = u && u.name ? u.name : null;
  let token = null;
  if (provider === "jitsi" && env.JITSI_JWT_SECRET) {
    const payload = { iss: "jitsi", sub: "linear-chat", aud: "jitsi", room, email, name, moderator: true };
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = btoa(JSON.stringify(payload));
    const sig = await signHS256(header + "." + body, env.JITSI_JWT_SECRET);
    token = header + "." + body + "." + sig;
  }
  const meta = JSON.stringify({ provider, room, domain: env.JITSI_DOMAIN || "meet.jit.si", mode, by: email, token });
  const label = mode === "audio" ? "Voice call started" : "Video call started";
  const res = await env.DB
    .prepare("INSERT INTO messages (group_id, sender_email, sender_name, body, kind, meta) VALUES (?,?,?,?, 'call', ?)")
    .bind(gid, email, name, label, meta).run();
  const row = await env.DB.prepare(
    "SELECT id, parent_id, sender_email, sender_name, body, kind, meta, deleted, edited_at, pinned, created_at FROM messages WHERE id=?"
  ).bind(res.meta.last_row_id).first();
  const [enriched] = await enrich(env, email, [row]);
  return json({ message: enriched });
}
async function signHS256(data, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function randToken(n) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (let i = 0; i < n; i++) s += a[r[i] % a.length];
  return s;
}

/* ============================================================
 * Cloudflare Realtime — SFU proxy + room signaling (D1-polled)
 * ============================================================ */
function callsConfigured(env) { return !!(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET); }

// Transparent proxy to the Realtime SFU. The browser never sees the app secret;
// it POSTs SDP to us, we forward with the Bearer token and return the answer.
async function sfuProxy(request, env, path) {
  if (!callsConfigured(env)) return json({ error: "Calling isn't configured yet (set REALTIME_APP_ID and REALTIME_APP_SECRET)." }, 503);
  const url = "https://rtc.live.cloudflare.com/v1/apps/" + env.REALTIME_APP_ID + path;
  const init = { method: request.method, headers: { Authorization: "Bearer " + env.REALTIME_APP_SECRET } };
  if (request.method !== "GET" && request.method !== "HEAD") { init.body = await request.text(); init.headers["Content-Type"] = "application/json"; }
  let res;
  try { res = await fetch(url, init); }
  catch (_) { return json({ error: "Call service unreachable." }, 502); }
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}

function safeJsonParse(s, fallback) { try { return JSON.parse(s || ""); } catch (_) { return fallback; } }

// Quick health check for the Realtime credentials: are the vars set, and does
// the SFU actually accept them? Never exposes the secret. Lets the app show a
// clear "not configured / wrong key" message instead of a mystery failure.
async function callStatus(env) {
  if (!callsConfigured(env)) return json({ configured: false, ok: false });
  try {
    const res = await fetch("https://rtc.live.cloudflare.com/v1/apps/" + env.REALTIME_APP_ID + "/sessions/new", {
      method: "POST", headers: { Authorization: "Bearer " + env.REALTIME_APP_SECRET, "Content-Type": "application/json" }, body: "{}",
    });
    if (res.ok) return json({ configured: true, ok: true });
    const detail = (await res.text()).slice(0, 200);
    return json({ configured: true, ok: false, status: res.status, detail });
  } catch (e) { return json({ configured: true, ok: false, error: String((e && e.message) || e) }); }
}

// Room presence: join / heartbeat+state / leave, all returning the live roster.
// Media is realtime via the SFU; this only tracks who's present + their tracks.
async function callSignal(request, env, email, room, action) {
  const rm = room.match(/^linear-(\d+)-/);
  if (!rm) return json({ error: "Unknown call room." }, 400);
  await requireMember(env, Number(rm[1]), email);
  const now = Date.now();

  if (action === "leave") {
    await env.DB.prepare("DELETE FROM call_participants WHERE room=? AND email=?").bind(room, email).run();
    return json({ ok: true });
  }

  const b = await readBody(request);
  const u = await env.DB.prepare("SELECT name FROM users WHERE email=?").bind(email).first();
  const name = (u && u.name) || (b.name ? String(b.name).slice(0, 80) : email);
  const sessionId = b.sessionId ? String(b.sessionId).slice(0, 300) : null;
  const tracks = JSON.stringify(Array.isArray(b.tracks) ? b.tracks.slice(0, 8) : []).slice(0, 2000);
  const muted = b.muted ? 1 : 0;
  const videoOff = b.videoOff ? 1 : 0;

  if (action === "join") {
    await env.DB.prepare(
      "INSERT INTO call_participants (room,email,name,session_id,tracks,muted,video_off,joined_at,last_seen) VALUES (?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(room,email) DO UPDATE SET name=excluded.name, session_id=excluded.session_id, tracks=excluded.tracks, muted=excluded.muted, video_off=excluded.video_off, last_seen=excluded.last_seen"
    ).bind(room, email, name, sessionId, tracks, muted, videoOff, now, now).run();
  } else {
    await env.DB.prepare(
      "UPDATE call_participants SET session_id=COALESCE(?, session_id), tracks=?, muted=?, video_off=?, last_seen=? WHERE room=? AND email=?"
    ).bind(sessionId, tracks, muted, videoOff, now, room, email).run();
  }

  // GC anyone who stopped heartbeating (left / crashed), then return who's live.
  await env.DB.prepare("DELETE FROM call_participants WHERE last_seen < ?").bind(now - 30000).run();
  const rows = (await env.DB.prepare(
    "SELECT email,name,session_id,tracks,muted,video_off FROM call_participants WHERE room=? AND last_seen >= ?"
  ).bind(room, now - 15000).all()).results || [];
  const participants = rows.map((r) => ({ email: r.email, name: r.name, sessionId: r.session_id, tracks: safeJsonParse(r.tracks, []), muted: !!r.muted, videoOff: !!r.video_off, self: r.email === email }));
  return json({ self: { email, name }, participants });
}

/* ============================================================
 * Attachments: signed URLs + R2 serving
 * ============================================================ */
async function signedFileUrl(env, id) {
  const exp = Date.now() + 24 * 3600 * 1000;
  const sig = await hmacSign(env, "file:" + id + ":" + exp);
  return "/api/files/" + id + "?e=" + exp + "&t=" + sig;
}
async function serveFile(request, env, url, id) {
  const exp = Number(url.searchParams.get("e") || 0);
  const t = url.searchParams.get("t") || "";
  if (!exp || exp < Date.now()) return new Response("Link expired", { status: 403 });
  const good = await hmacSign(env, "file:" + id + ":" + exp);
  if (!timingSafeEqual(t, good)) return new Response("Bad signature", { status: 403 });
  if (!env.FILES) return new Response("Not configured", { status: 404 });

  const row = await env.DB.prepare("SELECT r2_key, filename, content_type FROM attachments WHERE id=?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });

  const type = row.content_type || "application/octet-stream";
  const inline = /^(image|audio|video)\//.test(type) || type === "application/pdf";

  const h = new Headers();
  h.set("Content-Type", type);
  h.set("Content-Disposition", (inline ? "inline" : "attachment") + '; filename="' + String(row.filename || "file").replace(/"/g, "") + '"');
  h.set("Cache-Control", "private, max-age=86400");
  h.set("Accept-Ranges", "bytes");

  // Total size (head() is cheap — no body download).
  const meta = await env.FILES.head(row.r2_key);
  if (!meta) return new Response("Not found", { status: 404 });
  const size = meta.size;

  // HTTP Range: iOS Safari REQUIRES a 206 Partial Content reply to play
  // <audio>/<video>. Parse the range ourselves and ask R2 for an explicit byte
  // window ({ range: { offset, length } }) — the canonical, reliable form — so
  // we never depend on R2 parsing the header. (This is why iPad showed a
  // spinner / "--:--" while a PC, which just downloads the whole file, played.)
  const rangeHeader = request && request.headers.get("Range");
  const mm = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (mm) {
    let start, end;
    if (mm[1] === "" && mm[2] !== "") { const n = Math.min(size, Number(mm[2])); start = size - n; end = size - 1; }
    else if (mm[1] !== "") { start = Number(mm[1]); end = mm[2] === "" ? size - 1 : Math.min(size - 1, Number(mm[2])); }
    if (start === undefined || isNaN(start) || start < 0 || start >= size || end < start) {
      h.set("Content-Range", "bytes */" + size);
      return new Response("Range Not Satisfiable", { status: 416, headers: h });
    }
    const length = end - start + 1;
    const part = await env.FILES.get(row.r2_key, { range: { offset: start, length } });
    if (part && part.body) {
      h.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
      h.set("Content-Length", String(length));
      return new Response(part.body, { status: 206, headers: h });
    }
  }

  const full = await env.FILES.get(row.r2_key);
  if (!full) return new Response("Not found", { status: 404 });
  h.set("Content-Length", String(size));
  return new Response(full.body, { status: 200, headers: h });
}

/* ============================================================
 * Avatars / group icons: signed blob URLs (arbitrary R2 keys) + uploads
 * ============================================================ */
async function signedBlobUrl(env, key) {
  if (!key) return null;
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const sig = await hmacSign(env, "blob:" + key + ":" + exp);
  return "/api/blob?k=" + encodeURIComponent(key) + "&e=" + exp + "&t=" + sig;
}
async function serveBlob(env, url) {
  const key = url.searchParams.get("k") || "";
  const exp = Number(url.searchParams.get("e") || 0);
  const t = url.searchParams.get("t") || "";
  if (!key || !exp || exp < Date.now()) return new Response("Link expired", { status: 403 });
  const good = await hmacSign(env, "blob:" + key + ":" + exp);
  if (!timingSafeEqual(t, good)) return new Response("Bad signature", { status: 403 });
  if (!env.FILES) return new Response("Not configured", { status: 404 });
  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg";
  return new Response(obj.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
}
async function readImageUpload(request, env) {
  if (!env.FILES) { const e = new Error("Image storage isn't enabled (bind R2 as FILES)."); e.status = 400; throw e; }
  const fd = await request.formData();
  const f = fd.get("file");
  if (!f || typeof f.arrayBuffer !== "function") { const e = new Error("No image uploaded."); e.status = 400; throw e; }
  if (!/^image\//.test(f.type || "")) { const e = new Error("Please upload an image."); e.status = 400; throw e; }
  if (f.size > 5 * 1024 * 1024) { const e = new Error("Image too large (max 5 MB)."); e.status = 400; throw e; }
  return f;
}
async function uploadAvatar(request, env, email) {
  const f = await readImageUpload(request, env);
  const key = "avatar/" + (await sha256Hex(email)).slice(0, 16) + "-" + crypto.randomUUID();
  await env.FILES.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
  await env.DB.prepare("UPDATE users SET avatar_key=? WHERE email=?").bind(key, email).run();
  const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  return json({ user: await userPublic(env, u) });
}
async function uploadGroupIcon(request, env, email, gid) {
  const me = await requireMember(env, gid, email);
  if (me.role !== "admin") return json({ error: "Only the group admin can set the icon." }, 403);
  const f = await readImageUpload(request, env);
  const key = "icon/g" + gid + "-" + crypto.randomUUID();
  await env.FILES.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
  await env.DB.prepare("UPDATE chat_groups SET icon_key=? WHERE id=?").bind(key, gid).run();
  return json({ ok: true, icon: await signedBlobUrl(env, key) });
}

/* ============================================================
 * Direct messages (1:1) + directory
 * ============================================================ */
function dmKey(a, b) { return [normEmail(a), normEmail(b)].sort().join("|"); }
async function directory(env, email) {
  // People you can DM = anyone you share a group with (excluding yourself).
  const rows = await env.DB.prepare(
    `SELECT DISTINCT gm.email, u.name, u.avatar_key
       FROM group_members gm
       LEFT JOIN users u ON u.email = gm.email
      WHERE gm.email <> ?
        AND gm.group_id IN (SELECT group_id FROM group_members WHERE email = ?)
      ORDER BY COALESCE(u.name, gm.email) ASC`
  ).bind(email, email).all();
  const people = [];
  for (const r of rows.results || []) {
    people.push({ email: r.email, name: r.name || null, avatar_url: r.avatar_key ? await signedBlobUrl(env, r.avatar_key) : null });
  }
  return json({ people });
}
async function openDm(request, env, email) {
  const body = await readBody(request);
  const other = normEmail(body.email);
  if (!validEmail(other) || other === email) return json({ error: "Pick a valid person to message." }, 400);
  const target = await env.DB.prepare("SELECT email FROM users WHERE email=?").bind(other).first();
  if (!target) return json({ error: "That person hasn't joined Linear Chat yet." }, 404);

  const key = dmKey(email, other);
  let g = await env.DB.prepare("SELECT id FROM chat_groups WHERE is_dm=1 AND dm_key=?").bind(key).first();
  if (!g) {
    const res = await env.DB.prepare("INSERT INTO chat_groups (name, created_by, is_dm, dm_key) VALUES ('', ?, 1, ?)").bind(email, key).run();
    const gid = res.meta.last_row_id;
    await env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, email, role) VALUES (?,?, 'member')").bind(gid, email).run();
    await env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, email, role) VALUES (?,?, 'member')").bind(gid, other).run();
    g = { id: gid };
  }
  const u = await env.DB.prepare("SELECT name, avatar_key FROM users WHERE email=?").bind(other).first();
  return json({ group: { id: g.id, is_dm: true, role: "member", member_count: 2, name: (u && u.name) || other, other_email: other, avatar_url: u && u.avatar_key ? await signedBlobUrl(env, u.avatar_key) : null } });
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
function publicUser(u) { return { email: u.email, name: u.name || null, is_admin: !!u.is_admin, accent: u.accent || null, wallpaper: u.wallpaper || null }; }
async function userPublic(env, u) { const pu = publicUser(u); pu.avatar_url = u.avatar_key ? await signedBlobUrl(env, u.avatar_key) : null; return pu; }
function isEmoji(s) { return typeof s === "string" && s.length > 0 && s.length <= 24 && !/\s/.test(s) && /\p{Extended_Pictographic}/u.test(s); }

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
// PWA: web app manifest so Linear Chat can be installed to a home screen.
function manifestResponse() {
  const icon = "https://cftheitguy.github.io/assets/logo.png";
  const m = {
    name: "Linear Chat", short_name: "Linear Chat", start_url: "/", scope: "/",
    display: "standalone", background_color: "#f3f4f6", theme_color: "#111827",
    icons: [
      { src: icon, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon, sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
  return new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/manifest+json" } });
}
// Minimal service worker: network passthrough (makes the app installable without
// caching stale versions — every load still comes from the Worker).
function swResponse() {
  const sw = [
    "var ICON = 'https://cftheitguy.github.io/assets/logo.png';",
    "self.addEventListener('install', function(e){ self.skipWaiting(); });",
    "self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });",
    // NOTE: intentionally NO 'fetch' handler. On iOS Safari a service worker
    // with ANY fetch listener (even an empty pass-through) breaks HTTP Range
    // requests for <audio>/<video> — which made voice notes never play on iPad
    // even with server-side Range support. Omitting it lets iOS load media
    // straight from the network. (Push handlers below are unaffected.)
    // Show an OS notification for an incoming push — unless the app is already
    // open and focused, in which case we just nudge the page instead.
    "self.addEventListener('push', function(event){",
    "  var data = {}; try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }",
    "  var title = data.title || 'Linear Chat';",
    "  var options = { body: data.body || '', tag: data.tag || 'linear-chat', renotify: true, icon: ICON, badge: ICON, data: { url: data.url || '/', gid: (data.gid != null ? data.gid : null) } };",
    "  event.waitUntil((async function(){",
    "    var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });",
    "    var focused = list.some(function(c){ return c.focused || c.visibilityState === 'visible'; });",
    "    if (focused) { list.forEach(function(c){ c.postMessage({ type: 'push', data: data }); }); return; }",
    "    await self.registration.showNotification(title, options);",
    "  })());",
    "});",
    // Clicking a notification focuses the app (and jumps to the group) or opens it.
    "self.addEventListener('notificationclick', function(event){",
    "  event.notification.close();",
    "  var d = event.notification.data || {}; var gid = d.gid != null ? d.gid : null;",
    "  event.waitUntil((async function(){",
    "    var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });",
    "    for (var i = 0; i < list.length; i++) { var c = list[i];",
    "      if ('focus' in c) { try { await c.focus(); } catch (e) {} if (gid != null) c.postMessage({ type: 'open-group', gid: gid }); return; } }",
    "    if (self.clients.openWindow) return self.clients.openWindow(gid != null ? ('/?g=' + gid) : (d.url || '/'));",
    "  })());",
    "});",
  ].join("\n");
  return new Response(sw, { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8" } });
}

/* ============================================================
 * Schema self-heal + migrations
 * ============================================================ */
let SCHEMA_READY = false;
async function ensureSchema(env) {
  if (SCHEMA_READY) return;
  if (!env.DB) { const e = new Error("Database not configured — bind a D1 database as DB."); e.status = 500; throw e; }
  const base = [
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, accent TEXT, avatar_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email)",
    "CREATE TABLE IF NOT EXISTS chat_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_by TEXT NOT NULL, is_dm INTEGER NOT NULL DEFAULT 0, dm_key TEXT, icon_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(group_id, email))",
    "CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_members_email ON group_members(email)",
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, parent_id INTEGER, sender_email TEXT NOT NULL, sender_name TEXT, body TEXT, kind TEXT NOT NULL DEFAULT 'text', meta TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_at TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id)",
  ];
  for (const s of base) await env.DB.prepare(s).run();

  // Migrations for older databases (ignore "duplicate column" errors).
  const migrations = [
    "ALTER TABLE messages ADD COLUMN parent_id INTEGER",
    "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'",
    "ALTER TABLE messages ADD COLUMN meta TEXT",
    "ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN edited_at TEXT",
    "ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN accent TEXT",
    "ALTER TABLE users ADD COLUMN avatar_key TEXT",
    "ALTER TABLE chat_groups ADD COLUMN is_dm INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE chat_groups ADD COLUMN dm_key TEXT",
    "ALTER TABLE chat_groups ADD COLUMN icon_key TEXT",
    "ALTER TABLE users ADD COLUMN wallpaper TEXT",
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
    "CREATE TABLE IF NOT EXISTS reads (email TEXT NOT NULL, group_id INTEGER NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (email, group_id))",
    "CREATE TABLE IF NOT EXISTS mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, group_id INTEGER NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_mentions_msg ON mentions(message_id)",
    "CREATE INDEX IF NOT EXISTS idx_mentions_email ON mentions(email)",
    // Web Push: per-device subscriptions + a tiny key/value store for the
    // auto-generated VAPID keypair (so it stays stable across deploys).
    "CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_email)",
    "CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT)",
    // Cloudflare Realtime calling: live roster of who's in a call room, plus
    // each participant's SFU session id + published track names (for signaling).
    "CREATE TABLE IF NOT EXISTS call_participants (room TEXT NOT NULL, email TEXT NOT NULL, name TEXT, session_id TEXT, tracks TEXT, muted INTEGER NOT NULL DEFAULT 0, video_off INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (room, email))",
    "CREATE INDEX IF NOT EXISTS idx_call_room ON call_participants(room)",
  ];
  for (const s of more) await env.DB.prepare(s).run();

  SCHEMA_READY = true;
}

/* ============================================================
 * Web Push — VAPID auth (RFC 8292) + payload encryption (RFC 8291),
 * implemented with WebCrypto only (no libraries). Everything below the
 * START marker is self-contained enough to unit-test in Node.
 * ==PUSH-CRYPTO-START==
 * ============================================================ */
const PUSH_ENC = new TextEncoder();

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  const b = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

function vapidSubject(env) {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  const from = env.EMAIL_FROM || "";
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim();
  if (addr && /@/.test(addr)) return "mailto:" + addr;
  return "mailto:admin@linearit.co";
}

// VAPID keypair: explicit env keys win; otherwise generate once and persist in
// app_kv so the applicationServerKey (which the browser ties subscriptions to)
// stays stable across deploys. Cached in memory for the isolate's lifetime.
let VAPID_CACHE = null;
async function getVapid(env) {
  if (VAPID_CACHE) return VAPID_CACHE;
  const subject = vapidSubject(env);
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || X || Y
    const jwk = { kty: "EC", crv: "P-256", x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY };
    VAPID_CACHE = { publicKey: env.VAPID_PUBLIC_KEY, jwk, subject };
    return VAPID_CACHE;
  }
  const row = await env.DB.prepare("SELECT v FROM app_kv WHERE k='vapid'").first();
  if (row && row.v) {
    try { const saved = JSON.parse(row.v); VAPID_CACHE = { publicKey: saved.publicKey, jwk: saved.jwk, subject }; return VAPID_CACHE; } catch (_) { /* regenerate */ }
  }
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); // 65 bytes
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicKey = bytesToB64url(rawPub);
  await env.DB.prepare("INSERT OR REPLACE INTO app_kv (k, v) VALUES ('vapid', ?)").bind(JSON.stringify({ publicKey, jwk })).run();
  VAPID_CACHE = { publicKey, jwk, subject };
  return VAPID_CACHE;
}

async function vapidAuthHeader(env, endpoint) {
  const vapid = await getVapid(env);
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(PUSH_ENC.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(PUSH_ENC.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const signingInput = header + "." + payload;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: vapid.jwk.x, y: vapid.jwk.y, d: vapid.jwk.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, PUSH_ENC.encode(signingInput))); // JOSE r||s
  const jwt = signingInput + "." + bytesToB64url(sig);
  return { Authorization: "vapid t=" + jwt + ", k=" + vapid.publicKey };
}

// RFC 8291 aes128gcm. `injected` (as_private JWK, as_public, salt) is only used
// by the tests to reproduce the RFC's fixed vectors; production is random.
async function encryptPush(plaintextBytes, p256dhB64, authB64, injected) {
  const uaPublic = b64urlToBytes(p256dhB64);   // 65 bytes
  const authSecret = b64urlToBytes(authB64);   // 16 bytes
  let asPriv, asPubRaw;
  if (injected) {
    asPriv = await crypto.subtle.importKey("jwk", injected.asPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPubRaw = b64urlToBytes(injected.asPublic);
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPriv = kp.privateKey;
    asPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const salt = injected && injected.salt ? b64urlToBytes(injected.salt) : crypto.getRandomValues(new Uint8Array(16));

  // key derivation (RFC 8291 §3.4)
  const prkKey = await hmacSha256(authSecret, shared);
  const keyInfo = concatBytes(PUSH_ENC.encode("WebPush: info\0"), uaPublic, asPubRaw);
  const ikm = await hmacSha256(prkKey, concatBytes(keyInfo, new Uint8Array([1])));
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concatBytes(PUSH_ENC.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concatBytes(PUSH_ENC.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  // one record: plaintext || 0x02 (last-record padding delimiter)
  const record = concatBytes(plaintextBytes, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, record));

  // aes128gcm header: salt(16) | rs(4, =4096) | idlen(1) | keyid(as_public,65)
  const header = concatBytes(salt, new Uint8Array([0, 0, 0x10, 0x00]), new Uint8Array([asPubRaw.length]), asPubRaw);
  return concatBytes(header, ct);
}

async function sendOnePush(env, sub, payloadObj, urgency) {
  let body;
  try { body = await encryptPush(PUSH_ENC.encode(JSON.stringify(payloadObj)), sub.p256dh, sub.auth); }
  catch (_) { return 400; }
  const auth = await vapidAuthHeader(env, sub.endpoint);
  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: "POST",
      headers: Object.assign({}, auth, {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
        "Urgency": urgency || "normal",
      }),
      body,
    });
  } catch (_) { return 0; }
  if (res.status === 404 || res.status === 410) {
    try { await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(sub.endpoint).run(); } catch (_) {}
  }
  return res.status;
}

async function notifyPush(env, emails, payloadObj, urgency) {
  if (!emails || !emails.length) return;
  try { await getVapid(env); } catch (_) { return; }
  const ph = emails.map(() => "?").join(",");
  const subs = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_email IN (" + ph + ")").bind(...emails).all();
  await Promise.allSettled((subs.results || []).map((s) => sendOnePush(env, s, payloadObj, urgency)));
}

function pushSnippet(body) {
  let s = String(body || "").replace(/\s+/g, " ").trim();
  if (!s) return "Sent an attachment";
  return s.length > 140 ? s.slice(0, 139) + "…" : s;
}

async function notifyForMessage(env, gid, senderEmail, senderName, body, msgId, mentions) {
  const g = await env.DB.prepare("SELECT id, name, is_dm FROM chat_groups WHERE id=?").bind(gid).first();
  if (!g) return;
  const membersRes = await env.DB.prepare("SELECT email FROM group_members WHERE group_id=? AND email<>?").bind(gid, senderEmail).all();
  const recipients = (membersRes.results || []).map((r) => r.email);
  if (!recipients.length) return;

  const sender = senderName || senderEmail;
  const snippet = pushSnippet(body);
  const isDm = !!g.is_dm;
  const tag = "g" + gid;
  const url = "/?g=" + gid;
  const mentionSet = new Set((mentions || []).map((e) => String(e).toLowerCase()));
  const mentioned = recipients.filter((e) => mentionSet.has(e.toLowerCase()));
  const others = recipients.filter((e) => !mentionSet.has(e.toLowerCase()));

  if (mentioned.length) {
    await notifyPush(env, mentioned, { title: sender + " mentioned you" + (isDm ? "" : " in " + g.name), body: snippet, tag, url, gid, kind: "mention" }, "high");
  }
  if (others.length) {
    await notifyPush(env, others, { title: isDm ? sender : g.name, body: (isDm ? "" : sender + ": ") + snippet, tag, url, gid, kind: isDm ? "dm" : "message" }, isDm ? "high" : "normal");
  }
}
/* ==PUSH-CRYPTO-END== */

async function pushKey(env) {
  try { const v = await getVapid(env); return json({ enabled: true, key: v.publicKey }); }
  catch (_) { return json({ enabled: false }); }
}
async function subscribePush(request, env, email) {
  const b = await readBody(request);
  const endpoint = String(b.endpoint || "");
  const keys = b.keys || {};
  const p256dh = String(keys.p256dh || "");
  const auth = String(keys.auth || "");
  if (!endpoint || !p256dh || !auth) return json({ error: "Invalid subscription." }, 400);
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (user_email, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET user_email=excluded.user_email, p256dh=excluded.p256dh, auth=excluded.auth"
  ).bind(email, endpoint, p256dh, auth, Date.now()).run();
  return json({ ok: true });
}
async function unsubscribePush(request, env, email) {
  const b = await readBody(request);
  const endpoint = String(b.endpoint || "");
  if (endpoint) await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_email=?").bind(endpoint, email).run();
  return json({ ok: true });
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
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#111827">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Linear Chat">
  <link rel="apple-touch-icon" href="https://cftheitguy.github.io/assets/logo.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { theme: { extend: { colors: { brand: 'var(--accent)' } } } };</script>
  <style>
    :root { --accent: #111827; }   /* per-user accent color (overridden at boot) */
    html, body { height: 100%; }
    .msgs::-webkit-scrollbar, .thr::-webkit-scrollbar { width: 8px; }
    .msgs::-webkit-scrollbar-thumb, .thr::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 8px; }
    /* React/Reply buttons: hidden until you hover (desktop) or tap (touch) the message */
    .msg-actions { opacity: 0; pointer-events: none; transition: opacity .12s; }
    @media (hover: hover) { .group:hover .msg-actions { opacity: 1; pointer-events: auto; } }
    .msg-actions.show { opacity: 1; pointer-events: auto; }

    /* ---- chat wallpapers (applied to #messages) ---- */
    .wp-none   { background: #f3f4f6; }
    .wp-slate  { background: #e7ebf1; }
    .wp-mint   { background: #e6f4ea; }
    .wp-purple { background: linear-gradient(135deg,#c9b7f2,#e7b5d6); background-size: cover; background-repeat: no-repeat; }
    .wp-blue   { background: linear-gradient(135deg,#a8c8ea,#d0e4f6); background-size: cover; background-repeat: no-repeat; }
    .wp-teal   { background: linear-gradient(135deg,#9bdaca,#c1e9d9); background-size: cover; background-repeat: no-repeat; }
    .wp-peach  { background: linear-gradient(135deg,#f5c8a3,#f8dbc6); background-size: cover; background-repeat: no-repeat; }
    .wp-doodle { background-color: #efe7dd; background-repeat: repeat; background-size: 84px 84px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='84' height='84' viewBox='0 0 84 84'%3E%3Cg fill='none' stroke='%23b9a992' stroke-opacity='0.30' stroke-width='1.6'%3E%3Ccircle cx='20' cy='20' r='7'/%3E%3Cpath d='M54 14h12M60 8v12'/%3E%3Cpath d='M10 60q9-11 18 0'/%3E%3Crect x='54' y='52' width='15' height='15' rx='3'/%3E%3Cpath d='M20 44c3-4 7-4 10 0'/%3E%3C/g%3E%3C/svg%3E"); }
    .wp-dark { background-color: #0b141a; background-repeat: repeat; background-size: 84px 84px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='84' height='84' viewBox='0 0 84 84'%3E%3Cg fill='none' stroke='%23ffffff' stroke-opacity='0.05' stroke-width='1.6'%3E%3Ccircle cx='20' cy='20' r='7'/%3E%3Cpath d='M54 14h12M60 8v12'/%3E%3Cpath d='M10 60q9-11 18 0'/%3E%3Crect x='54' y='52' width='15' height='15' rx='3'/%3E%3C/g%3E%3C/svg%3E"); }

    /* ---- date separators (Today / Yesterday / date) ---- */
    .date-sep { display: flex; justify-content: center; margin: 12px 0 8px; }
    .date-sep span { background: rgba(255,255,255,0.9); color: #374151; font-size: 11px; font-weight: 600; padding: 3px 12px; border-radius: 9999px; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
    .wp-dark .date-sep span { background: rgba(0,0,0,0.55); color: #e5e7eb; }
    /* swatch previews in the account modal share the same wp-* backgrounds */
    .wp-sw { width: 2.75rem; height: 2.75rem; border-radius: 0.6rem; }

    /* ---- collapsible sidebar (desktop/tablet) ---- */
    .sb-expand { display: none; }
    @media (min-width: 768px) {
      #appShell.sb-collapsed #sidebar { display: none; }
      #appShell.sb-collapsed .sb-collapse { display: none; }
      #appShell.sb-collapsed .sb-expand { display: inline-flex; }
    }
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
          class="w-full rounded-lg border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand">
        <button id="sendBtn" onclick="sendCode()"
          class="w-full bg-brand text-white rounded-lg py-2.5 text-sm font-medium hover:opacity-90 transition">Send code</button>
      </div>
      <div id="codeStep" class="mt-5 space-y-3 hidden">
        <p class="text-sm text-gray-500">Enter the 6-digit code we sent to
          <span id="codeEmailLabel" class="font-medium text-gray-700"></span>.</p>
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"
          class="w-full rounded-lg border px-3 py-2.5 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-brand">
        <p id="devNote" class="hidden text-xs text-amber-600 bg-amber-50 rounded px-2 py-1"></p>
        <button id="verifyBtn" onclick="verifyCode()"
          class="w-full bg-brand text-white rounded-lg py-2.5 text-sm font-medium hover:opacity-90 transition">Verify &amp; sign in</button>
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
    <div id="appShell" class="flex h-screen overflow-hidden">

      <!-- sidebar -->
      <aside id="sidebar" class="w-full md:w-80 bg-white border-r flex flex-col">
        <div class="px-4 py-3 border-b flex items-center justify-between">
          <img src="https://cftheitguy.github.io/assets/logo.png" alt="Linear IT" class="h-6">
          <button onclick="openMe()" class="text-xs text-gray-500 hover:text-black underline">Account</button>
        </div>
        <div class="px-4 py-3 border-b flex items-center justify-between">
          <h2 class="font-semibold text-sm">Groups</h2>
          <button id="newGroupBtn" onclick="createGroup()" class="hidden text-sm bg-brand text-white rounded-lg px-3 py-1.5 hover:opacity-90">+ New</button>
        </div>
        <div class="flex-1 overflow-y-auto p-2">
          <div id="groupList" class="space-y-1"></div>
          <div class="px-1 pt-4 pb-1 flex items-center justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">Direct Messages</h3>
            <button onclick="openDmPicker()" class="text-xs text-brand hover:underline font-medium">+ New</button>
          </div>
          <div id="dmList" class="space-y-1"></div>
        </div>
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
            <button onclick="backToList()" class="md:hidden text-gray-500 hover:text-black text-xl leading-none">&larr;</button>
            <button class="sb-collapse hidden md:inline-flex text-gray-400 hover:text-black text-xl leading-none" onclick="toggleSidebar()" title="Hide sidebar (full-screen chat)">&laquo;</button>
            <button class="sb-expand text-gray-400 hover:text-black text-xl leading-none" onclick="toggleSidebar()" title="Show sidebar">&#9776;</button>
            <div class="min-w-0 flex-1">
              <h2 id="chatTitle" class="font-semibold truncate"></h2>
              <p id="chatSub" class="text-xs text-gray-400 truncate"></p>
            </div>
            <button id="callAudioBtn" onclick="startCall('audio')" class="hidden text-xl leading-none hover:opacity-70" title="Start voice call">📞</button>
            <button id="callVideoBtn" onclick="startCall('video')" class="hidden text-xl leading-none hover:opacity-70" title="Start video call">🎥</button>
            <button id="pinsBtn" onclick="openPins()" class="hidden text-sm text-gray-500 hover:text-black" title="Pinned messages">📌 <span id="pinsCount"></span></button>
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
            <button type="button" onclick="openEmojiInsert(event)" title="Emoji"
              class="text-gray-500 hover:text-black text-xl leading-none px-1">😀</button>
            <textarea id="composerInput" rows="1" placeholder="Type a message…" onkeydown="composerKey(event)"
              class="flex-1 resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand max-h-32"></textarea>
            <button type="submit" class="bg-brand text-white rounded-xl px-4 py-2 text-sm font-medium hover:opacity-90">Send</button>
          </form>
          <!-- voice-note recording bar (shown while recording) -->
          <div id="recBar" class="hidden bg-white border-t p-3 flex items-center gap-3">
            <span class="flex items-center gap-2 text-red-600 font-medium">
              <span class="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse"></span>
              <span id="recTime">0:00</span>
            </span>
            <span class="text-sm text-gray-400 flex-1">Recording voice note…</span>
            <button type="button" onclick="cancelRec()" class="text-sm text-gray-500 hover:text-black">Cancel</button>
            <button type="button" onclick="stopRecAndSend()" class="bg-brand text-white rounded-xl px-4 py-2 text-sm font-medium hover:opacity-90">Send</button>
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
            class="flex-1 resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand max-h-32"></textarea>
          <button type="submit" class="bg-brand text-white rounded-xl px-4 py-2 text-sm font-medium hover:opacity-90">Reply</button>
        </form>
      </aside>
    </div>
  </div>

  <!-- emoji picker popover -->
  <div id="emojiPicker" class="hidden fixed z-40 bg-white border rounded-xl shadow-lg p-1 flex gap-1"></div>

  <!-- @mention autocomplete -->
  <div id="mentionBox" class="hidden fixed z-40 bg-white border rounded-xl shadow-lg py-1 w-64 max-h-56 overflow-y-auto"></div>

  <!-- pinned messages modal -->
  <div id="pinsModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30">
    <div class="bg-white rounded-2xl shadow-lg w-full max-w-lg p-5 max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">📌 Pinned messages</h3>
        <button onclick="closeModal('pinsModal')" class="text-gray-400 hover:text-black text-xl leading-none">&times;</button>
      </div>
      <div id="pinsList" class="overflow-y-auto space-y-2"></div>
    </div>
  </div>

  <!-- members modal -->
  <div id="membersModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30">
    <div class="bg-white rounded-2xl shadow-lg w-full max-w-md p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Members</h3>
        <button onclick="closeModal('membersModal')" class="text-gray-400 hover:text-black text-xl leading-none">&times;</button>
      </div>
      <div id="addMemberRow" class="hidden mb-3">
        <div class="flex gap-2">
          <input id="newMemberEmail" type="email" placeholder="teammate@company.com"
            class="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand">
          <button onclick="addMember()" class="bg-brand text-white rounded-lg px-3 py-2 text-sm hover:opacity-90">Add</button>
        </div>
        <input id="iconInput" type="file" accept="image/*" class="hidden" onchange="uploadGroupIcon(this)">
        <button onclick="document.getElementById('iconInput').click()" class="text-xs text-brand hover:underline font-medium mt-2">Change group photo</button>
      </div>
      <div id="memberList" class="max-h-72 overflow-y-auto"></div>
    </div>
  </div>

  <!-- new direct message picker -->
  <div id="dmModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30">
    <div class="bg-white rounded-2xl shadow-lg w-full max-w-sm p-5 max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">New message</h3>
        <button onclick="closeModal('dmModal')" class="text-gray-400 hover:text-black text-xl leading-none">&times;</button>
      </div>
      <input id="dmSearch" oninput="filterDmList()" placeholder="Search people…"
        class="w-full rounded-lg border px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-brand">
      <div id="dmPeople" class="overflow-y-auto"></div>
    </div>
  </div>

  <!-- account modal -->
  <div id="meModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30">
    <div class="bg-white rounded-2xl shadow-lg w-full max-w-sm p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">Your account</h3>
        <button onclick="closeModal('meModal')" class="text-gray-400 hover:text-black text-xl leading-none">&times;</button>
      </div>
      <div class="flex items-center gap-3 mb-4">
        <div id="meAvatar"></div>
        <div>
          <input id="avatarInput" type="file" accept="image/*" class="hidden" onchange="uploadAvatar(this)">
          <button onclick="document.getElementById('avatarInput').click()" class="text-sm text-brand hover:underline font-medium">Change photo</button>
        </div>
      </div>
      <label class="text-xs text-gray-500">Email</label>
      <p id="meEmail" class="text-sm font-medium mb-3"></p>
      <label class="text-xs text-gray-500">Display name</label>
      <div class="flex gap-2 mt-1">
        <input id="meName" type="text" placeholder="Your name"
          class="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand">
        <button onclick="saveName()" class="bg-brand text-white rounded-lg px-3 py-2 text-sm hover:opacity-90">Save</button>
      </div>
      <label class="text-xs text-gray-500 block mt-4">App color</label>
      <div id="accentSwatches" class="flex flex-wrap gap-2 mt-1"></div>

      <label class="text-xs text-gray-500 block mt-4">Chat background</label>
      <div id="wallSwatches" class="flex flex-wrap gap-2 mt-1"></div>

      <label class="text-xs text-gray-500 block mt-4">Notifications</label>
      <div class="flex items-center justify-between gap-3 mt-1">
        <span id="pushStatus" class="text-xs text-gray-500 flex-1">Get notified about new messages.</span>
        <button id="pushBtn" type="button" onclick="enablePush()" class="bg-brand text-white rounded-lg px-3 py-1.5 text-sm hover:opacity-90 shrink-0">Turn on</button>
      </div>
    </div>
  </div>

  <!-- call overlay -->
  <div id="callOverlay" class="hidden fixed inset-0 z-50 bg-gray-900 flex flex-col">
    <div class="flex items-center justify-between px-4 py-2 bg-black/40 text-white shrink-0">
      <span id="callTitle" class="text-sm font-medium">Call</span>
      <span id="callStatusMsg" class="text-xs text-gray-300"></span>
      <button onclick="endCall()" class="bg-red-600 hover:bg-red-700 text-white rounded-lg px-3 py-1.5 text-sm font-medium">Leave call</button>
    </div>
    <!-- Jitsi (legacy/fallback) mounts here -->
    <div id="callFrame" class="flex-1 min-h-0"></div>
    <!-- Cloudflare Realtime video tiles -->
    <div id="callTiles" class="hidden flex-1 min-h-0 overflow-auto p-3 grid gap-3 content-center justify-center"></div>
    <div id="callControls" class="hidden items-center justify-center gap-4 py-4 bg-black/40 shrink-0"></div>
  </div>

  <script>
    var API = '';
    var token = localStorage.getItem('chat_token') || '';
    var me = null, config = { emoji: ['👍','❤️','😂','🎉','✅'], attachments_enabled: false, max_upload_mb: 20, calls_enabled: true, jitsi_domain: 'meet.jit.si' };
    var jitsiApi = null;
    var groups = [], active = null;
    var sidebarCollapsed = localStorage.getItem('chat_sidebar_collapsed') === '1';
    var lastMsgId = 0, poll = null, pollTick = 0, lastMainDay = '';
    var pendingEmail = '';
    var msgModel = {};            // id -> message object (latest)
    var topIds = {};              // top-level message ids rendered in main list
    var activeThread = null, threadLastId = 0, threadPoll = null;
    var mainFiles = { files: [], input: null, chips: 'fileChips' };
    var threadFiles = { files: [], input: null, chips: 'threadChips' };
    var groupMembers = [];          // members of the active group (for @mention autocomplete)
    var pendingMentions = {};       // token -> email, for the message being composed

    function $(id){ return document.getElementById(id); }
    function show(id){ $(id).classList.remove('hidden'); }
    function hide(id){ $(id).classList.add('hidden'); }
    function closeModal(id){ hide(id); }
    function ce(tag, cls){ var e=document.createElement(tag); if(cls) e.className=cls; return e; }
    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function initials(name){ name=String(name||'?').trim(); if(!name) return '?'; var p=name.split(/\\s+/); if(p.length>=2 && p[0] && p[1]) return (p[0][0]+p[1][0]).toUpperCase(); return name.slice(0,2).toUpperCase(); }
    function avatarColor(s){ var h=0; s=String(s||'?'); for(var i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } return 'hsl(' + (h%360) + ',52%,45%)'; }
    function avatarEl(name, url, sizeCls){
      sizeCls = sizeCls || 'w-8 h-8';
      if(url){ var img=ce('img', sizeCls+' rounded-full object-cover border shrink-0'); img.src=url; img.alt=name||''; img.loading='lazy'; return img; }
      var d=ce('div', sizeCls+' rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0'); d.style.background=avatarColor(name); d.textContent=initials(name);
      return d;
    }
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
      if(me && me.accent){ applyAccent(me.accent); }   // theme follows the user across devices
      applyWallpaper(currentWallpaper());               // chat background follows the user too
      applySidebar();
      if(me.is_admin){ show('newGroupBtn'); } else { hide('newGroupBtn'); }
      if(!isMobile()){ $('chatPane').classList.remove('hidden'); }
      try { config = await api('/api/config'); } catch(e){}
      if(!config.attachments_enabled){ $('attachBtn').classList.add('hidden'); }
      // Voice notes need R2 (attachments) + a browser that can record.
      if(!config.attachments_enabled || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || !window.MediaRecorder){ $('recBtn').classList.add('hidden'); }
      await loadGroups();
      var mg = (location.search.match(/[?&]g=(\\d+)/) || [])[1];
      if(mg){ openGroupById(Number(mg)); }
      ensurePushSynced();   // keep this device's subscription fresh if already granted
    }

    async function loadGroups(){
      try { var r = await api('/api/groups'); groups = r.groups || []; renderGroups(); }
      catch(e){ if(e.status===401) return logout(); }
    }
    function groupRow(g){
      var b = ce('button', 'w-full text-left px-2 py-2 rounded-lg hover:bg-gray-100 transition flex items-center gap-2 ' + (active && active.id===g.id ? 'bg-gray-100' : ''));
      b.appendChild(avatarEl(g.name, g.is_dm ? g.avatar_url : g.icon_url, 'w-9 h-9'));
      var unread = (!active || active.id!==g.id) ? (g.unread||0) : 0;
      var sub = g.last_body ? esc((g.last_sender ? g.last_sender + ': ' : '') + g.last_body)
                            : (g.is_dm ? esc(g.other_email||'') : (g.member_count + ' member' + (g.member_count===1 ? '' : 's')));
      var mid = ce('div','min-w-0 flex-1');
      mid.innerHTML = '<div class="flex items-center justify-between gap-2">' +
          '<span class="' + (unread>0?'font-bold':'font-medium') + ' truncate">' + esc(g.name) + '</span>' +
          (unread>0 ? '<span class="text-[10px] font-semibold bg-brand text-white rounded-full text-center px-1.5 py-0.5 shrink-0">' + (unread>99?'99+':unread) + '</span>'
                    : (!g.is_dm && g.role==='admin' ? '<span class="text-[10px] uppercase tracking-wide bg-gray-200 text-gray-600 rounded px-1.5 py-0.5 shrink-0">admin</span>' : '')) +
        '</div><div class="text-xs ' + (unread>0?'text-gray-600 font-medium':'text-gray-400') + ' truncate mt-0.5">' + sub + '</div>';
      b.appendChild(mid);
      b.onclick = function(){ openGroup(g); };
      return b;
    }
    function renderGroups(){
      var gEl = $('groupList'), dEl = $('dmList');
      gEl.innerHTML = ''; dEl.innerHTML = '';
      var gs = groups.filter(function(g){ return !g.is_dm; });
      var dms = groups.filter(function(g){ return g.is_dm; });
      if(!gs.length){ gEl.innerHTML = '<p class="text-xs text-gray-400 px-2 py-3">' + (me.is_admin ? 'No groups yet — tap <b>+ New</b>.' : 'No groups yet.') + '</p>'; }
      else { gs.forEach(function(g){ gEl.appendChild(groupRow(g)); }); }
      if(!dms.length){ dEl.innerHTML = '<p class="text-xs text-gray-400 px-2 py-2">No direct messages yet.</p>'; }
      else { dms.forEach(function(g){ dEl.appendChild(groupRow(g)); }); }
    }

    /* ---------- one group ---------- */
    async function openGroup(g){
      active = g; lastMsgId = 0; msgModel = {}; topIds = {}; pendingMentions = {}; groupMembers = []; lastMainDay = '';
      closeThread(); hideMentionBox();
      applyWallpaper(currentWallpaper());
      renderGroups();
      hide('chatEmpty'); show('chatActive');
      applySidebar();
      $('chatTitle').textContent = g.name;
      $('chatSub').textContent = g.is_dm ? 'Direct message' : ((g.role==='admin' ? 'Admin · ' : '') + g.member_count + ' member' + (g.member_count===1 ? '' : 's'));
      if(!g.is_dm && g.role==='admin'){ show('membersBtn'); } else { hide('membersBtn'); }
      if(config.calls_enabled){ show('callAudioBtn'); show('callVideoBtn'); }
      show('pinsBtn');
      $('messages').innerHTML = '<p class="text-center text-sm text-gray-400 py-6">Loading…</p>';
      if(isMobile()){ hide('sidebar'); $('chatPane').classList.remove('hidden'); $('chatPane').classList.add('flex'); }
      try { groupMembers = (await api('/api/groups/' + g.id + '/members')).members || []; } catch(e){}
      await loadMessages(true);
      refreshPinsCount();
      startPoll();
      $('composerInput').focus();
    }
    function backToList(){
      stopPoll(); active = null; closeThread(); renderGroups();
      if(isMobile()){ show('sidebar'); $('chatPane').classList.add('hidden'); $('chatPane').classList.remove('flex'); }
      applySidebar();
    }
    // Collapse the sidebar for a full-screen conversation (desktop/tablet only;
    // phones already go full-screen on open). Only applied while a chat is open
    // so you can never get stranded with no way back to the list.
    function applySidebar(){
      var shell = $('appShell'); if(!shell) return;
      shell.classList.toggle('sb-collapsed', !!(sidebarCollapsed && active && !isMobile()));
    }
    function toggleSidebar(){
      sidebarCollapsed = !sidebarCollapsed;
      localStorage.setItem('chat_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
      applySidebar();
    }

    async function loadMessages(forceScroll){
      if(!active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/messages' + (lastMsgId ? ('?after=' + lastMsgId) : ''));
        var msgs = r.messages || [];
        var box = $('messages');
        var nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 100;
        if(lastMsgId===0){ box.innerHTML=''; lastMainDay=''; }
        msgs.forEach(function(m){ appendTop(m); });
        if(msgs.length){ lastMsgId = msgs[msgs.length-1].id; markRead(active.id, lastMsgId); }
        if(forceScroll || nearBottom){ scrollBottom(); }
      } catch(e){ if(e.status===403 || e.status===401){ stopPoll(); } }
    }
    function markRead(gid, lastId){ if(!lastId) return; api('/api/groups/' + gid + '/read', { method:'POST', body: JSON.stringify({ last_id: lastId }) }).catch(function(){}); }
    function appendTop(m){
      msgModel[m.id]=m; topIds[m.id]=true;
      var dk = dayKey(parseMsgDate(m.created_at));
      if(dk && dk !== lastMainDay){ $('messages').appendChild(makeDateSep(dayLabel(parseMsgDate(m.created_at)))); lastMainDay = dk; }
      $('messages').appendChild(renderMessage(m, {}));
    }
    function scrollBottom(){ var b=$('messages'); b.scrollTop = b.scrollHeight; }

    function fmtTime(s){
      if(!s) return '';
      var d = new Date((s.indexOf('Z')<0 && s.indexOf('T')<0) ? s.replace(' ','T') + 'Z' : s);
      if(isNaN(d)) return '';
      return d.toLocaleString(undefined, { hour:'2-digit', minute:'2-digit' });
    }
    function fmtSize(b){ if(!b) return ''; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(0)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
    function parseMsgDate(s){ if(!s) return null; var d = new Date((s.indexOf('Z')<0 && s.indexOf('T')<0) ? s.replace(' ','T')+'Z' : s); return isNaN(d) ? null : d; }
    function dayKey(d){ return d ? (d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()) : ''; }
    function dayLabel(d){
      if(!d) return '';
      var now = new Date(); var yes = new Date(now.getTime() - 86400000);
      if(dayKey(d)===dayKey(now)) return 'Today';
      if(dayKey(d)===dayKey(yes)) return 'Yesterday';
      var opts = { month:'short', day:'numeric' }; if(d.getFullYear()!==now.getFullYear()){ opts.year='numeric'; }
      return d.toLocaleDateString(undefined, opts);
    }
    function makeDateSep(label){ var w = ce('div','date-sep'); var sp = ce('span'); sp.textContent = label; w.appendChild(sp); return w; }

    /* ---------- render a message ---------- */
    function renderMessage(m, opts){
      opts = opts || {};
      msgModel[m.id] = m;
      if(m.kind==='call' && m.meta){ var cc = renderCallCard(m); cc.setAttribute('data-mid', m.id); return cc; }
      var mine = me && m.sender_email === me.email;
      var row = ce('div', 'group flex items-end gap-2 ' + (mine ? 'justify-end' : 'justify-start'));
      row.setAttribute('data-mid', m.id);

      if(m.deleted){
        var dc = ce('div','max-w-[80%]');
        var db = ce('div','rounded-2xl px-3 py-2 text-xs italic text-gray-400 border border-dashed'); db.textContent = '🚫 This message was deleted';
        dc.appendChild(db); row.appendChild(dc); return row;
      }

      var isDm = active && active.is_dm;
      if(!mine && !isDm){ row.appendChild(avatarEl(m.sender_name || m.sender_email, m.sender_avatar, 'w-8 h-8')); }
      var col = ce('div', 'max-w-[80%] flex flex-col ' + (mine ? 'items-end' : 'items-start'));
      var mentionsMe = me && (m.mentions || []).some(function(x){ return x.email === me.email; });
      var bubble = ce('div', 'rounded-2xl ' + (mine ? 'rounded-br-md ' : 'rounded-bl-md ') + 'px-3 py-2 shadow-sm ' + (mine ? 'bg-brand text-white' : 'bg-white text-gray-900 border') + (mentionsMe ? ' ring-2 ring-blue-400' : ''));
      if(!mine && !isDm){ var who = ce('div','text-xs font-semibold mb-0.5'); who.style.color = avatarColor(m.sender_name || m.sender_email); who.textContent = m.sender_name || m.sender_email; bubble.appendChild(who); }
      if(m.body){ var b = ce('div','text-sm whitespace-pre-wrap break-words'); renderRich(b, m.body, mine, m.mentions); bubble.appendChild(b); }
      if(m.attachments && m.attachments.length){ bubble.appendChild(renderAttachments(m.attachments, mine)); }
      if(m.pinned){ var pin = ce('div','text-[10px] mt-1 ' + (mine ? 'text-gray-300' : 'text-gray-400')); pin.textContent = '📌 pinned'; bubble.appendChild(pin); }
      var time = ce('div','text-[10px] mt-1 ' + (mine ? 'text-gray-300 text-right' : 'text-gray-400')); time.textContent = fmtTime(m.created_at) + (m.edited ? ' · edited' : '') + (mine ? ' ✓' : ''); bubble.appendChild(time);
      col.appendChild(bubble);
      if(m.body){ var emb = buildEmbeds(m.body); if(emb) col.appendChild(emb); }

      var rx = ce('div','flex flex-wrap gap-1 mt-1'); rx.setAttribute('data-rx', m.id); col.appendChild(rx); renderReactions(rx, m);

      var meta = ce('div','flex items-center gap-3 mt-0.5 text-xs text-gray-400');
      // React + Reply + (own) Edit/Delete live in .msg-actions (revealed on hover/tap).
      var actions = ce('div','msg-actions flex items-center gap-3');
      var reactBtn = ce('button','hover:text-black'); reactBtn.textContent='🙂'; reactBtn.title='React'; reactBtn.onclick=function(ev){ openEmojiPicker(ev, m.id); }; actions.appendChild(reactBtn);
      if(!opts.inThread){
        var replyBtn = ce('button','hover:text-black'); replyBtn.textContent='↩ Reply'; replyBtn.onclick=function(){ openThread(m.id); }; actions.appendChild(replyBtn);
      }
      var pinBtn = ce('button','hover:text-black'); pinBtn.textContent = m.pinned ? '📌 Unpin' : '📌 Pin'; pinBtn.onclick=function(){ togglePin(m.id, !m.pinned, row, opts); }; actions.appendChild(pinBtn);
      if(mine){
        var editBtn = ce('button','hover:text-black'); editBtn.textContent='Edit'; editBtn.onclick=function(){ editMsg(m.id, row, opts); }; actions.appendChild(editBtn);
        var delBtn = ce('button','text-red-500 hover:text-red-600'); delBtn.textContent='Delete'; delBtn.onclick=function(){ deleteMsg(m.id, row, opts); }; actions.appendChild(delBtn);
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

    async function editMsg(id, row, opts){
      var cur = (msgModel[id] && msgModel[id].body) || '';
      var nv = prompt('Edit message:', cur);
      if(nv===null) return; nv = nv.trim(); if(!nv) return;
      try {
        var r = await api('/api/messages/' + id + '/edit', { method:'POST', body: JSON.stringify({ body: nv }) });
        if(r.message){ msgModel[id] = r.message; row.replaceWith(renderMessage(r.message, opts)); }
      } catch(e){ alert(e.message); }
    }
    async function deleteMsg(id, row, opts){
      if(!confirm('Delete this message? (You can only delete messages you sent.)')) return;
      try {
        await api('/api/messages/' + id + '/delete', { method:'POST' });
        var m = msgModel[id] || { id: id, sender_email: (me && me.email) };
        m.deleted = true; m.body = null; m.attachments = []; m.reactions = []; msgModel[id] = m;
        row.replaceWith(renderMessage(m, opts));
      } catch(e){ alert(e.message); }
    }
    async function togglePin(id, pin, row, opts){
      try {
        await api('/api/messages/' + id + '/pin', { method:'POST', body: JSON.stringify({ pin: pin }) });
        if(msgModel[id]){ msgModel[id].pinned = pin; row.replaceWith(renderMessage(msgModel[id], opts)); }
        refreshPinsCount();
      } catch(e){ alert(e.message); }
    }

    function attLink(a, mine, icon){
      var link = ce('a','flex items-center gap-2 rounded-lg border px-3 py-2 ' + (mine ? 'bg-white/10 border-white/20 text-white' : 'bg-gray-50 hover:bg-gray-100'));
      link.href=a.url; link.setAttribute('download', a.filename); link.target='_blank';
      link.innerHTML = '<span>' + (icon || '📎') + '</span><span class="text-sm truncate">' + esc(a.filename) + '</span><span class="text-xs opacity-60 shrink-0">' + fmtSize(a.size) + '</span>';
      return link;
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
          // If the browser can't decode this codec (e.g. a WebM/Opus note on
          // iOS Safari), swap the dead player for a tap-to-download link.
          au.onerror = function(){ if(au.parentNode){ au.parentNode.replaceChild(attLink(a, mine, '🎧'), au); } };
          wrap.appendChild(au);
        } else if(/^video\\//.test(a.content_type || '')){
          var vid = ce('video','w-64 sm:w-80 rounded-lg border'); vid.src=a.url; vid.controls=true; vid.preload='metadata';
          vid.onerror = function(){ if(vid.parentNode){ vid.parentNode.replaceChild(attLink(a, mine, '🎬'), vid); } };
          wrap.appendChild(vid);
        } else {
          wrap.appendChild(attLink(a, mine, '📎'));
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

    /* ---------- markdown + @mentions (manual scan; no regex, to stay template-safe) ---------- */
    var BT = String.fromCharCode(96);   // backtick, without a literal one in this file
    function renderRich(container, text, mine, mentions){
      var tokens = (mentions || []).map(function(x){ return '@' + (x.name || String(x.email||'').split('@')[0]); }).filter(function(t){ return t.length > 1; });
      // fenced code blocks first (triple-backtick delimited)
      var fence = BT + BT + BT, s = String(text), idx = 0;
      while(true){
        var a = s.indexOf(fence, idx);
        if(a < 0){ renderInline(container, s.slice(idx), mine, tokens); break; }
        var b = s.indexOf(fence, a + 3);
        if(b < 0){ renderInline(container, s.slice(idx), mine, tokens); break; }
        if(a > idx) renderInline(container, s.slice(idx, a), mine, tokens);
        var code = s.slice(a + 3, b).replace(/^\\n/, '').replace(/\\n$/, '');
        var pre = ce('pre', (mine ? 'bg-black/30 text-white ' : 'bg-gray-900 text-gray-100 ') + 'rounded-lg p-2 overflow-x-auto text-xs my-1 whitespace-pre');
        var cd = ce('code',''); cd.textContent = code; pre.appendChild(cd); container.appendChild(pre);
        idx = b + 3;
      }
    }
    function renderInline(container, text, mine, tokens){
      // split out @mention tokens (literal, longest first), markdown-render the rest
      var toks = (tokens || []).slice().sort(function(x,y){ return y.length - x.length; });
      var s = String(text), i = 0, buf = '';
      function flushBuf(){ if(buf){ renderMd(container, buf, mine); buf = ''; } }
      outer: while(i < s.length){
        for(var t = 0; t < toks.length; t++){
          if(toks[t] && s.substr(i, toks[t].length) === toks[t]){
            flushBuf();
            var chip = ce('span','font-semibold ' + (mine ? 'text-blue-200' : 'text-blue-600')); chip.textContent = toks[t];
            container.appendChild(chip); i += toks[t].length; continue outer;
          }
        }
        buf += s[i]; i++;
      }
      flushBuf();
    }
    function renderMd(container, text, mine){
      var s = String(text), i = 0, buf = '';
      function flushBuf(){ if(buf){ appendBodyWithLinks(container, buf, mine); buf = ''; } }
      while(i < s.length){
        var two = s.substr(i, 2), c = s[i], e;
        if(two === '**'){ e = s.indexOf('**', i+2); if(e > i+1){ flushBuf(); var st=ce('strong',''); st.textContent = s.slice(i+2, e); container.appendChild(st); i = e+2; continue; } }
        if(two === '~~'){ e = s.indexOf('~~', i+2); if(e > i+1){ flushBuf(); var sk=ce('span','line-through'); sk.textContent = s.slice(i+2, e); container.appendChild(sk); i = e+2; continue; } }
        if(c === BT){ e = s.indexOf(BT, i+1); if(e > i){ flushBuf(); var cd=ce('code', (mine ? 'bg-black/30' : 'bg-gray-100 text-gray-800') + ' rounded px-1 py-0.5'); cd.textContent = s.slice(i+1, e); container.appendChild(cd); i = e+1; continue; } }
        if(c === '*' || c === '_'){ e = s.indexOf(c, i+1); if(e > i+1){ flushBuf(); var em=ce('em',''); em.textContent = s.slice(i+1, e); container.appendChild(em); i = e+1; continue; } }
        buf += c; i++;
      }
      flushBuf();
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
      var join = ce('button','text-sm bg-brand text-white rounded-lg px-4 py-1.5 hover:opacity-90'); join.textContent = 'Join'; join.onclick = function(){ joinCall(m.meta, active && active.id); };
      card.appendChild(join);
      row.appendChild(card);
      return row;
    }

    /* ---------- calls (Jitsi) ---------- */
    async function startCall(mode){
      if(!active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/call', { method:'POST', body: JSON.stringify({ mode: mode }) });
        if(r.message){ appendTop(r.message); scrollBottom(); lastMsgId = Math.max(lastMsgId, r.message.id); joinCall(r.message.meta, active.id); }
      } catch(e){ alert(e.message); }
    }
    function joinCall(meta, gid){
      if(!meta || !meta.room) return;
      if(meta.provider === 'cloudflare'){ startRealtimeCall(meta.room, meta.mode || 'video', gid || (active && active.id)); }
      else { startJitsi(meta.room, meta.mode || 'video', meta.token); }
    }
    function loadJitsiScript(){
      return new Promise(function(resolve, reject){
        if(window.JitsiMeetExternalAPI) return resolve();
        var s = document.createElement('script');
        s.src = 'https://' + (config.jitsi_domain || 'meet.jit.si') + '/external_api.js';
        s.onload = function(){ resolve(); }; s.onerror = function(){ reject(new Error('Could not load the call library.')); };
        document.head.appendChild(s);
      });
    }
    function startJitsi(room, mode, token){
      var domain = config.jitsi_domain || 'meet.jit.si';
      show('callOverlay');
      $('callTitle').textContent = (mode==='audio' ? '📞 Voice call' : '🎥 Video call');
      loadJitsiScript().then(function(){
        if(jitsiApi){ try { jitsiApi.dispose(); } catch(e){} jitsiApi = null; }
        $('callFrame').innerHTML = '';
        var opts = {
          roomName: room,
          parentNode: $('callFrame'),
          width: '100%', height: '100%',
          userInfo: { displayName: (me && (me.name || me.email)) || 'Guest' },
          configOverwrite: { startWithVideoMuted: (mode==='audio'), prejoinPageEnabled: false, disableDeepLinking: true },
          interfaceConfigOverwrite: { MOBILE_APP_PROMO: false }
        };
        if(token) opts.token = token;
        jitsiApi = new JitsiMeetExternalAPI(domain, opts);
        jitsiApi.addEventListener('readyToClose', endCall);
      }).catch(function(){
        // fallback: open the room in a new tab
        window.open('https://' + domain + '/' + room, '_blank');
        hide('callOverlay');
      });
    }
    function endCall(){
      if(jitsiApi){ try { jitsiApi.dispose(); } catch(e){} jitsiApi = null; }
      if(rtc){
        try { if(rtc.polling){ clearInterval(rtc.polling); } } catch(e){}
        try { if(rtc.pc){ rtc.pc.close(); } } catch(e){}
        try { if(rtc.localStream){ rtc.localStream.getTracks().forEach(function(t){ t.stop(); }); } } catch(e){}
        try { Object.keys(rtc.tiles).forEach(function(k){ var st=rtc.tiles[k].stream; if(st){ st.getTracks().forEach(function(x){ try{ x.stop(); }catch(e){} }); } }); } catch(e){}
        try { api('/api/calls/' + rtc.room + '/leave', { method:'POST', body: '{}' }).catch(function(){}); } catch(e){}
        rtc = null;
      }
      $('callFrame').innerHTML = '';
      $('callTiles').innerHTML = ''; $('callTiles').classList.add('hidden');
      $('callControls').innerHTML = ''; $('callControls').classList.add('hidden');
      $('callFrame').classList.remove('hidden');
      callSetStatus('');
      hide('callOverlay');
    }

    /* ---------- calls: Cloudflare Realtime (SFU) ----------
       Flow per participant: getUserMedia -> RTCPeerConnection -> create an SFU
       session and publish local tracks (offer/answer) -> announce to the room
       -> subscribe to everyone else's tracks (SFU sends an offer; we answer via
       renegotiate). Roster is polled from D1 (~1.5s). */
    var rtc = null;
    function callSetStatus(msg){ var el=$('callStatusMsg'); if(el){ el.textContent = msg || ''; } }
    function sfuName(kind){ return kind === 'audio' ? 'mic' : 'cam'; }
    async function sfuPost(path, body, method){
      var res = await fetch(API + path, { method: method || 'POST', headers:{ Authorization:'Bearer ' + token, 'Content-Type':'application/json' }, body: JSON.stringify(body || {}) });
      var data = {}; try { data = await res.json(); } catch(e){}
      if(!res.ok){ throw new Error((data && data.error) || ('Call service error ' + res.status)); }
      return data;
    }
    function showCallOverlay(mode){
      show('callOverlay');
      $('callTitle').textContent = (mode === 'audio' ? '📞 Voice call' : '🎥 Video call');
      $('callFrame').classList.add('hidden');
      $('callTiles').classList.remove('hidden'); $('callTiles').innerHTML = '';
      $('callControls').classList.remove('hidden'); $('callControls').innerHTML = '';
    }
    async function startRealtimeCall(room, mode, gid){
      if(rtc){ return; }
      if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ alert('This browser cannot access the microphone/camera.'); return; }
      showCallOverlay(mode);
      callSetStatus('Checking call service…');
      try {
        var stt = await api('/api/calls/status');
        if(!stt.configured){ alert('Calling is not configured on the server yet (REALTIME_APP_ID / REALTIME_APP_SECRET).'); return endCall(); }
        if(!stt.ok){ alert('The call service rejected the credentials (' + (stt.status || 'error') + '). Re-check the SFU App ID and Secret in the Worker.'); return endCall(); }
      } catch(e){}
      callSetStatus('Connecting…');
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: (mode !== 'audio') });
        rtc = { room:room, gid:gid, mode:mode, pc:null, sessionId:null, localStream:stream, tiles:{}, subscribed:{}, midOwner:{}, myTracks:[], polling:null, micOn:true, camOn:(mode !== 'audio'), negChain:Promise.resolve() };
        var pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.cloudflare.com:3478' }], bundlePolicy:'max-bundle' });
        rtc.pc = pc;
        pc.ontrack = onRtcTrack;
        pc.onconnectionstatechange = function(){ if(!rtc) return; if(pc.connectionState === 'connected'){ callSetStatus(''); } else if(pc.connectionState === 'failed'){ callSetStatus('Reconnecting…'); } };
        var pubTracks = [];
        stream.getTracks().forEach(function(track){
          var tr = pc.addTransceiver(track, { direction:'sendonly' });
          pubTracks.push({ tr:tr, trackName: sfuName(track.kind) });
          rtc.myTracks.push({ trackName: sfuName(track.kind), kind: track.kind });
        });
        await pc.setLocalDescription(await pc.createOffer());
        var sess = await sfuPost('/api/calls/sfu/sessions/new', {});
        rtc.sessionId = sess.sessionId;
        var pubRes = await sfuPost('/api/calls/sfu/sessions/' + rtc.sessionId + '/tracks/new', { sessionDescription:{ type:'offer', sdp: pc.localDescription.sdp }, tracks: pubTracks.map(function(x){ return { location:'local', mid: x.tr.mid, trackName: x.trackName }; }) });
        if(pubRes.sessionDescription){ await pc.setRemoteDescription(pubRes.sessionDescription); }
        addTile('__self__', ((me && (me.name || me.email)) || 'You'), stream, true);
        renderCallControls();
        var j = await api('/api/calls/' + room + '/join', { method:'POST', body: JSON.stringify({ name:((me && (me.name || me.email)) || ''), sessionId: rtc.sessionId, tracks: rtc.myTracks, muted: !rtc.micOn, videoOff: !rtc.camOn }) });
        applyRoster(j.participants);
        rtc.polling = setInterval(pollRoster, 1500);
      } catch(e){ alert('Could not start the call: ' + ((e && e.message) || e)); endCall(); }
    }
    async function pollRoster(){
      if(!rtc) return;
      try {
        var r = await api('/api/calls/' + rtc.room + '/state', { method:'POST', body: JSON.stringify({ sessionId: rtc.sessionId, tracks: rtc.myTracks, muted: !rtc.micOn, videoOff: !rtc.camOn }) });
        applyRoster(r.participants);
      } catch(e){}
    }
    function applyRoster(participants){
      if(!rtc || !participants){ return; }
      var present = { '__self__': true };
      participants.forEach(function(p){
        if(p.self){ return; }
        present[p.email] = true;
        if(!rtc.tiles[p.email]){ addTile(p.email, p.name, null, false); }
        updateTileState(p);
        if(!rtc.subscribed[p.email] && p.sessionId && p.tracks && p.tracks.length){
          rtc.subscribed[p.email] = true;
          var pp = p;
          rtc.negChain = rtc.negChain.then(function(){ return subscribeTo(pp); }).catch(function(){});
        }
      });
      Object.keys(rtc.tiles).forEach(function(email){
        if(email !== '__self__' && !present[email]){ removeTile(email); delete rtc.subscribed[email]; }
      });
    }
    async function subscribeTo(p){
      if(!rtc){ return; }
      var tracks = p.tracks.map(function(t){ return { location:'remote', sessionId: p.sessionId, trackName: t.trackName }; });
      var res = await sfuPost('/api/calls/sfu/sessions/' + rtc.sessionId + '/tracks/new', { tracks: tracks });
      if(res.tracks){ res.tracks.forEach(function(rt){ if(rt.mid){ rtc.midOwner[rt.mid] = { email: p.email, name: p.name }; } }); }
      if(res.requiresImmediateRenegotiation && res.sessionDescription){
        await rtc.pc.setRemoteDescription(res.sessionDescription);
        await rtc.pc.setLocalDescription(await rtc.pc.createAnswer());
        await sfuPost('/api/calls/sfu/sessions/' + rtc.sessionId + '/renegotiate', { sessionDescription:{ type:'answer', sdp: rtc.pc.localDescription.sdp } }, 'PUT');
      }
    }
    function onRtcTrack(e){
      if(!rtc){ return; }
      var mid = e.transceiver && e.transceiver.mid;
      var owner = mid && rtc.midOwner[mid] ? rtc.midOwner[mid] : null;
      if(!owner){ return; }
      var t = rtc.tiles[owner.email] || addTile(owner.email, owner.name, null, false);
      try { t.stream.addTrack(e.track); } catch(err){}
      t.video.srcObject = t.stream;
      if(e.track.kind === 'video'){ t.hasVideo = true; t.avatar.style.display = 'none'; }
      t.video.play().catch(function(){});
    }
    function addTile(key, name, stream, isSelf){
      if(rtc.tiles[key]){ return rtc.tiles[key]; }
      var tile = ce('div','relative bg-black rounded-xl overflow-hidden');
      tile.style.aspectRatio = '4 / 3'; tile.style.minWidth = '160px'; tile.style.maxWidth = '520px'; tile.style.width = '100%';
      var video = ce('video','w-full h-full object-cover bg-black'); video.autoplay = true; video.playsInline = true; video.setAttribute('playsinline',''); video.muted = !!isSelf;
      var ms = stream || new MediaStream(); video.srcObject = ms; tile.appendChild(video);
      var av = ce('div','absolute inset-0 flex items-center justify-center bg-gray-800'); av.appendChild(avatarEl(name || key, null, 'w-24 h-24 text-2xl')); av.style.display = isSelf ? 'none' : 'flex'; tile.appendChild(av);
      var label = ce('div','absolute bottom-1 left-1 text-xs text-white bg-black/50 rounded px-1.5 py-0.5 max-w-[85%] truncate'); label.textContent = (name || key) + (isSelf ? ' (you)' : ''); tile.appendChild(label);
      $('callTiles').appendChild(tile);
      rtc.tiles[key] = { el:tile, video:video, stream:ms, avatar:av, label:label, name:name, hasVideo:!!isSelf };
      layoutTiles();
      video.play().catch(function(){});
      return rtc.tiles[key];
    }
    function updateTileState(p){
      var t = rtc.tiles[p.email]; if(!t){ return; }
      if(!t.hasVideo || p.videoOff){ t.avatar.style.display = 'flex'; } else { t.avatar.style.display = 'none'; }
      t.label.textContent = (p.name || p.email) + (p.muted ? ' 🔇' : '');
    }
    function removeTile(key){
      var t = rtc.tiles[key]; if(!t){ return; }
      try { t.stream.getTracks().forEach(function(x){ try{ x.stop(); }catch(e){} }); } catch(e){}
      if(t.el && t.el.parentNode){ t.el.parentNode.removeChild(t.el); }
      delete rtc.tiles[key]; layoutTiles();
    }
    function layoutTiles(){
      var n = Object.keys(rtc.tiles).length; if(n < 1){ n = 1; }
      var cols = n <= 1 ? 1 : (n <= 4 ? 2 : (n <= 9 ? 3 : 4));
      $('callTiles').style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    }
    function ctlBtn(label, on, danger){
      var b = ce('button','rounded-full w-14 h-14 flex items-center justify-center text-2xl ' + (danger ? 'bg-red-600 text-white hover:bg-red-700' : (on ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-red-600 text-white')));
      b.textContent = label; return b;
    }
    function renderCallControls(){
      if(!rtc){ return; }
      var box = $('callControls'); box.innerHTML = '';
      var mic = ctlBtn(rtc.micOn ? '🎤' : '🔇', rtc.micOn, false); mic.title = rtc.micOn ? 'Mute' : 'Unmute'; mic.onclick = toggleMic; box.appendChild(mic);
      if(rtc.mode !== 'audio'){
        var cam = ctlBtn(rtc.camOn ? '🎥' : '📷', rtc.camOn, false); cam.title = rtc.camOn ? 'Turn camera off' : 'Turn camera on'; cam.onclick = toggleCam; box.appendChild(cam);
      }
      var leave = ctlBtn('📞', true, true); leave.title = 'Leave'; leave.onclick = endCall; box.appendChild(leave);
    }
    function toggleMic(){ if(!rtc){ return; } rtc.micOn = !rtc.micOn; rtc.localStream.getAudioTracks().forEach(function(t){ t.enabled = rtc.micOn; }); renderCallControls(); pollRoster(); }
    function toggleCam(){
      if(!rtc){ return; } rtc.camOn = !rtc.camOn;
      rtc.localStream.getVideoTracks().forEach(function(t){ t.enabled = rtc.camOn; });
      var self = rtc.tiles['__self__']; if(self){ self.avatar.style.display = rtc.camOn ? 'none' : 'flex'; }
      renderCallControls(); pollRoster();
    }

    /* ---------- @mention autocomplete ---------- */
    function onComposerInput(){
      var t = $('composerInput'); if(!t) return;
      var pos = t.selectionStart;
      var upto = t.value.slice(0, pos);
      var m = upto.match(/(^|\\s)@([^\\s@]*)$/);
      if(!m || !groupMembers.length){ hideMentionBox(); return; }
      var q = m[2].toLowerCase();
      var matches = groupMembers.filter(function(mem){
        if(me && mem.email === me.email) return false;
        return (mem.name||'').toLowerCase().indexOf(q) >= 0 || (mem.email||'').toLowerCase().indexOf(q) >= 0;
      }).slice(0, 8);
      if(!matches.length){ hideMentionBox(); return; }
      var box = $('mentionBox'); box.innerHTML = '';
      matches.forEach(function(mem){
        var b = ce('button','w-full text-left px-3 py-2 hover:bg-gray-100 block'); b.type = 'button';
        b.innerHTML = '<div class="text-sm font-medium truncate">' + esc(mem.name || mem.email) + '</div><div class="text-xs text-gray-400 truncate">' + esc(mem.email) + '</div>';
        b.onclick = function(){ insertMention(mem, m[2].length); };
        box.appendChild(b);
      });
      var rect = t.getBoundingClientRect();
      box.style.left = Math.max(8, rect.left) + 'px';
      box.style.width = Math.min(rect.width, 320) + 'px';
      box.style.top = ''; box.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
      show('mentionBox');
    }
    function hideMentionBox(){ hide('mentionBox'); }
    function insertMention(mem, partialLen){
      var t = $('composerInput'); var pos = t.selectionStart;
      var token = '@' + (mem.name || String(mem.email).split('@')[0]);
      var before = t.value.slice(0, pos - partialLen - 1);   // drop the '@' + typed partial
      var after = t.value.slice(pos);
      t.value = before + token + ' ' + after;
      pendingMentions[token] = mem.email;
      var np = (before + token + ' ').length;
      t.focus(); try { t.selectionStart = t.selectionEnd = np; } catch(_){}
      hideMentionBox();
    }

    /* ---------- pinned messages ---------- */
    async function refreshPinsCount(){
      if(!active) return;
      try {
        var r = await api('/api/groups/' + active.id + '/pins');
        var n = (r.pins || []).length;
        $('pinsCount').textContent = n ? String(n) : '';
      } catch(e){}
    }
    async function openPins(){
      if(!active) return;
      show('pinsModal');
      $('pinsList').innerHTML = '<p class="text-sm text-gray-400 py-4 text-center">Loading…</p>';
      try {
        var r = await api('/api/groups/' + active.id + '/pins');
        var list = $('pinsList'); list.innerHTML = '';
        var pins = r.pins || [];
        if(!pins.length){ list.innerHTML = '<p class="text-sm text-gray-400 py-4 text-center">No pinned messages yet.</p>'; return; }
        pins.forEach(function(m){
          var card = ce('div','border rounded-xl p-3');
          var who = ce('div','text-xs text-gray-400 mb-1'); who.textContent = (m.sender_name || m.sender_email) + ' · ' + fmtTime(m.created_at); card.appendChild(who);
          var bodyEl = ce('div','text-sm break-words'); renderRich(bodyEl, m.body || '', false, m.mentions); card.appendChild(bodyEl);
          if(m.attachments && m.attachments.length){ card.appendChild(renderAttachments(m.attachments, false)); }
          var un = ce('button','text-xs text-gray-500 hover:text-black mt-2'); un.textContent = '📌 Unpin';
          un.onclick = function(){ unpinFromModal(m.id, card); };
          card.appendChild(un);
          list.appendChild(card);
        });
      } catch(e){ $('pinsList').innerHTML = '<p class="text-sm text-red-500 py-4 text-center">' + esc(e.message) + '</p>'; }
    }
    async function unpinFromModal(id, card){
      try {
        await api('/api/messages/' + id + '/pin', { method:'POST', body: JSON.stringify({ pin: false }) });
        if(msgModel[id]){ msgModel[id].pinned = false; document.querySelectorAll('[data-mid="' + id + '"]').forEach(function(row){ row.replaceWith(renderMessage(msgModel[id], {})); }); }
        if(card) card.remove();
        refreshPinsCount();
      } catch(e){ alert(e.message); }
    }

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
    var EMOJI_SET = ['👍','👎','❤️','🔥','🎉','✅','👀','🙏','😂','😅','😊','😍','😎','🤔','🙌','👏','💪','🤝','👋','🫡','😉','😇','🥳','🤩','😮','😳','🥲','😢','😭','😡','🤯','🥵','🥶','😴','🤒','🤕','🤢','😷','🤖','👻','💀','🙈','🙉','🙊','💯','✨','⭐','🌟','💫','⚡','💥','☀️','🌙','🌈','☔','❄️','💧','🍀','🌹','🌸','🎂','🍕','🍔','🍟','🌮','🍎','🍺','☕','🍷','🥂','🎁','🏆','🥇','🎯','📌','📎','✏️','📝','📅','⏰','💡','🔒','🔑','📞','📱','💻','📷','🎥','🎧','🔊','📣','💬','✔️','❌','⚠️','❓','❗','➕','➖','💰','💵','💳','📈','📉','🚀','🛠️','⚙️','🔧','🔨','🚗','✈️','🏠','🏢','🏦','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕'];
    function openEmoji(ev, onPick){
      var pick = $('emojiPicker');
      pick.className = 'fixed z-40 bg-white border rounded-xl shadow-lg p-2 grid grid-cols-8 gap-1 overflow-y-auto';
      pick.style.width = '18rem'; pick.style.maxHeight = '16rem'; pick.innerHTML = '';
      EMOJI_SET.forEach(function(em){
        var btn = ce('button','text-xl leading-none hover:scale-125 transition'); btn.type='button'; btn.textContent = em;
        btn.onclick = function(){ onPick(em); hide('emojiPicker'); };
        pick.appendChild(btn);
      });
      var x = Math.min(ev.clientX, window.innerWidth - 300), y = Math.min(ev.clientY, window.innerHeight - 260);
      pick.style.left = Math.max(x, 8) + 'px'; pick.style.top = Math.max(y, 8) + 'px';
      show('emojiPicker');
    }
    function openEmojiPicker(ev, mid){ openEmoji(ev, function(em){ toggleReact(mid, em); }); }
    function openEmojiInsert(ev){ openEmoji(ev, function(em){ var t=$('composerInput'); var s=(t.selectionStart!=null?t.selectionStart:t.value.length), e=(t.selectionEnd!=null?t.selectionEnd:t.value.length); t.value = t.value.slice(0,s) + em + t.value.slice(e); t.focus(); try { t.selectionStart = t.selectionEnd = s + em.length; } catch(_){} }); }
    document.addEventListener('click', function(ev){
      var pick = $('emojiPicker');
      if(pick && !pick.classList.contains('hidden') && !pick.contains(ev.target) && !(ev.target.title==='React' || ev.target.title==='Emoji')){ hide('emojiPicker'); }
      var mb = $('mentionBox');
      if(mb && !mb.classList.contains('hidden') && !mb.contains(ev.target) && ev.target.id!=='composerInput'){ hideMentionBox(); }
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

    function startPoll(){ stopPoll(); pollTick=0; poll = setInterval(function(){ pollTick++; loadMessages(false); if(pollTick % 2 === 0) refreshBadges(); if(pollTick % 4 === 0) loadGroups(); }, 3000); }
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
      var ments = []; for(var tok in pendingMentions){ if(pendingMentions.hasOwnProperty(tok) && body.indexOf(tok) >= 0) ments.push(pendingMentions[tok]); }
      inp.value=''; inp.style.height='auto'; state.files=[]; renderChips(state);
      if(inputId==='composerInput'){ pendingMentions = {}; hideMentionBox(); }
      try {
        var res;
        if(files.length){
          var fd = new FormData();
          fd.append('body', body);
          if(parentId) fd.append('parent_id', String(parentId));
          if(ments.length) fd.append('mentions', JSON.stringify(ments));
          files.forEach(function(f){ fd.append('files', f); });
          res = await fetch(API + '/api/groups/' + active.id + '/messages', { method:'POST', headers:{ Authorization:'Bearer ' + token }, body: fd });
        } else {
          res = await fetch(API + '/api/groups/' + active.id + '/messages', { method:'POST', headers:{ Authorization:'Bearer ' + token, 'Content-Type':'application/json' }, body: JSON.stringify({ body: body, parent_id: parentId || null, mentions: ments }) });
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

    /* ---------- direct messages ---------- */
    var dmDirectory = [];
    async function openDmPicker(){
      show('dmModal'); $('dmSearch').value=''; $('dmPeople').innerHTML = '<p class="text-sm text-gray-400 py-3 text-center">Loading…</p>';
      try { dmDirectory = (await api('/api/directory')).people || []; renderDmPeople(dmDirectory); }
      catch(e){ $('dmPeople').innerHTML = '<p class="text-sm text-red-500 py-3 text-center">' + esc(e.message) + '</p>'; }
    }
    function renderDmPeople(people){
      var box = $('dmPeople'); box.innerHTML = '';
      if(!people.length){ box.innerHTML = '<p class="text-sm text-gray-400 py-3 text-center">No one to message yet. You can DM people you share a group with.</p>'; return; }
      people.forEach(function(p){
        var b = ce('button','w-full text-left px-2 py-2 rounded-lg hover:bg-gray-100 flex items-center gap-2');
        b.appendChild(avatarEl(p.name || p.email, p.avatar_url, 'w-8 h-8'));
        var d = ce('div','min-w-0'); d.innerHTML = '<div class="text-sm font-medium truncate">' + esc(p.name || p.email) + '</div><div class="text-xs text-gray-400 truncate">' + esc(p.email) + '</div>';
        b.appendChild(d); b.onclick = function(){ startDm(p.email); };
        box.appendChild(b);
      });
    }
    function filterDmList(){
      var q = $('dmSearch').value.toLowerCase();
      renderDmPeople(dmDirectory.filter(function(p){ return (p.name||'').toLowerCase().indexOf(q)>=0 || (p.email||'').toLowerCase().indexOf(q)>=0; }));
    }
    async function startDm(email){
      try { var r = await api('/api/dm', { method:'POST', body: JSON.stringify({ email: email }) }); closeModal('dmModal'); await loadGroups(); if(r.group) openGroup(r.group); }
      catch(e){ alert(e.message); }
    }

    /* ---------- avatar upload ---------- */
    async function uploadAvatar(input){
      var f = input.files && input.files[0]; if(!f) return; input.value='';
      if(!/^image\\//.test(f.type||'')){ alert('Please choose an image.'); return; }
      try {
        var fd = new FormData(); fd.append('file', f);
        var res = await fetch(API + '/api/me/avatar', { method:'POST', headers:{ Authorization:'Bearer ' + token }, body: fd });
        var data = {}; try { data = await res.json(); } catch(e){}
        if(!res.ok) throw new Error(data.error || 'Upload failed');
        me = data.user; renderMeAvatar(); loadGroups();
      } catch(e){ alert(e.message); }
    }
    function renderMeAvatar(){ var box=$('meAvatar'); if(!box) return; box.innerHTML=''; box.appendChild(avatarEl(me.name||me.email, me.avatar_url, 'w-16 h-16')); }
    async function uploadGroupIcon(input){
      var f = input.files && input.files[0]; if(!f || !active) return; input.value='';
      if(!/^image\\//.test(f.type||'')){ alert('Please choose an image.'); return; }
      try {
        var fd = new FormData(); fd.append('file', f);
        var res = await fetch(API + '/api/groups/' + active.id + '/icon', { method:'POST', headers:{ Authorization:'Bearer ' + token }, body: fd });
        var data = {}; try { data = await res.json(); } catch(e){}
        if(!res.ok) throw new Error(data.error || 'Upload failed');
        loadGroups();
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
          var rowEl = ce('div','flex items-center justify-between py-2 border-b last:border-0');
          var left = ce('div','flex items-center gap-2 min-w-0');
          left.appendChild(avatarEl(mem.name || mem.email, mem.avatar_url, 'w-8 h-8'));
          var info = ce('div','min-w-0'); info.innerHTML = '<div class="text-sm font-medium truncate">' + esc(mem.name || mem.email) + '</div><div class="text-xs text-gray-400 truncate">' + esc(mem.email) + (mem.role==='admin' ? ' · admin' : '') + '</div>';
          left.appendChild(info);
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

    /* ---------- account + theme color ---------- */
    var ACCENTS = ['#111827','#2563eb','#4f46e5','#7c3aed','#db2777','#e11d48','#ea580c','#059669','#0d9488','#0891b2'];
    function applyAccent(hex){ if(/^#[0-9a-fA-F]{6}$/.test(hex||'')){ document.documentElement.style.setProperty('--accent', hex); localStorage.setItem('chat_accent', hex); } }
    function renderSwatches(){
      var box = $('accentSwatches'); if(!box) return; box.innerHTML='';
      var cur = (me && me.accent) || localStorage.getItem('chat_accent') || '#111827';
      ACCENTS.forEach(function(hex){
        var s = ce('button','w-7 h-7 rounded-full border-2 ' + (hex.toLowerCase()===cur.toLowerCase() ? 'border-gray-900' : 'border-transparent'));
        s.type='button'; s.style.background = hex; s.title = hex;
        s.onclick = function(){ setAccent(hex); };
        box.appendChild(s);
      });
    }
    async function setAccent(hex){
      applyAccent(hex);
      if(me) me.accent = hex;
      renderSwatches();
      try { await api('/api/me', { method:'POST', body: JSON.stringify({ accent: hex }) }); } catch(e){}
    }

    /* ---------- chat wallpaper ---------- */
    var WP_IDS = ['none','doodle','purple','blue','teal','peach','slate','mint','dark'];
    var WALLPAPERS = [
      { id:'none', name:'Default' }, { id:'doodle', name:'Doodle' }, { id:'purple', name:'Purple' },
      { id:'blue', name:'Blue' }, { id:'teal', name:'Teal' }, { id:'peach', name:'Peach' },
      { id:'slate', name:'Slate' }, { id:'mint', name:'Mint' }, { id:'dark', name:'Dark' }
    ];
    function currentWallpaper(){ return (me && me.wallpaper) || localStorage.getItem('chat_wallpaper') || 'none'; }
    function applyWallpaper(id){
      if(WP_IDS.indexOf(id) < 0){ id = 'none'; }
      ['messages','threadMessages'].forEach(function(bid){
        var box = $(bid); if(!box) return;
        WP_IDS.forEach(function(w){ box.classList.remove('wp-'+w); });
        box.classList.add('wp-'+id);
      });
      localStorage.setItem('chat_wallpaper', id);
    }
    function renderWallpaperSwatches(){
      var box = $('wallSwatches'); if(!box) return; box.innerHTML='';
      var cur = currentWallpaper();
      WALLPAPERS.forEach(function(w){
        var s = ce('button','wp-sw wp-' + w.id + ' border-2 ' + (w.id===cur ? 'border-gray-900' : 'border-gray-200'));
        s.type='button'; s.title = w.name;
        s.onclick = function(){ setWallpaper(w.id); };
        box.appendChild(s);
      });
    }
    async function setWallpaper(id){
      applyWallpaper(id);
      if(me) me.wallpaper = id;
      renderWallpaperSwatches();
      try { await api('/api/me', { method:'POST', body: JSON.stringify({ wallpaper: id }) }); } catch(e){}
    }

    function openMe(){ $('meEmail').textContent = me.email; $('meName').value = me.name || ''; renderMeAvatar(); renderSwatches(); renderWallpaperSwatches(); updatePushBtn(); show('meModal'); }
    async function saveName(){
      var name = $('meName').value.trim();
      try { var r = await api('/api/me', { method:'POST', body: JSON.stringify({ name: name }) }); me = r.user; $('whoami').textContent = me.name || me.email; closeModal('meModal'); }
      catch(e){ alert(e.message); }
    }
    function logout(){ localStorage.removeItem('chat_token'); token=''; me=null; stopPoll(); stopThreadPoll(); location.reload(); }

    /* ---------- push notifications ---------- */
    function pushSupported(){ return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window); }
    function urlB64ToUint8Array(b){
      var pad = '='.repeat((4 - b.length % 4) % 4);
      var base64 = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
      var raw = atob(base64), arr = new Uint8Array(raw.length);
      for(var i=0;i<raw.length;i++){ arr[i] = raw.charCodeAt(i); }
      return arr;
    }
    async function pushGetSub(){ var reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
    async function pushSubscribeNow(){
      var reg = await navigator.serviceWorker.ready;
      var r = await api('/api/push/key');
      if(!r || !r.enabled || !r.key){ throw new Error('Push is not configured on the server.'); }
      var sub = await reg.pushManager.getSubscription();
      if(!sub){ sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(r.key) }); }
      var j = sub.toJSON();
      await api('/api/push/subscribe', { method:'POST', body: JSON.stringify({ endpoint: sub.endpoint, keys: j.keys }) });
      return sub;
    }
    async function enablePush(){
      if(!pushSupported()){ alert('Notifications are not supported here. On iPhone/iPad, add this app to your Home Screen first, then open it and try again.'); return; }
      try {
        var perm = await Notification.requestPermission();
        if(perm !== 'granted'){ updatePushBtn(); return; }
        await pushSubscribeNow();
      } catch(e){ alert('Could not enable notifications: ' + (e && e.message ? e.message : e)); }
      updatePushBtn();
    }
    async function disablePush(){
      try {
        var sub = await pushGetSub();
        if(sub){ await api('/api/push/unsubscribe', { method:'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      } catch(e){}
      updatePushBtn();
    }
    async function updatePushBtn(){
      var btn = $('pushBtn'), status = $('pushStatus'); if(!btn) return;
      if(!pushSupported()){ btn.classList.add('hidden'); if(status){ status.textContent = 'Not supported here. On iPhone/iPad, add to Home Screen first.'; } return; }
      btn.classList.remove('hidden');
      if(Notification.permission === 'denied'){ btn.textContent='Blocked'; btn.disabled=true; btn.onclick=null; if(status){ status.textContent='Notifications are blocked in your browser settings.'; } return; }
      btn.disabled = false;
      var subbed = false; try { subbed = !!(await pushGetSub()); } catch(e){}
      if(Notification.permission === 'granted' && subbed){ btn.textContent='Turn off'; btn.onclick=disablePush; if(status){ status.textContent='On for this device.'; } }
      else { btn.textContent='Turn on'; btn.onclick=enablePush; if(status){ status.textContent='Get notified about new messages.'; } }
    }
    async function ensurePushSynced(){ if(!pushSupported() || Notification.permission !== 'granted') return; try { await pushSubscribeNow(); } catch(e){} }
    function openGroupById(gid){
      var g = groups.filter(function(x){ return x.id === gid; })[0];
      if(g){ openGroup(g); return; }
      loadGroups().then(function(){ var g2 = groups.filter(function(x){ return x.id === gid; })[0]; if(g2){ openGroup(g2); } });
    }

    /* ---------- composer auto-grow ---------- */
    document.addEventListener('input', function(e){
      if(e.target && (e.target.id==='composerInput' || e.target.id==='threadInput')){
        e.target.style.height='auto'; e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px';
      }
      if(e.target && e.target.id==='composerInput'){ onComposerInput(); }
    });

    /* ---------- boot ---------- */
    applyAccent(localStorage.getItem('chat_accent') || '#111827');   // instant theme before login
    applyWallpaper(localStorage.getItem('chat_wallpaper') || 'none');
    window.addEventListener('resize', applySidebar);   // re-evaluate on rotate/resize
    if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(function(){}); }
    if('serviceWorker' in navigator && navigator.serviceWorker.addEventListener){
      navigator.serviceWorker.addEventListener('message', function(ev){
        var d = ev.data || {};
        if(d.type === 'open-group' && d.gid != null){ openGroupById(d.gid); }
      });
    }
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

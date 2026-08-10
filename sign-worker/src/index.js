/**
 * Linear Sign — sign.linearit.co
 * =============================================================================
 * A lightweight e-signature service (think "Zoho Sign"): upload a PDF, drop
 * signature / initials / date / text fields on it, send it out for signature,
 * and track every document's status. Signed documents are stamped server-side
 * with pdf-lib and finished off with a tamper-evident signature certificate
 * page (an audit trail: who, when, from which IP, plus a hash of the original).
 *
 * This is a SEPARATE, isolated Worker from linear-chat / linear-vault / etc. It
 * lives in its own folder with its own config and shares NOTHING with the other
 * Workers, so it cannot affect chat.linearit.co, vault.linearit.co, and friends.
 *
 * TWO KINDS OF USER
 * -----------------
 *   • Senders  — staff who create and send documents. They sign in with their
 *                email + a 6-digit code emailed to them (Resend). Two roles:
 *                  - "owner"  : can also add/remove accounts (the Team screen)
 *                  - "member" : can create and send documents only
 *                The ADMIN_EMAILS secret lists the *permanent* owners; everyone
 *                else is added from the Team screen and lives in the `users`
 *                table. Permanent owners can't be edited or removed from the UI,
 *                so the service can never be left without an administrator.
 *   • Signers  — recipients. They do NOT log in. Each recipient gets a private
 *                link containing a random per-recipient token. Opening the link
 *                shows only the fields assigned to them.
 *
 * ROUTES
 *   Non-/api paths            -> reverse-proxied from the GitHub Pages app
 *                                (APP_ORIGIN + APP_PATH), so sign.linearit.co
 *                                serves the same app as www.linearit.co/sign/.
 *
 *   -- sender (Bearer token) --
 *   POST   /api/auth/start        {email}         -> {authorized}
 *   POST   /api/auth/code         {email}         -> emails a sign-in code
 *   POST   /api/auth/login        {email,code}    -> {token, role}
 *   GET    /api/users                             -> (owner) list team accounts
 *   POST   /api/users             {email,name,role}-> (owner) add an account
 *   PUT    /api/users             {email,role?,disabled?} -> (owner) update
 *   DELETE /api/users             {email}         -> (owner) remove an account
 *   GET    /api/docs                              -> list the sender's documents
 *   POST   /api/docs              (multipart)     -> create a draft from a PDF
 *   GET    /api/docs/:id                          -> full document (recips+fields)
 *   PUT    /api/docs/:id                          -> save recipients + fields
 *   POST   /api/docs/:id/send                     -> send for signature
 *   POST   /api/docs/:id/remind                   -> re-email current signers
 *   POST   /api/docs/:id/void                     -> void a sent document
 *   DELETE /api/docs/:id                          -> delete a draft
 *   GET    /api/docs/:id/file                     -> stream the original PDF
 *   GET    /api/docs/:id/signed                   -> stream the completed PDF
 *
 *   -- signer (per-recipient ?token=) --
 *   GET    /api/sign/:id                          -> {doc, recipient, fields}
 *   GET    /api/sign/:id/file                     -> stream the PDF to sign
 *   POST   /api/sign/:id/view                     -> record "opened"
 *   POST   /api/sign/:id/complete                 -> submit signature/values
 *   POST   /api/sign/:id/decline  {reason}        -> decline to sign
 *   GET    /api/sign/:id/signed                   -> stream the completed PDF
 *
 *   GET    /api/health                            -> "ok"
 *
 * ENV (secrets, except the [vars] in wrangler.toml)
 *   DB               D1 database binding (required)
 *   FILES            R2 bucket binding (required) — original + signed PDFs
 *   AUTH_SECRET      long random string — pepper for hashes, signs sender tokens
 *   RESEND_API_KEY   send email via Resend (same key linear-chat/vault use)
 *   EMAIL_FROM       From: address, e.g.  Linear IT <alert@linearit.co>
 *   ADMIN_EMAILS     comma-separated PERMANENT owner addresses. These can always
 *                    sign in and manage the team; add everyone else in the UI.
 *   ALLOW_ORIGIN     CORS origin (default https://www.linearit.co)
 *   APP_ORIGIN       where the app is hosted (default https://www.linearit.co)
 *   APP_PATH         path of the app on that origin (default /sign/)
 *   SIGN_BASE_URL    public base for signer links (default https://sign.linearit.co)
 *   DEV_MODE = "1"   return the sign-in code in the API response (LOCAL ONLY)
 * =============================================================================
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // sender session lifetime (sliding)
const CODE_TTL_MS = 10 * 60 * 1000;      // sign-in code lifetime
const CODE_RESEND_MS = 45 * 1000;        // min gap between code emails to one address
const MAX_CODE_ATTEMPTS = 5;             // wrong codes before a code is burned
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const FIELD_TYPES = ["signature", "initials", "date", "text", "name", "email", "checkbox"];
const RECIP_COLORS = ["#00b0ec", "#4ade80", "#fbbf24", "#f87171", "#a78bfa", "#f472b6", "#22d3ee", "#34d399"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return cors(request, env, new Response(null, { status: 204 }));

    try {
      if (p === "/api/health") return cors(request, env, new Response("ok", { status: 200 }));
      if (p.startsWith("/api/")) {
        return cors(request, env, await handleApi(request, env, url, p, method, ctx));
      }
      return proxyApp(request, env, url, method);
    } catch (err) {
      const status = (err && err.status) || 500;
      if (status >= 500) console.error("Unhandled", err && err.stack ? err.stack : err);
      return cors(request, env, json({ error: String((err && err.message) || err) }, status));
    }
  },
};

/* ============================================================
 * API router
 * ============================================================ */
async function handleApi(request, env, url, p, method, ctx) {
  await ensureSchema(env);

  // Auth (sender sign-in)
  if (p === "/api/auth/start" && method === "POST") return authStart(request, env);
  if (p === "/api/auth/code" && method === "POST") return authCodeReq(request, env);
  if (p === "/api/auth/login" && method === "POST") return authLogin(request, env);

  // Signer flow: /api/sign/:id[/...]
  const sm = p.match(/^\/api\/sign\/([A-Za-z0-9_-]+)(\/(file|view|complete|decline|signed))?$/);
  if (sm) {
    const id = sm[1], sub = sm[3] || "";
    if (!sub && method === "GET") return signGet(request, env, id);
    if (sub === "file" && method === "GET") return signFile(request, env, id);
    if (sub === "signed" && method === "GET") return signSigned(request, env, id);
    if (sub === "view" && method === "POST") return signView(request, env, id);
    if (sub === "complete" && method === "POST") return signComplete(request, env, id, ctx);
    if (sub === "decline" && method === "POST") return signDecline(request, env, id);
    return json({ error: "Not found" }, 404);
  }

  // Team management (owners only)
  if (p === "/api/users" && method === "GET") return usersList(request, env);
  if (p === "/api/users" && method === "POST") return userAdd(request, env);
  if (p === "/api/users" && method === "PUT") return userUpdate(request, env);
  if (p === "/api/users" && method === "DELETE") return userRemove(request, env);

  // Sender: documents
  if (p === "/api/docs" && method === "GET") return docsList(request, env);
  if (p === "/api/docs" && method === "POST") return docCreate(request, env);

  const dm = p.match(/^\/api\/docs\/([A-Za-z0-9_-]+)(\/(file|signed|send|remind|void))?$/);
  if (dm) {
    const id = dm[1], sub = dm[3] || "";
    if (!sub && method === "GET") return docGet(request, env, id);
    if (!sub && method === "PUT") return docSave(request, env, id);
    if (!sub && method === "DELETE") return docDelete(request, env, id);
    if (sub === "file" && method === "GET") return docFile(request, env, id, false);
    if (sub === "signed" && method === "GET") return docFile(request, env, id, true);
    if (sub === "send" && method === "POST") return docSend(request, env, id);
    if (sub === "remind" && method === "POST") return docRemind(request, env, id);
    if (sub === "void" && method === "POST") return docVoid(request, env, id);
    return json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}

/* ============================================================
 * Sender auth (email + emailed 6-digit code)
 * ============================================================ */
async function authStart(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  const acc = await accessFor(env, email);
  return json({ authorized: acc.allowed });
}

async function authCodeReq(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  const acc = await accessFor(env, email);
  if (!acc.allowed) return json({ error: "This email isn't set up to send documents. Contact Linear IT." }, 403);
  const r = await issueCode(env, email);
  if (r.error) return json({ error: r.error }, r.status);
  const out = { ok: true };
  if (r.dev_code) out.dev_code = r.dev_code;
  return json(out);
}

async function authLogin(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  const acc = await accessFor(env, email);
  if (!validEmail(email) || !acc.allowed) return json({ error: "Incorrect email or code." }, 401);
  const cr = await consumeCode(env, email, body.code);
  if (cr.error) return json({ error: cr.error }, cr.status);
  try {
    await env.DB.prepare("UPDATE users SET last_login=? WHERE email=?").bind(Date.now(), email).run();
  } catch (_) {}
  return json({ token: await makeToken(env, { email, kind: "sender" }), email, role: acc.role });
}

async function issueCode(env, email) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(now).run();
  const recent = await env.DB
    .prepare("SELECT created_at FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (recent && now - Number(recent.created_at) < CODE_RESEND_MS) {
    return { error: "A code was just sent. Please wait a moment before requesting another.", status: 429 };
  }
  await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE email=? AND consumed=0").bind(email).run();
  const code = genCode();
  const codeHash = await hashCode(env, email, code);
  await env.DB
    .prepare("INSERT INTO login_codes (email, code_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,0,0,?)")
    .bind(email, codeHash, now + CODE_TTL_MS, now).run();
  const sent = await sendEmail(env, {
    to: email,
    subject: "Your Linear Sign code: " + code,
    text: "Your Linear Sign sign-in code is " + code + "\n\nThis code expires in 10 minutes.",
    html: codeEmailHtml(code),
  });
  if (env.DEV_MODE === "1") return { ok: true, dev_code: code };
  if (!sent.ok) return { error: "Couldn't send the email — email delivery isn't configured yet.", status: 502 };
  return { ok: true };
}

async function consumeCode(env, email, code) {
  if (!/^\d{4,8}$/.test(String(code || ""))) return { error: "Invalid code.", status: 400 };
  const now = Date.now();
  const row = await env.DB
    .prepare("SELECT * FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (!row) return { error: "No active code. Request a new one.", status: 400 };
  if (Number(row.expires_at) < now) return { error: "That code expired. Request a new one.", status: 400 };
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE id=?").bind(row.id).run();
    return { error: "Too many attempts. Request a new code.", status: 429 };
  }
  const hash = await hashCode(env, email, code);
  if (!timingSafeEqual(hash, row.code_hash)) {
    await env.DB.prepare("UPDATE login_codes SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
    return { error: "Incorrect code.", status: 401 };
  }
  await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE id=?").bind(row.id).run();
  return { ok: true };
}

/* ============================================================
 * Team management (owners only)
 * Bootstrap owners (the ADMIN_EMAILS secret) are always listed and are
 * read-only here — they can't be demoted, disabled or deleted from the UI,
 * so the service can never be left without an administrator.
 * ============================================================ */
async function usersList(request, env) {
  const claims = await requireOwner(request, env);
  const rows = (await env.DB.prepare(
    "SELECT email, name, role, disabled, added_by, created_at, last_login FROM users ORDER BY email"
  ).all()).results || [];

  const listed = new Map();
  for (const e of bootstrapOwners(env)) {
    listed.set(e, { email: e, name: "", role: "owner", disabled: false, bootstrap: true, created_at: 0, last_login: 0 });
  }
  for (const r of rows) {
    // A bootstrap owner also present in the table stays shown as bootstrap.
    if (listed.has(normEmail(r.email))) continue;
    listed.set(normEmail(r.email), {
      email: r.email, name: r.name || "",
      role: r.role === "owner" ? "owner" : "member",
      disabled: !!Number(r.disabled), bootstrap: false,
      created_at: Number(r.created_at) || 0, last_login: Number(r.last_login) || 0,
    });
  }
  return json({
    token: await makeToken(env, claims),
    me: claims.email, my_role: claims.role,
    users: [...listed.values()],
  });
}

async function userAdd(request, env) {
  const claims = await requireOwner(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  const name = String(body.name || "").slice(0, 120);
  const role = body.role === "owner" ? "owner" : "member";
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (isBootstrapOwner(env, email)) return json({ error: "That email is already a permanent owner." }, 409);
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first();
  if (exists) return json({ error: "That email already has an account." }, 409);

  await env.DB.prepare(
    "INSERT INTO users (email, name, role, disabled, added_by, created_at, last_login) VALUES (?,?,?,0,?,?,0)"
  ).bind(email, name, role, claims.email, Date.now()).run();

  const base = env.SIGN_BASE_URL || "https://sign.linearit.co";
  await sendEmail(env, {
    to: email,
    subject: "You've been added to Linear Sign",
    text: (name ? "Hi " + name + ",\n\n" : "") +
      claims.email + " has given you access to Linear Sign.\n\n" +
      "Sign in at " + base + " with this email address (" + email + "). " +
      "There's no password — we email you a 6-digit code each time you sign in.",
    html: simpleEmailHtml("You've been added to Linear Sign",
      "<b>" + esc(claims.email) + "</b> has given you access to Linear Sign.",
      'Sign in at <a href="' + esc(base) + '">' + esc(base) + '</a> with <b>' + esc(email) + '</b>. ' +
      "There's no password — we email you a 6-digit code each time you sign in."),
  });
  return json({ token: await makeToken(env, claims), ok: true });
}

async function userUpdate(request, env) {
  const claims = await requireOwner(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (isBootstrapOwner(env, email)) return json({ error: "Permanent owners can't be changed here." }, 403);
  if (email === claims.email) return json({ error: "You can't change your own role or access." }, 403);
  const row = await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first();
  if (!row) return json({ error: "That account doesn't exist." }, 404);

  const sets = [], binds = [];
  if (body.role !== undefined) { sets.push("role=?"); binds.push(body.role === "owner" ? "owner" : "member"); }
  if (body.disabled !== undefined) { sets.push("disabled=?"); binds.push(body.disabled ? 1 : 0); }
  if (body.name !== undefined) { sets.push("name=?"); binds.push(String(body.name).slice(0, 120)); }
  if (!sets.length) return json({ error: "Nothing to update." }, 400);
  binds.push(email);
  await env.DB.prepare("UPDATE users SET " + sets.join(", ") + " WHERE email=?").bind(...binds).run();
  return json({ token: await makeToken(env, claims), ok: true });
}

async function userRemove(request, env) {
  const claims = await requireOwner(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (isBootstrapOwner(env, email)) return json({ error: "Permanent owners can't be removed here." }, 403);
  if (email === claims.email) return json({ error: "You can't remove your own account." }, 403);

  // Their documents stay put (owned by their address) so nothing in flight breaks;
  // removing the account only revokes sign-in.
  await env.DB.prepare("DELETE FROM users WHERE email=?").bind(email).run();
  await env.DB.prepare("DELETE FROM login_codes WHERE email=?").bind(email).run();
  return json({ token: await makeToken(env, claims), ok: true });
}

/* ============================================================
 * Documents (sender)
 * ============================================================ */
async function docsList(request, env) {
  const claims = await requireSender(request, env);
  const rows = (await env.DB.prepare(
    "SELECT id, title, status, page_count, created_at, updated_at, sent_at, completed_at, " +
    "(SELECT COUNT(*) FROM recipients r WHERE r.doc_id=d.id) AS recip_total, " +
    "(SELECT COUNT(*) FROM recipients r WHERE r.doc_id=d.id AND r.status='signed') AS recip_signed " +
    "FROM documents d WHERE owner_email=? ORDER BY updated_at DESC LIMIT 500"
  ).bind(claims.email).all()).results || [];
  return json({ token: await makeToken(env, claims), docs: rows.map(mapDocRow), role: claims.role, me: claims.email });
}

async function docCreate(request, env) {
  const claims = await requireSender(request, env);
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return json({ error: "Upload a PDF file." }, 400);
  const form = await request.formData();
  const file = form.get("file");
  const title = String(form.get("title") || "").trim() || (file && file.name) || "Untitled document";
  if (!file || typeof file === "string") return json({ error: "No file received." }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return json({ error: "The file is empty." }, 400);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return json({ error: "PDF is too large (max 25 MB)." }, 413);
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return json({ error: "That doesn't look like a PDF file." }, 400);
  }

  let pageCount = 0;
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    pageCount = pdf.getPageCount();
  } catch (_) {
    return json({ error: "Couldn't read that PDF — it may be corrupted or password-protected." }, 400);
  }

  const id = uid();
  const now = Date.now();
  const origKey = "orig/" + id + ".pdf";
  await env.FILES.put(origKey, bytes, { httpMetadata: { contentType: "application/pdf" } });
  await env.DB.prepare(
    "INSERT INTO documents (id, owner_email, title, message, status, ordered, page_count, orig_key, signed_key, orig_hash, created_at, updated_at) " +
    "VALUES (?,?,?,?,'draft',0,?,?,NULL,?,?,?)"
  ).bind(id, claims.email, title.slice(0, 200), "", pageCount, origKey, await sha256Hex(bytes), now, now).run();
  await logEvent(env, id, null, "created", title, request);

  return json({ token: await makeToken(env, claims), id, page_count: pageCount, title });
}

async function docGet(request, env, id) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  const recipients = (await env.DB.prepare(
    "SELECT id, email, name, order_index, role, status, color, viewed_at, signed_at, decline_reason " +
    "FROM recipients WHERE doc_id=? ORDER BY order_index, id"
  ).bind(id).all()).results || [];
  const fields = (await env.DB.prepare(
    "SELECT id, recipient_id, type, page, x, y, w, h, required, font_size, value FROM fields WHERE doc_id=? ORDER BY id"
  ).bind(id).all()).results || [];
  const events = (await env.DB.prepare(
    "SELECT type, detail, ip, created_at FROM events WHERE doc_id=? ORDER BY id DESC LIMIT 200"
  ).bind(id).all()).results || [];
  return json({
    token: await makeToken(env, claims),
    doc: mapDocRow(doc),
    ordered: !!doc.ordered,
    message: doc.message || "",
    recipients: recipients.map(mapRecip),
    fields: fields.map(mapField),
    events,
  });
}

// Save recipients + fields for a DRAFT (full replace). Also updates title/message/ordered.
async function docSave(request, env, id) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  if (doc.status !== "draft") return json({ error: "Only drafts can be edited." }, 409);
  const body = await readBody(request);

  const title = (String(body.title || doc.title).trim() || "Untitled document").slice(0, 200);
  const message = String(body.message || "").slice(0, 2000);
  const ordered = body.ordered ? 1 : 0;

  const recips = Array.isArray(body.recipients) ? body.recipients : [];
  const fields = Array.isArray(body.fields) ? body.fields : [];
  if (recips.length > 25) return json({ error: "Too many recipients." }, 400);
  if (fields.length > 500) return json({ error: "Too many fields." }, 400);

  // Validate + normalize recipients. Client provides a stable local id per recipient
  // used to link fields; we mint real ids here and remap the fields to them.
  const idMap = new Map();
  const cleanRecips = [];
  let idx = 0;
  for (const r of recips) {
    const email = normEmail(r.email);
    if (!validEmail(email)) return json({ error: "Every recipient needs a valid email address." }, 400);
    const rid = uid();
    idMap.set(String(r.id), rid);
    cleanRecips.push({
      id: rid,
      email,
      name: String(r.name || "").slice(0, 120),
      order_index: Number.isFinite(+r.order_index) ? +r.order_index : idx,
      role: r.role === "viewer" ? "viewer" : "signer",
      color: RECIP_COLORS[idx % RECIP_COLORS.length],
    });
    idx++;
  }

  const cleanFields = [];
  for (const f of fields) {
    const rid = idMap.get(String(f.recipient_id));
    if (!rid) continue; // orphan field (recipient removed)
    if (!FIELD_TYPES.includes(f.type)) return json({ error: "Unknown field type." }, 400);
    const page = clampInt(f.page, 1, doc.page_count);
    const x = clamp01(f.x), y = clamp01(f.y);
    const w = clampNum(f.w, 0.02, 1), h = clampNum(f.h, 0.01, 1);
    cleanFields.push({
      id: uid(), recipient_id: rid, type: f.type, page, x, y, w, h,
      required: f.required === false ? 0 : 1,
      font_size: clampNum(f.font_size, 6, 48) || 12,
    });
  }

  // Replace-all inside a batch.
  const stmts = [
    env.DB.prepare("UPDATE documents SET title=?, message=?, ordered=?, updated_at=? WHERE id=?")
      .bind(title, message, ordered, Date.now(), id),
    env.DB.prepare("DELETE FROM fields WHERE doc_id=?").bind(id),
    env.DB.prepare("DELETE FROM recipients WHERE doc_id=?").bind(id),
  ];
  for (const r of cleanRecips) {
    stmts.push(env.DB.prepare(
      "INSERT INTO recipients (id, doc_id, email, name, order_index, role, status, token, color, viewed_at, signed_at) " +
      "VALUES (?,?,?,?,?,?,'pending',?,?,0,0)"
    ).bind(r.id, id, r.email, r.name, r.order_index, r.role, uid() + uid(), r.color));
  }
  for (const f of cleanFields) {
    stmts.push(env.DB.prepare(
      "INSERT INTO fields (id, doc_id, recipient_id, type, page, x, y, w, h, required, font_size, value) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)"
    ).bind(f.id, id, f.recipient_id, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.font_size));
  }
  await env.DB.batch(stmts);
  return json({ token: await makeToken(env, claims), ok: true });
}

async function docSend(request, env, id) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  if (doc.status !== "draft") return json({ error: "This document has already been sent." }, 409);
  const recips = (await env.DB.prepare(
    "SELECT * FROM recipients WHERE doc_id=? ORDER BY order_index, id"
  ).bind(id).all()).results || [];
  if (recips.length === 0) return json({ error: "Add at least one recipient before sending." }, 400);
  const fieldCounts = (await env.DB.prepare(
    "SELECT recipient_id, COUNT(*) AS n FROM fields WHERE doc_id=? GROUP BY recipient_id"
  ).bind(id).all()).results || [];
  const withFields = new Set(fieldCounts.map((r) => r.recipient_id));
  const signerNoFields = recips.find((r) => r.role === "signer" && !withFields.has(r.id));
  if (signerNoFields) {
    return json({ error: "Every signer needs at least one field. " + signerNoFields.email + " has none." }, 400);
  }

  const now = Date.now();
  await env.DB.prepare("UPDATE documents SET status='sent', sent_at=?, updated_at=? WHERE id=?")
    .bind(now, now, id).run();
  await env.DB.prepare("UPDATE recipients SET status='pending' WHERE doc_id=?").bind(id).run();
  await logEvent(env, id, null, "sent", "Sent to " + recips.length + " recipient(s)", request);

  // Email the recipients whose turn it is now (ordered => lowest pending order only).
  await notifyCurrentSigners(env, doc, recips);
  return json({ token: await makeToken(env, claims), ok: true });
}

async function docRemind(request, env, id) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  if (doc.status !== "sent") return json({ error: "Only sent documents can be reminded." }, 409);
  const recips = (await env.DB.prepare(
    "SELECT * FROM recipients WHERE doc_id=? ORDER BY order_index, id"
  ).bind(id).all()).results || [];
  const n = await notifyCurrentSigners(env, doc, recips, true);
  await logEvent(env, id, null, "reminded", "Reminded " + n + " recipient(s)", request);
  return json({ token: await makeToken(env, claims), reminded: n });
}

async function docVoid(request, env, id) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  if (doc.status === "completed") return json({ error: "A completed document can't be voided." }, 409);
  const body = await readBody(request);
  await env.DB.prepare("UPDATE documents SET status='voided', updated_at=? WHERE id=?").bind(Date.now(), id).run();
  await logEvent(env, id, null, "voided", String(body.reason || "").slice(0, 300), request);
  return json({ token: await makeToken(env, claims), ok: true });
}

async function docDelete(request, env, id) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  if (doc.status !== "draft" && doc.status !== "voided") {
    return json({ error: "Only drafts or voided documents can be deleted." }, 409);
  }
  await deleteDocFully(env, doc);
  return json({ token: await makeToken(env, claims), ok: true });
}

async function docFile(request, env, id, signed) {
  const claims = await requireSender(request, env);
  const doc = await ownedDoc(env, id, claims.email);
  const key = signed ? doc.signed_key : doc.orig_key;
  if (!key) return json({ error: signed ? "Not completed yet." : "File missing." }, 404);
  return streamPdf(env, key, safeFilename(doc.title) + (signed ? "-signed.pdf" : ".pdf"));
}

/* ============================================================
 * Signer flow (per-recipient token; no login)
 * ============================================================ */
async function loadSigner(env, id, token) {
  if (!token) throw httpError("This signing link is missing its token.", 400);
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(id).first();
  if (!doc) throw httpError("Document not found.", 404);
  const recip = await env.DB.prepare("SELECT * FROM recipients WHERE doc_id=? AND token=?").bind(id, token).first();
  if (!recip) throw httpError("This signing link is invalid or has been revoked.", 403);
  return { doc, recip };
}

async function signGet(request, env, id) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const { doc, recip } = await loadSigner(env, id, token);
  const fields = (await env.DB.prepare(
    "SELECT id, type, page, x, y, w, h, required, font_size, value FROM fields WHERE doc_id=? AND recipient_id=? ORDER BY id"
  ).bind(id, recip.id).all()).results || [];

  // Is it this recipient's turn (ordered docs sign one at a time)?
  const yourTurn = await isRecipientsTurn(env, doc, recip);
  return json({
    doc: { id: doc.id, title: doc.title, status: doc.status, page_count: doc.page_count, message: doc.message || "" },
    recipient: { id: recip.id, email: recip.email, name: recip.name, role: recip.role, status: recip.status, color: recip.color },
    fields: fields.map(mapField),
    your_turn: yourTurn,
    completed: doc.status === "completed",
  });
}

async function signFile(request, env, id) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const { doc } = await loadSigner(env, id, token);
  return streamPdf(env, doc.orig_key, safeFilename(doc.title) + ".pdf", true);
}

async function signSigned(request, env, id) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const { doc } = await loadSigner(env, id, token);
  if (doc.status !== "completed" || !doc.signed_key) return json({ error: "Not completed yet." }, 404);
  return streamPdf(env, doc.signed_key, safeFilename(doc.title) + "-signed.pdf");
}

async function signView(request, env, id) {
  const body = await readBody(request);
  const token = body.token || new URL(request.url).searchParams.get("token") || "";
  const { doc, recip } = await loadSigner(env, id, token);
  if (recip.status === "pending") {
    await env.DB.prepare("UPDATE recipients SET status='viewed', viewed_at=? WHERE id=? AND status='pending'")
      .bind(Date.now(), recip.id).run();
    await logEvent(env, doc.id, recip.id, "viewed", recip.email, request);
  } else if (recip.status === "viewed" && !recip.viewed_at) {
    await env.DB.prepare("UPDATE recipients SET viewed_at=? WHERE id=?").bind(Date.now(), recip.id).run();
  }
  return json({ ok: true });
}

async function signDecline(request, env, id) {
  const body = await readBody(request);
  const token = body.token || "";
  const { doc, recip } = await loadSigner(env, id, token);
  if (doc.status === "completed") return json({ error: "This document is already completed." }, 409);
  if (recip.status === "signed") return json({ error: "You've already signed this document." }, 409);
  const reason = String(body.reason || "").slice(0, 500);
  await env.DB.prepare("UPDATE recipients SET status='declined', decline_reason=? WHERE id=?").bind(reason, recip.id).run();
  await env.DB.prepare("UPDATE documents SET status='declined', updated_at=? WHERE id=?").bind(Date.now(), doc.id).run();
  await logEvent(env, doc.id, recip.id, "declined", reason, request);
  await sendEmail(env, {
    to: doc.owner_email,
    subject: "Declined: " + doc.title,
    text: recip.email + " declined to sign \"" + doc.title + "\".\n\nReason: " + (reason || "(none given)"),
    html: simpleEmailHtml("Document declined",
      "<b>" + esc(recip.email) + "</b> declined to sign <b>" + esc(doc.title) + "</b>.",
      reason ? "Reason: " + esc(reason) : ""),
  });
  return json({ ok: true });
}

async function signComplete(request, env, id, ctx) {
  const body = await readBody(request);
  const token = body.token || "";
  const { doc, recip } = await loadSigner(env, id, token);
  if (doc.status === "completed") return json({ error: "This document is already completed." }, 409);
  if (doc.status === "voided" || doc.status === "declined") return json({ error: "This document is no longer active." }, 409);
  if (recip.status === "signed") return json({ error: "You've already signed this document." }, 409);
  if (!(await isRecipientsTurn(env, doc, recip))) {
    return json({ error: "It isn't your turn to sign yet." }, 409);
  }

  const fields = (await env.DB.prepare(
    "SELECT * FROM fields WHERE doc_id=? AND recipient_id=?"
  ).bind(id, recip.id).all()).results || [];
  const values = (body.values && typeof body.values === "object") ? body.values : {};
  const now = Date.now();
  const dateStr = fmtDate(now);

  // Validate + persist each field's value.
  const updates = [];
  for (const f of fields) {
    let v = values[f.id];
    if (f.type === "date") v = (v && String(v).slice(0, 40)) || dateStr;
    else if (f.type === "name") v = recip.name || v || "";
    else if (f.type === "email") v = recip.email;
    else if (f.type === "checkbox") v = v ? "1" : "";
    else if (f.type === "signature" || f.type === "initials") {
      // Signature images arrive as PNG data URLs; store them in R2, keep the key.
      if (typeof v === "string" && v.startsWith("data:image/png;base64,")) {
        const png = b64ToBytes(v.slice("data:image/png;base64,".length));
        if (png.byteLength > 2 * 1024 * 1024) return json({ error: "Signature image is too large." }, 413);
        const key = "sig/" + id + "/" + f.id + ".png";
        await env.FILES.put(key, png, { httpMetadata: { contentType: "image/png" } });
        v = key;
      } else if (!f.required) {
        v = "";
      } else {
        return json({ error: "Please complete all required signatures." }, 400);
      }
    } else {
      v = (v == null ? "" : String(v)).slice(0, 2000);
    }
    // Only free-entry fields can be "missing". date/name/email are auto-filled,
    // and signature/initials already enforced their own required check above.
    if (f.required && f.type === "text" && !v) {
      return json({ error: "Please complete all required fields before finishing." }, 400);
    }
    updates.push(env.DB.prepare("UPDATE fields SET value=? WHERE id=?").bind(v, f.id));
  }
  if (updates.length) await env.DB.batch(updates);

  await env.DB.prepare("UPDATE recipients SET status='signed', signed_at=?, viewed_at=COALESCE(NULLIF(viewed_at,0),?) WHERE id=?")
    .bind(now, now, recip.id).run();
  await logEvent(env, id, recip.id, "signed", recip.email, request);

  // Any signers left?
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM recipients WHERE doc_id=? AND role='signer' AND status!='signed'"
  ).bind(id).first();

  if (Number(remaining.n) === 0) {
    // Everyone signed -> stamp the final PDF and finish.
    await finalizeDocument(env, id);
    return json({ ok: true, completed: true });
  }

  // Ordered docs: notify the next signer(s) in line.
  await env.DB.prepare("UPDATE documents SET updated_at=? WHERE id=?").bind(now, id).run();
  const freshDoc = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(id).first();
  const recips = (await env.DB.prepare("SELECT * FROM recipients WHERE doc_id=? ORDER BY order_index, id").bind(id).all()).results || [];
  await notifyCurrentSigners(env, freshDoc, recips);
  return json({ ok: true, completed: false });
}

/* ============================================================
 * Turn logic + notifications
 * ============================================================ */
async function isRecipientsTurn(env, doc, recip) {
  if (recip.role !== "signer") return false;
  if (recip.status === "signed") return false;
  if (!doc.ordered) return true;
  // Ordered: it's your turn only if no earlier-ordered signer is still unsigned.
  const blocker = await env.DB.prepare(
    "SELECT 1 FROM recipients WHERE doc_id=? AND role='signer' AND status!='signed' AND order_index < ? LIMIT 1"
  ).bind(doc.id, recip.order_index).first();
  return !blocker;
}

// Email the signer(s) whose turn it currently is. Returns how many were emailed.
async function notifyCurrentSigners(env, doc, recips, force) {
  const signers = recips.filter((r) => r.role === "signer" && r.status !== "signed" && r.status !== "declined");
  if (signers.length === 0) return 0;
  let targets;
  if (doc.ordered) {
    const minOrder = Math.min(...signers.map((r) => Number(r.order_index)));
    targets = signers.filter((r) => Number(r.order_index) === minOrder);
  } else {
    targets = force ? signers : signers.filter((r) => r.status === "pending");
  }
  let n = 0;
  for (const r of targets) {
    const link = signLink(env, doc.id, r.token);
    const ok = await sendEmail(env, {
      to: r.email,
      subject: (force ? "Reminder: " : "") + "Please sign: " + doc.title,
      text: (r.name ? "Hi " + r.name + ",\n\n" : "") +
        (doc.owner_email + " has requested your signature on \"" + doc.title + "\".\n\n") +
        (doc.message ? doc.message + "\n\n" : "") +
        "Review and sign here:\n" + link + "\n\nThis link is unique to you — please don't forward it.",
      html: signInviteHtml(doc, r, link),
    });
    if (ok.ok) n++;
  }
  return n;
}

/* ============================================================
 * Finalize — stamp all fields onto the PDF + append a certificate
 * ============================================================ */
async function finalizeDocument(env, id) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(id).first();
  if (!doc || doc.status === "completed") return;
  const recips = (await env.DB.prepare("SELECT * FROM recipients WHERE doc_id=? ORDER BY order_index, id").bind(id).all()).results || [];
  const fields = (await env.DB.prepare("SELECT * FROM fields WHERE doc_id=?").bind(id).all()).results || [];
  const events = (await env.DB.prepare("SELECT * FROM events WHERE doc_id=? ORDER BY id").bind(id).all()).results || [];

  const origObj = await env.FILES.get(doc.orig_key);
  if (!origObj) throw httpError("Original file is missing.", 500);
  const origBytes = new Uint8Array(await origObj.arrayBuffer());

  const pdf = await PDFDocument.load(origBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();

  // Cache signature images so a shared image isn't fetched twice.
  const imgCache = new Map();
  for (const f of fields) {
    if (!f.value) continue;
    const pageIndex = clampInt(f.page, 1, pages.length) - 1;
    const page = pages[pageIndex];
    const pw = page.getWidth(), ph = page.getHeight();
    // Stored coords are normalized with y measured from the TOP of the page.
    const bx = f.x * pw;
    const bw = f.w * pw;
    const bh = f.h * ph;
    const byTop = f.y * ph;
    const byBottom = ph - byTop - bh; // pdf-lib origin is bottom-left

    if (f.type === "signature" || f.type === "initials") {
      try {
        let png = imgCache.get(f.value);
        if (png === undefined) {
          const obj = await env.FILES.get(f.value);
          png = obj ? await pdf.embedPng(new Uint8Array(await obj.arrayBuffer())) : null;
          imgCache.set(f.value, png);
        }
        if (png) {
          // Fit the signature inside the box, preserving aspect ratio, centered.
          const scale = Math.min(bw / png.width, bh / png.height);
          const dw = png.width * scale, dh = png.height * scale;
          page.drawImage(png, { x: bx + (bw - dw) / 2, y: byBottom + (bh - dh) / 2, width: dw, height: dh });
        }
      } catch (_) { /* skip an unembeddable image rather than fail the whole doc */ }
    } else if (f.type === "checkbox") {
      if (f.value) {
        const size = Math.min(bw, bh) * 0.9;
        page.drawText("X", { x: bx + (bw - size * 0.6) / 2, y: byBottom + (bh - size) / 2 + size * 0.1, size, font, color: rgb(0.1, 0.1, 0.1) });
      }
    } else {
      const text = String(f.value);
      let size = Math.min(Number(f.font_size) || 12, bh * 0.8);
      // Shrink to fit the box width if needed.
      while (size > 6 && font.widthOfTextAtSize(text, size) > bw) size -= 0.5;
      page.drawText(text, { x: bx + 1, y: byBottom + (bh - size) / 2 + size * 0.15, size, font, color: rgb(0.06, 0.06, 0.2) });
    }
  }

  await appendCertificate(pdf, font, doc, recips, events, origBytes);

  const outBytes = await pdf.save();
  const signedKey = "signed/" + id + ".pdf";
  await env.FILES.put(signedKey, outBytes, { httpMetadata: { contentType: "application/pdf" } });

  const now = Date.now();
  await env.DB.prepare("UPDATE documents SET status='completed', signed_key=?, completed_at=?, updated_at=? WHERE id=?")
    .bind(signedKey, now, now, id).run();
  await logEvent(env, id, null, "completed", "All recipients signed", null);

  // Email the completed copy link to the sender + every signer.
  const dlSender = env.SIGN_BASE_URL ? "" : "";
  await sendEmail(env, {
    to: doc.owner_email,
    subject: "Completed: " + doc.title,
    text: "All recipients have signed \"" + doc.title + "\". Open Linear Sign to download the signed PDF.",
    html: simpleEmailHtml("Document completed",
      "All recipients have signed <b>" + esc(doc.title) + "</b>.",
      '<a href="' + esc((env.SIGN_BASE_URL || "https://sign.linearit.co")) + '">Open Linear Sign to download the signed copy.</a>'),
  });
  for (const r of recips) {
    if (r.role !== "signer") continue;
    const link = signLink(env, doc.id, r.token);
    await sendEmail(env, {
      to: r.email,
      subject: "Signed & completed: " + doc.title,
      text: "Thanks for signing \"" + doc.title + "\". It's now complete. Download your signed copy:\n" + link,
      html: simpleEmailHtml("Signing complete",
        "Thanks for signing <b>" + esc(doc.title) + "</b> — it's now fully executed.",
        '<a href="' + esc(link) + '">Download your signed copy</a>'),
    });
  }
}

async function appendCertificate(pdf, font, doc, recips, events, origBytes) {
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  const M = 54;
  let y = 792 - M;
  const line = (t, opts = {}) => {
    const size = opts.size || 10;
    const f = opts.bold ? bold : font;
    page.drawText(String(t), { x: opts.x || M, y, size, font: f, color: opts.color || rgb(0.1, 0.1, 0.12) });
    y -= (opts.gap || size + 6);
  };
  line("Signature Certificate", { size: 20, bold: true });
  y -= 4;
  page.drawLine({ start: { x: M, y: y }, end: { x: 612 - M, y: y }, thickness: 1, color: rgb(0.8, 0.82, 0.9) });
  y -= 18;
  line("Document", { bold: true, size: 11 });
  line(doc.title, { x: M });
  line("Document ID:  " + doc.id, { color: rgb(0.35, 0.35, 0.4) });
  line("Original SHA-256:  " + (await sha256Hex(origBytes)), { color: rgb(0.35, 0.35, 0.4), size: 8 });
  line("Created:  " + fmtDateTime(doc.created_at), { color: rgb(0.35, 0.35, 0.4) });
  line("Completed:  " + fmtDateTime(Date.now()), { color: rgb(0.35, 0.35, 0.4) });
  y -= 8;
  line("Recipients", { bold: true, size: 11 });
  for (const r of recips) {
    line((r.name ? r.name + "  <" + r.email + ">" : r.email), { bold: true, size: 10 });
    const bits = [
      "Status: " + r.status,
      r.viewed_at ? "Viewed: " + fmtDateTime(r.viewed_at) : null,
      r.signed_at ? "Signed: " + fmtDateTime(r.signed_at) : null,
    ].filter(Boolean).join("    ");
    line("   " + bits, { size: 9, color: rgb(0.35, 0.35, 0.4) });
    if (y < 140) { y = 792 - M; pdf.addPage([612, 792]); }
  }
  y -= 8;
  line("Audit trail", { bold: true, size: 11 });
  for (const e of events) {
    if (y < 70) break;
    const detail = e.detail ? " — " + String(e.detail).slice(0, 60) : "";
    line(fmtDateTime(e.created_at) + "   " + e.type + detail + (e.ip ? "   (" + e.ip + ")" : ""), { size: 8, color: rgb(0.4, 0.4, 0.45) });
  }
  page.drawText("Generated by Linear Sign · sign.linearit.co", {
    x: M, y: 40, size: 8, font, color: rgb(0.55, 0.55, 0.62),
  });
}

/* ============================================================
 * Storage / streaming helpers
 * ============================================================ */
async function streamPdf(env, key, filename, inline) {
  const obj = await env.FILES.get(key);
  if (!obj) return json({ error: "File not found." }, 404);
  const h = new Headers();
  h.set("Content-Type", "application/pdf");
  h.set("Content-Disposition", (inline ? "inline" : "attachment") + '; filename="' + filename + '"');
  h.set("Cache-Control", "private, no-store");
  return new Response(obj.body, { status: 200, headers: h });
}

async function deleteDocFully(env, doc) {
  const fields = (await env.DB.prepare("SELECT value FROM fields WHERE doc_id=?").bind(doc.id).all()).results || [];
  const keys = [doc.orig_key, doc.signed_key].filter(Boolean);
  for (const f of fields) if (f.value && typeof f.value === "string" && f.value.startsWith("sig/")) keys.push(f.value);
  for (const k of keys) { try { await env.FILES.delete(k); } catch (_) {} }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fields WHERE doc_id=?").bind(doc.id),
    env.DB.prepare("DELETE FROM recipients WHERE doc_id=?").bind(doc.id),
    env.DB.prepare("DELETE FROM events WHERE doc_id=?").bind(doc.id),
    env.DB.prepare("DELETE FROM documents WHERE id=?").bind(doc.id),
  ]);
}

/* ============================================================
 * Auth tokens (sender sessions) — HMAC-signed, sliding expiry
 * ============================================================ */
// Access is re-checked from the DB on every request (not trusted from the token),
// so removing or demoting someone takes effect immediately, not at token expiry.
async function requireSender(request, env) {
  const c = await authClaims(request, env);
  if (!c || c.kind !== "sender") throw httpError("Please sign in again.", 401);
  const acc = await accessFor(env, c.email);
  if (!acc.allowed) throw httpError("Your access has been removed. Contact an administrator.", 401);
  return { email: c.email, kind: "sender", role: acc.role, bootstrap: acc.bootstrap };
}
async function requireOwner(request, env) {
  const claims = await requireSender(request, env);
  if (claims.role !== "owner") throw httpError("Only an owner can manage the team.", 403);
  return claims;
}
async function makeToken(env, claims) {
  const payload = b64urlStr(JSON.stringify({ email: claims.email, kind: claims.kind || "sender", exp: Date.now() + TOKEN_TTL_MS }));
  return payload + "." + (await hmacSign(env, payload));
}
async function authClaims(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await hmacSign(env, payload), sig)) return null;
  try {
    const claims = JSON.parse(b64urlDecodeToStr(payload));
    if (!claims.exp || claims.exp < Date.now() || !claims.email) return null;
    return claims;
  } catch (_) { return null; }
}

async function ownedDoc(env, id, email) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id=? AND owner_email=?").bind(id, email).first();
  if (!doc) throw httpError("Document not found.", 404);
  return doc;
}

/* ============================================================
 * Events / audit
 * ============================================================ */
async function logEvent(env, docId, recipId, type, detail, request) {
  const ip = request ? (request.headers.get("CF-Connecting-IP") || "") : "";
  const ua = request ? (request.headers.get("User-Agent") || "").slice(0, 200) : "";
  try {
    await env.DB.prepare(
      "INSERT INTO events (doc_id, recipient_id, type, detail, ip, ua, created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(docId, recipId, type, String(detail || "").slice(0, 300), ip, ua, Date.now()).run();
  } catch (_) {}
}

/* ============================================================
 * Email (Resend)
 * ============================================================ */
async function sendEmail(env, msg) {
  if (!env.RESEND_API_KEY) return { ok: false, reason: "RESEND_API_KEY not set" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "Linear IT <alert@linearit.co>",
        to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
      }),
    });
    if (res.ok) return { ok: true };
    let body = "";
    try { body = JSON.stringify(await res.json()); } catch (_) { try { body = await res.text(); } catch (_2) {} }
    console.error("Resend failed", res.status, body);
    return { ok: false, reason: "Resend HTTP " + res.status };
  } catch (e) {
    console.error("Resend error", e);
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
function signLink(env, docId, token) {
  return (env.SIGN_BASE_URL || "https://sign.linearit.co") + "/?d=" + encodeURIComponent(docId) + "&t=" + encodeURIComponent(token);
}
function emailShell(inner) {
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#1f2430">' +
    '<div style="font-weight:800;font-size:18px;color:#00b0ec;margin-bottom:14px">Linear Sign</div>' +
    inner +
    '<hr style="border:none;border-top:1px solid #eef0f5;margin:22px 0 12px">' +
    '<div style="color:#9aa0b0;font-size:12px">Linear IT · (845) 604-1462 · sign.linearit.co</div></div>';
}
function codeEmailHtml(code) {
  return emailShell(
    '<p style="color:#444;margin:0 0 16px">Use this code to sign in:</p>' +
    '<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center;color:#111">' + code + "</div>" +
    '<p style="color:#888;font-size:13px;margin:16px 0 0">This code expires in 10 minutes. If you didn\'t request it, ignore this email.</p>'
  );
}
function signInviteHtml(doc, r, link) {
  return emailShell(
    (r.name ? '<p style="margin:0 0 6px">Hi ' + esc(r.name) + ',</p>' : '') +
    '<p style="color:#333;margin:0 0 16px"><b>' + esc(doc.owner_email) + '</b> has requested your signature on <b>' + esc(doc.title) + '</b>.</p>' +
    (doc.message ? '<div style="background:#f7f8fb;border-radius:10px;padding:12px 14px;color:#444;margin:0 0 18px">' + esc(doc.message) + '</div>' : '') +
    '<a href="' + esc(link) + '" style="display:inline-block;background:#00b0ec;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Review &amp; sign</a>' +
    '<p style="color:#9aa0b0;font-size:12px;margin:18px 0 0">This link is unique to you — please don\'t forward it.</p>'
  );
}
function simpleEmailHtml(title, line1, line2) {
  return emailShell(
    '<p style="font-weight:700;font-size:16px;margin:0 0 8px">' + esc(title) + '</p>' +
    '<p style="color:#333;margin:0 0 12px">' + line1 + '</p>' +
    (line2 ? '<p style="color:#444;margin:0">' + line2 + '</p>' : '')
  );
}

/* ============================================================
 * Reverse-proxy the app from GitHub Pages
 * ============================================================ */
async function proxyApp(request, env, url, method) {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/sign/";      // where the app lives on APP_ORIGIN
  const base = appPath.replace(/\/+$/, "");       // "/sign"
  // Mount the app folder at the domain root: sign.linearit.co/ serves
  // <origin>/sign/, sign.linearit.co/app.js serves <origin>/sign/app.js, etc.
  let path = url.pathname;
  if (path === "/") path = appPath;
  else if (path !== base && !path.startsWith(base + "/")) path = base + path;
  const target = origin + path + url.search;
  let originResp;
  try {
    originResp = await fetch(target, {
      method: "GET",
      headers: { Accept: request.headers.get("Accept") || "*/*", "Accept-Encoding": "gzip" },
      redirect: "follow",
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } catch (_) {
    return new Response("Linear Sign is briefly unavailable. Please try again in a moment.", {
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
  headers.set("X-Served-By", "linear-sign");
  const body = method === "HEAD" ? null : originResp.body;
  return new Response(body, { status: originResp.status, statusText: originResp.statusText, headers });
}

/* ============================================================
 * Mappers
 * ============================================================ */
function mapDocRow(d) {
  return {
    id: d.id, title: d.title, status: d.status, page_count: Number(d.page_count) || 0,
    created_at: Number(d.created_at) || 0, updated_at: Number(d.updated_at) || 0,
    sent_at: Number(d.sent_at) || 0, completed_at: Number(d.completed_at) || 0,
    recip_total: Number(d.recip_total) || 0, recip_signed: Number(d.recip_signed) || 0,
  };
}
function mapRecip(r) {
  return {
    id: r.id, email: r.email, name: r.name || "", order_index: Number(r.order_index) || 0,
    role: r.role, status: r.status, color: r.color, viewed_at: Number(r.viewed_at) || 0,
    signed_at: Number(r.signed_at) || 0, decline_reason: r.decline_reason || "",
  };
}
function mapField(f) {
  const out = {
    id: f.id, recipient_id: f.recipient_id, type: f.type, page: Number(f.page),
    x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h),
    required: !!f.required, font_size: Number(f.font_size) || 12,
  };
  // For signers we expose non-signature prefilled values; never leak R2 keys.
  if (f.value && !String(f.value).startsWith("sig/")) out.value = f.value;
  out.signed = !!f.value;
  return out;
}

/* ============================================================
 * Crypto / encoding / misc
 * ============================================================ */
async function hmacSign(env, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.AUTH_SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(sig);
}
async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hashCode(env, email, code) { return sha256Hex((env.AUTH_SECRET || "dev-secret") + "|code|" + email + "|" + code); }
function genCode() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"); }
function uid() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
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
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function safeFilename(s) { return (String(s || "document").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)) || "document"; }
function clamp01(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : (Number.isFinite(v) ? v : 0); }
function clampNum(v, lo, hi) { v = Number(v); if (!Number.isFinite(v)) return lo; return v < lo ? lo : v > hi ? hi : v; }
function clampInt(v, lo, hi) { v = Math.round(Number(v)); if (!Number.isFinite(v)) return lo; return v < lo ? lo : v > hi ? hi : v; }
/* ---- Who may sign in --------------------------------------------------------
 * Two sources, checked in this order:
 *   1. ADMIN_EMAILS secret — the "bootstrap owners". Always allowed, always the
 *      owner role, and never editable from the UI, so an account can never be
 *      locked out of its own service by a bad click.
 *   2. The `users` table — accounts added from the Team screen by an owner.
 *      Roles: "owner" (can manage the team) or "member" (can send documents).
 * -------------------------------------------------------------------------- */
function bootstrapOwners(env) { return String(env.ADMIN_EMAILS || "").split(",").map(normEmail).filter(Boolean); }
function isBootstrapOwner(env, email) { return bootstrapOwners(env).includes(normEmail(email)); }

// Resolve an email to { allowed, role, bootstrap }. Never throws.
async function accessFor(env, email) {
  email = normEmail(email);
  if (!validEmail(email)) return { allowed: false, role: null, bootstrap: false };
  if (isBootstrapOwner(env, email)) return { allowed: true, role: "owner", bootstrap: true };
  try {
    const row = await env.DB.prepare("SELECT role, disabled FROM users WHERE email=?").bind(email).first();
    if (row && !Number(row.disabled)) {
      return { allowed: true, role: row.role === "owner" ? "owner" : "member", bootstrap: false };
    }
  } catch (_) { /* table may not exist on the very first request */ }
  return { allowed: false, role: null, bootstrap: false };
}
function httpError(message, status) { const e = new Error(message); e.status = status; return e; }
async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { return await request.json(); } catch (_) { return {}; } }
  try { const fd = await request.formData(); return Object.fromEntries(fd.entries()); } catch (_) { return {}; }
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function fmtDate(ms) {
  const d = new Date(Number(ms) || Date.now());
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" });
}
function fmtDateTime(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
}

function cors(request, env, res) {
  const allowed = [
    env.ALLOW_ORIGIN || "https://www.linearit.co",
    "https://www.linearit.co",
    "https://cftheitguy.github.io",
    "https://sign.linearit.co",
  ];
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes(origin) ? origin : (env.ALLOW_ORIGIN || "https://www.linearit.co");
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", allow);
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

/* ============================================================
 * Schema — created on first request (no manual migration step)
 * ============================================================ */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS documents (" +
      "id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, title TEXT NOT NULL, message TEXT, " +
      "status TEXT NOT NULL DEFAULT 'draft', ordered INTEGER NOT NULL DEFAULT 0, page_count INTEGER NOT NULL DEFAULT 0, " +
      "orig_key TEXT NOT NULL, signed_key TEXT, orig_hash TEXT, " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER, completed_at INTEGER)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_docs_owner ON documents(owner_email, updated_at)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS recipients (" +
      "id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, order_index INTEGER NOT NULL DEFAULT 0, " +
      "role TEXT NOT NULL DEFAULT 'signer', status TEXT NOT NULL DEFAULT 'pending', token TEXT NOT NULL, color TEXT, " +
      "viewed_at INTEGER DEFAULT 0, signed_at INTEGER DEFAULT 0, decline_reason TEXT)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_recip_doc ON recipients(doc_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_recip_token ON recipients(token)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS fields (" +
      "id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, recipient_id TEXT NOT NULL, type TEXT NOT NULL, " +
      "page INTEGER NOT NULL DEFAULT 1, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, " +
      "required INTEGER NOT NULL DEFAULT 1, font_size REAL NOT NULL DEFAULT 12, value TEXT)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_fields_doc ON fields(doc_id)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS events (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, recipient_id TEXT, type TEXT NOT NULL, " +
      "detail TEXT, ip TEXT, ua TEXT, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_doc ON events(doc_id)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS login_codes (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, " +
      "expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_codes_email ON login_codes(email)"),
    // Accounts added from the Team screen. The ADMIN_EMAILS secret holds the
    // permanent owners and is intentionally NOT mirrored here.
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS users (" +
      "email TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL DEFAULT 'member', " +
      "disabled INTEGER NOT NULL DEFAULT 0, added_by TEXT, " +
      "created_at INTEGER NOT NULL, last_login INTEGER NOT NULL DEFAULT 0)"
    ),
  ]);
  schemaReady = true;
}

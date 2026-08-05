/**
 * Linear Vault — vault.linearit.co
 * =============================================================================
 * Zero-knowledge password manager backend for Linear IT's clients.
 *
 * WHAT "ZERO-KNOWLEDGE" MEANS HERE
 * --------------------------------
 * A client's master password never leaves their browser. The browser uses it to
 * derive an encryption key (PBKDF2) and encrypts every vault entry (AES-256-GCM)
 * BEFORE sending it here. This Worker only ever sees and stores *ciphertext* plus
 * a peppered hash used to authenticate. Nobody with access to this Worker, this
 * database, or Cloudflare can read a client's saved passwords — only the client,
 * with their master password, can. (The trade-off: a forgotten master password
 * cannot be recovered; an admin can only reset the account to empty.)
 *
 * TWO FACTORS TO SIGN IN
 * ----------------------
 *   1. Master password  (something you know — proves you can decrypt the vault)
 *   2. Email MFA code    (something you have — a 6-digit code sent via Resend)
 *
 * WHO CAN HAVE AN ACCOUNT
 * -----------------------
 * Admin-approved only. An email must be on the `clients` allowlist (added by an
 * admin) before it can register. Admins are the addresses in the ADMIN_EMAILS
 * secret; they sign in with email + MFA only (no vault of their own) to manage
 * the client list.
 *
 * ROUTES
 *   Non-/api paths            -> reverse-proxied from the GitHub Pages app
 *                                (APP_ORIGIN + APP_PATH), so vault.linearit.co
 *                                shows the same app as www.linearit.co/vault/.
 *   POST /api/auth/start       -> {authorized, registered, admin, salt?, iters?}
 *   POST /api/auth/code        -> emails a one-time MFA code (register / admin)
 *   POST /api/auth/register    -> create account (approved + not yet registered)
 *   POST /api/auth/login       -> phase 1 (no code): verify master password,
 *                                 email a code, return {mfa:true};
 *                                 phase 2 (with code): -> session token + vault
 *   GET  /api/vault            -> (auth) fetch encrypted vault blob
 *   PUT  /api/vault            -> (auth) save encrypted vault blob (optimistic)
 *   POST /api/account/rekey    -> (auth) change master password (re-wrap key)
 *   POST /api/admin/login      -> admin sign in (email + code)
 *   GET  /api/admin/clients    -> (admin) list allowlisted clients
 *   POST /api/admin/clients    -> (admin) approve an email
 *   DELETE /api/admin/clients  -> (admin) revoke an email (and delete its vault)
 *   POST /api/admin/reset      -> (admin) reset a client to empty (they re-setup)
 *   GET  /api/health           -> "ok"
 *
 * ENV (all secrets except the [vars] in wrangler.toml)
 *   DB               D1 database binding (required)
 *   AUTH_SECRET      long random string — pepper for hashes, signs session tokens
 *   RESEND_API_KEY   send MFA email via Resend  (same key used by linear-chat)
 *   EMAIL_FROM       From: address, e.g.  Linear IT <alert@linearit.co>
 *   ADMIN_EMAILS     comma-separated admin addresses
 *   ALLOW_ORIGIN     CORS origin for the API (default https://www.linearit.co)
 *   APP_ORIGIN       where the app is hosted (default https://www.linearit.co)
 *   APP_PATH         path of the app on that origin (default /vault/)
 *   DEV_MODE = "1"   return the MFA code in the API response (LOCAL TESTING ONLY)
 * =============================================================================
 */

const TOKEN_TTL_MS = 15 * 60 * 1000;   // session token lifetime (sliding; re-issued on each authed call)
const CODE_TTL_MS = 10 * 60 * 1000;    // MFA code lifetime
const CODE_RESEND_MS = 45 * 1000;      // min gap between MFA emails to one address
const MAX_CODE_ATTEMPTS = 5;           // wrong MFA codes before a code is burned
const MAX_PW_FAILS = 8;                // wrong master-password tries before lockout
const PW_LOCK_MS = 15 * 60 * 1000;     // lockout duration after too many pw fails
const DEFAULT_ITERS = 310000;          // PBKDF2 iterations the client should use

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return cors(request, env, new Response(null, { status: 204 }));

    try {
      if (p === "/api/health") return cors(request, env, new Response("ok", { status: 200 }));
      if (p.startsWith("/api/")) {
        return cors(request, env, await handleApi(request, env, url, p, method));
      }
      // Everything else: serve the app by reverse-proxying the GitHub Pages copy.
      return proxyApp(request, env, url, method);
    } catch (err) {
      const status = (err && err.status) || 500;
      return cors(request, env, json({ error: String((err && err.message) || err) }, status));
    }
  },
};

/* ============================================================
 * API router
 * ============================================================ */
async function handleApi(request, env, url, p, method) {
  await ensureSchema(env);

  if (p === "/api/auth/start" && method === "POST") return authStart(request, env);
  if (p === "/api/auth/code" && method === "POST") return authCode(request, env);
  if (p === "/api/auth/register" && method === "POST") return authRegister(request, env);
  if (p === "/api/auth/login" && method === "POST") return authLogin(request, env);

  if (p === "/api/vault" && method === "GET") return vaultGet(request, env);
  if (p === "/api/vault" && method === "PUT") return vaultPut(request, env);
  if (p === "/api/account/rekey" && method === "POST") return accountRekey(request, env);

  if (p === "/api/admin/login" && method === "POST") return adminLogin(request, env);
  if (p === "/api/admin/clients" && method === "GET") return adminListClients(request, env);
  if (p === "/api/admin/clients" && method === "POST") return adminAddClient(request, env);
  if (p === "/api/admin/clients" && method === "DELETE") return adminRemoveClient(request, env);
  if (p === "/api/admin/reset" && method === "POST") return adminResetClient(request, env);

  return json({ error: "Not found" }, 404);
}

/* ============================================================
 * Auth — start (tells the browser which path this email is on)
 * ============================================================ */
async function authStart(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const admin = isAdminEmail(env, email);
  const account = await env.DB.prepare("SELECT salt, iters FROM accounts WHERE email=?").bind(email).first();
  const approved = !!(await env.DB.prepare("SELECT 1 FROM clients WHERE email=?").bind(email).first());

  if (account) {
    // Registered client — return its salt/iters so the browser can derive keys.
    return json({ authorized: true, registered: true, admin, salt: account.salt, iters: Number(account.iters) });
  }
  if (admin) return json({ authorized: true, registered: false, admin: true });
  if (approved) return json({ authorized: true, registered: false, admin: false, iters: DEFAULT_ITERS });
  return json({ authorized: false, registered: false, admin: false });
}

/* ============================================================
 * Auth — send a one-time MFA code by email (purpose-scoped)
 * purpose: "register" (approved, new client) | "admin". Login codes are sent
 * from /api/auth/login instead, only after the master password checks out.
 * ============================================================ */
async function authCode(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  const purpose = String(body.purpose || "").trim();
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (!["register", "admin"].includes(purpose)) return json({ error: "Bad request." }, 400);

  // Authorize the request for the stated purpose before sending anything.
  // (Login sends its own code from /api/auth/login, only after the master
  // password is verified — so a wrong password never triggers an email.)
  const admin = isAdminEmail(env, email);
  const account = await env.DB.prepare("SELECT 1 FROM accounts WHERE email=?").bind(email).first();
  const approved = !!(await env.DB.prepare("SELECT 1 FROM clients WHERE email=?").bind(email).first());

  if (purpose === "admin" && !admin) return json({ error: "This email isn't an administrator." }, 403);
  if (purpose === "register" && !(approved && !account)) {
    if (account) return json({ error: "This email is already set up. Choose sign in instead." }, 409);
    return json({ error: "This email isn't approved yet. Contact Linear IT." }, 403);
  }

  const r = await issueCode(env, email, purpose);
  if (r.error) return json({ error: r.error }, r.status);
  const out = { ok: true };
  if (r.dev_code) out.dev_code = r.dev_code;
  return json(out);
}

// Generate, store (peppered hash) and email a fresh code. Enforces a resend gap.
// Returns { ok:true, dev_code? } or { error, status }.
async function issueCode(env, email, purpose) {
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
    .prepare("INSERT INTO login_codes (email, code_hash, purpose, expires_at, attempts, consumed, created_at) VALUES (?,?,?,?,0,0,?)")
    .bind(email, codeHash, purpose, now + CODE_TTL_MS, now).run();

  const sent = await sendCodeEmail(env, email, code);
  if (env.DEV_MODE === "1") return { ok: true, dev_code: code };
  if (!sent) return { error: "Couldn't send the email — email delivery isn't configured yet.", status: 502 };
  return { ok: true };
}

// Verify (and burn) a fresh MFA code for the given email + purpose.
// Returns { ok:true } or { error, status }.
async function consumeCode(env, email, code, purpose) {
  if (!/^\d{4,8}$/.test(String(code || ""))) return { error: "Invalid code.", status: 400 };
  const now = Date.now();
  const row = await env.DB
    .prepare("SELECT * FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (!row) return { error: "No active code. Request a new one.", status: 400 };
  if (row.purpose !== purpose) return { error: "This code is for a different action.", status: 400 };
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
 * Auth — register (approved email sets its master password)
 * The browser sends only: its chosen salt/iters, an auth verifier (proof of the
 * master password, NOT the key), the DEK wrapped by the master key, and the
 * (empty) encrypted vault. The server stores ciphertext + a peppered hash.
 * ============================================================ */
async function authRegister(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const approved = !!(await env.DB.prepare("SELECT 1 FROM clients WHERE email=?").bind(email).first());
  const exists = await env.DB.prepare("SELECT 1 FROM accounts WHERE email=?").bind(email).first();
  if (!approved) return json({ error: "This email isn't approved yet. Contact Linear IT." }, 403);
  if (exists) return json({ error: "This email is already set up." }, 409);

  const cr = await consumeCode(env, email, body.code, "register");
  if (cr.error) return json({ error: cr.error }, cr.status);

  const salt = String(body.salt || "");
  const iters = Number(body.iters || 0);
  const authVerifier = String(body.auth_verifier || "");
  const wrappedDek = String(body.wrapped_dek || "");
  const vaultBlob = String(body.vault_blob || "");
  if (!isB64(salt) || iters < 100000 || iters > 5000000 || !isB64(authVerifier) ||
      !looksBlob(wrappedDek) || !looksBlob(vaultBlob)) {
    return json({ error: "Malformed setup data." }, 400);
  }

  const now = Date.now();
  const authHash = await hashVerifier(env, email, authVerifier);
  await env.DB.prepare(
    "INSERT INTO accounts (email, salt, iters, auth_hash, wrapped_dek, vault_blob, vault_ver, failed, locked_until, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,1,0,0,?,?)"
  ).bind(email, salt, iters, authHash, wrappedDek, vaultBlob, now, now).run();

  const token = await makeToken(env, { email, kind: "user" });
  return json({ token, vault_ver: 1 });
}

/* ============================================================
 * Auth — login. Two phases against this one endpoint:
 *   Phase 1  {email, auth_verifier}          -> verify master password, then
 *                                               email a code -> {mfa:true}
 *   Phase 2  {email, auth_verifier, code}     -> verify password + code ->
 *                                               session token + ciphertext
 * The master password is always checked first, so a wrong password never emails
 * a code and never burns the client's active code.
 * ============================================================ */
async function authLogin(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  const authVerifier = String(body.auth_verifier || "");
  const hasCode = body.code !== undefined && body.code !== null && String(body.code) !== "";
  if (!validEmail(email) || !isB64(authVerifier)) return json({ error: "Invalid email or password." }, 400);

  const acct = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(email).first();
  if (!acct) return json({ error: "Incorrect email or master password." }, 401);

  const now = Date.now();
  if (Number(acct.locked_until) > now) {
    return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const expect = await hashVerifier(env, email, authVerifier);
  if (!timingSafeEqual(expect, acct.auth_hash)) {
    const failed = Number(acct.failed) + 1;
    const lockUntil = failed >= MAX_PW_FAILS ? now + PW_LOCK_MS : 0;
    await env.DB.prepare("UPDATE accounts SET failed=?, locked_until=? WHERE email=?")
      .bind(failed >= MAX_PW_FAILS ? 0 : failed, lockUntil, email).run();
    return json({ error: "Incorrect email or master password." }, 401);
  }
  // Password is correct — clear the fail counter either way.
  await env.DB.prepare("UPDATE accounts SET failed=0, locked_until=0 WHERE email=?").bind(email).run();

  // Phase 1: no code yet -> send one to the email (2nd factor).
  if (!hasCode) {
    const r = await issueCode(env, email, "login");
    if (r.error) return json({ error: r.error }, r.status);
    const out = { mfa: true };
    if (r.dev_code) out.dev_code = r.dev_code;
    return json(out);
  }

  // Phase 2: verify the emailed code, then hand over the encrypted vault.
  const cr = await consumeCode(env, email, body.code, "login");
  if (cr.error) return json({ error: cr.error }, cr.status);

  const token = await makeToken(env, { email, kind: "user" });
  return json({
    token,
    salt: acct.salt,
    iters: Number(acct.iters),
    wrapped_dek: acct.wrapped_dek,
    vault_blob: acct.vault_blob,
    vault_ver: Number(acct.vault_ver),
  });
}

/* ============================================================
 * Vault — fetch / save encrypted blob (auth required)
 * ============================================================ */
async function vaultGet(request, env) {
  const claims = await requireUser(request, env);
  const acct = await env.DB.prepare("SELECT wrapped_dek, vault_blob, vault_ver FROM accounts WHERE email=?")
    .bind(claims.email).first();
  if (!acct) return json({ error: "Account not found." }, 404);
  return json({
    token: await makeToken(env, { email: claims.email, kind: "user" }),
    wrapped_dek: acct.wrapped_dek,
    vault_blob: acct.vault_blob,
    vault_ver: Number(acct.vault_ver),
  });
}

async function vaultPut(request, env) {
  const claims = await requireUser(request, env);
  const body = await readBody(request);
  const blob = String(body.vault_blob || "");
  const baseVer = Number(body.base_ver);
  if (!looksBlob(blob)) return json({ error: "Malformed vault data." }, 400);
  if (blob.length > 5_000_000) return json({ error: "Vault is too large." }, 413);

  const acct = await env.DB.prepare("SELECT vault_ver FROM accounts WHERE email=?").bind(claims.email).first();
  if (!acct) return json({ error: "Account not found." }, 404);
  if (Number.isFinite(baseVer) && baseVer !== Number(acct.vault_ver)) {
    // Someone saved from another device since this client loaded — avoid clobber.
    return json({ error: "conflict", vault_ver: Number(acct.vault_ver) }, 409);
  }
  const next = Number(acct.vault_ver) + 1;
  await env.DB.prepare("UPDATE accounts SET vault_blob=?, vault_ver=?, updated_at=? WHERE email=?")
    .bind(blob, next, Date.now(), claims.email).run();
  return json({ token: await makeToken(env, { email: claims.email, kind: "user" }), vault_ver: next });
}

/* ============================================================
 * Account — change master password (re-wrap the vault key; no re-encrypt)
 * ============================================================ */
async function accountRekey(request, env) {
  const claims = await requireUser(request, env);
  const body = await readBody(request);
  const salt = String(body.salt || "");
  const iters = Number(body.iters || 0);
  const authVerifier = String(body.auth_verifier || "");
  const wrappedDek = String(body.wrapped_dek || "");
  if (!isB64(salt) || iters < 100000 || iters > 5000000 || !isB64(authVerifier) || !looksBlob(wrappedDek)) {
    return json({ error: "Malformed data." }, 400);
  }
  const authHash = await hashVerifier(env, claims.email, authVerifier);
  const res = await env.DB.prepare(
    "UPDATE accounts SET salt=?, iters=?, auth_hash=?, wrapped_dek=?, failed=0, locked_until=0, updated_at=? WHERE email=?"
  ).bind(salt, iters, authHash, wrappedDek, Date.now(), claims.email).run();
  if (!res.meta || res.meta.changes === 0) return json({ error: "Account not found." }, 404);
  return json({ token: await makeToken(env, { email: claims.email, kind: "user" }), ok: true });
}

/* ============================================================
 * Admin — sign in (email + MFA only) and manage the client allowlist
 * ============================================================ */
async function adminLogin(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!isAdminEmail(env, email)) return json({ error: "This email isn't an administrator." }, 403);
  const cr = await consumeCode(env, email, body.code, "admin");
  if (cr.error) return json({ error: cr.error }, cr.status);
  const token = await makeToken(env, { email, kind: "admin" });
  return json({ token });
}

async function adminListClients(request, env) {
  const claims = await requireAdmin(request, env);
  const rows = (await env.DB.prepare(
    "SELECT c.email AS email, c.created_at AS created_at, " +
    "(SELECT 1 FROM accounts a WHERE a.email=c.email) AS registered, " +
    "(SELECT updated_at FROM accounts a WHERE a.email=c.email) AS last_saved " +
    "FROM clients c ORDER BY c.email"
  ).all()).results || [];
  const clients = rows.map((r) => ({
    email: r.email,
    registered: !!r.registered,
    created_at: Number(r.created_at) || 0,
    last_saved: Number(r.last_saved) || 0,
  }));
  return json({ token: await makeToken(env, { email: claims.email, kind: "admin" }), clients });
}

async function adminAddClient(request, env) {
  const claims = await requireAdmin(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  await env.DB.prepare("INSERT OR IGNORE INTO clients (email, added_by, created_at) VALUES (?,?,?)")
    .bind(email, claims.email, Date.now()).run();
  return json({ token: await makeToken(env, { email: claims.email, kind: "admin" }), ok: true });
}

async function adminRemoveClient(request, env) {
  const claims = await requireAdmin(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  // Revoke = remove from allowlist AND delete their (encrypted) vault entirely.
  await env.DB.prepare("DELETE FROM accounts WHERE email=?").bind(email).run();
  await env.DB.prepare("DELETE FROM clients WHERE email=?").bind(email).run();
  await env.DB.prepare("DELETE FROM login_codes WHERE email=?").bind(email).run();
  return json({ token: await makeToken(env, { email: claims.email, kind: "admin" }), ok: true });
}

async function adminResetClient(request, env) {
  const claims = await requireAdmin(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  // Reset = delete the account (encrypted vault) but keep them on the allowlist,
  // so the client can set a brand-new master password and start fresh.
  await env.DB.prepare("DELETE FROM accounts WHERE email=?").bind(email).run();
  await env.DB.prepare("DELETE FROM login_codes WHERE email=?").bind(email).run();
  return json({ token: await makeToken(env, { email: claims.email, kind: "admin" }), ok: true });
}

/* ============================================================
 * Auth token helpers (HMAC-signed, sliding expiry)
 * ============================================================ */
async function requireUser(request, env) {
  const c = await authClaims(request, env);
  if (!c || c.kind !== "user") throw httpError("Please sign in again.", 401);
  return c;
}
async function requireAdmin(request, env) {
  const c = await authClaims(request, env);
  if (!c || c.kind !== "admin" || !isAdminEmail(env, c.email)) throw httpError("Admin sign-in required.", 401);
  return c;
}
async function makeToken(env, claims) {
  const payload = b64urlStr(JSON.stringify(Object.assign({ exp: Date.now() + TOKEN_TTL_MS }, claims)));
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

/* ============================================================
 * Crypto / encoding
 * ============================================================ */
async function hmacSign(env, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.AUTH_SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(sig);
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Peppered hash of an emailed code (so a DB leak doesn't reveal live codes).
function hashCode(env, email, code) {
  return sha256Hex((env.AUTH_SECRET || "dev-secret") + "|code|" + email + "|" + code);
}
// Peppered hash of the master-password auth verifier (never store it raw).
function hashVerifier(env, email, verifier) {
  return sha256Hex((env.AUTH_SECRET || "dev-secret") + "|verify|" + email + "|" + verifier);
}
function genCode() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"); }
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

/* ============================================================
 * Email (Resend) — same provider linear-chat uses
 * ============================================================ */
async function sendCodeEmail(env, email, code) {
  return sendEmail(env, {
    to: email,
    subject: "Your Linear IT vault code: " + code,
    text: "Your Linear IT password vault verification code is " + code +
      "\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.",
    html: codeEmailHtml(code),
  });
}
function codeEmailHtml(code) {
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:440px;margin:auto;padding:24px">' +
    '<h2 style="margin:0 0 4px;color:#111">Linear IT — Password Vault</h2>' +
    '<p style="color:#444;margin:0 0 16px">Use this code to finish signing in:</p>' +
    '<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center;color:#111">' + code + "</div>" +
    '<p style="color:#888;font-size:13px;margin:16px 0 0">This code expires in 10 minutes. If you didn\'t request it, you can ignore this email — your vault stays locked.</p>' +
    '<p style="color:#aab;font-size:12px;margin:14px 0 0">Linear IT · (845) 604-1462</p>' +
    "</div>";
}
async function sendEmail(env, msg) {
  try {
    if (env.RESEND_API_KEY) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.EMAIL_FROM || "Linear IT <alert@linearit.co>",
          to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
        }),
      });
      return res.ok;
    }
  } catch (_) { /* fall through */ }
  return false;
}

/* ============================================================
 * Reverse-proxy the app from GitHub Pages (so vault.linearit.co serves it)
 * ============================================================ */
async function proxyApp(request, env, url, method) {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/vault/";
  const path = url.pathname === "/" ? appPath : url.pathname;
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
    return new Response("Vault is briefly unavailable. Please try again in a moment.", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "20" },
    });
  }
  if (originResp.status === 404) return new Response("Not found", { status: 404 });

  const headers = new Headers(originResp.headers);
  headers.delete("set-cookie");
  headers.delete("transfer-encoding");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store, must-revalidate");
  headers.set("X-Served-By", "linear-vault");
  const body = method === "HEAD" ? null : originResp.body;
  return new Response(body, { status: originResp.status, statusText: originResp.statusText, headers });
}

/* ============================================================
 * Small helpers
 * ============================================================ */
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function isB64(s) { return typeof s === "string" && s.length > 0 && s.length < 100000 && /^[A-Za-z0-9+/=_-]+$/.test(s); }
// An encrypted blob is transported as a compact JSON string {"iv":"..","ct":".."}.
function looksBlob(s) {
  if (typeof s !== "string" || s.length < 2 || s.length > 6_000_000) return false;
  try { const o = JSON.parse(s); return !!o && typeof o.iv === "string" && typeof o.ct === "string"; }
  catch (_) { return false; }
}
function adminEmailSet(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((e) => normEmail(e)).filter(Boolean);
}
function isAdminEmail(env, email) { return adminEmailSet(env).includes(normEmail(email)); }
function httpError(message, status) { const e = new Error(message); e.status = status; return e; }
async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { return await request.json(); } catch (_) { return {}; } }
  try { const fd = await request.formData(); return Object.fromEntries(fd.entries()); } catch (_) { return {}; }
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// CORS: allow the GitHub Pages app origin (and same-origin vault.linearit.co).
function cors(request, env, res) {
  const allowed = [
    env.ALLOW_ORIGIN || "https://www.linearit.co",
    "https://www.linearit.co",
    "https://cftheitguy.github.io",
    "https://vault.linearit.co",
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
      "CREATE TABLE IF NOT EXISTS clients (" +
      "email TEXT PRIMARY KEY, added_by TEXT, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS accounts (" +
      "email TEXT PRIMARY KEY, salt TEXT NOT NULL, iters INTEGER NOT NULL, auth_hash TEXT NOT NULL, " +
      "wrapped_dek TEXT NOT NULL, vault_blob TEXT, vault_ver INTEGER NOT NULL DEFAULT 0, " +
      "failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS login_codes (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, " +
      "purpose TEXT NOT NULL DEFAULT 'login', expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, " +
      "consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_codes_email ON login_codes(email)"),
  ]);
  schemaReady = true;
}

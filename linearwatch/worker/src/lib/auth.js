// Higher-level auth: dashboard sessions, agent device-token resolution, RBAC,
// and short-lived signed view-URL sign/verify.

import { unauthorized, forbidden, bearer } from "./http.js";
import { randomToken, sha256Hex, hmacSign, hmacVerify, newId } from "./crypto.js";
import { nowIso } from "./db.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h dashboard session

// ---- Dashboard sessions -----------------------------------------------------
export async function createSession(env, user, userAgent = "") {
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString().replace(/\.\d+Z$/, "Z");
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, org_id, expires_at, user_agent) VALUES (?,?,?,?,?)",
  )
    .bind(id, user.id, user.org_id, expires, (userAgent || "").slice(0, 256))
    .run();
  return { token: id, expires_at: expires };
}

// Resolve the caller's session → { session, user }. Throws 401 if missing/expired.
export async function requireSession(env, request) {
  const token = bearer(request);
  if (!token) throw unauthorized("Missing session token");
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(token).first();
  if (!session) throw unauthorized("Invalid session");
  if (session.expires_at <= nowIso()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
    throw unauthorized("Session expired");
  }
  const user = await env.DB.prepare(
    "SELECT id, org_id, email, role, created_at FROM users WHERE id = ?",
  )
    .bind(session.user_id)
    .first();
  if (!user) throw unauthorized("User not found");
  return { session, user };
}

export async function destroySession(env, token) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
}

const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
// Require at least the given role. owner > admin > viewer.
export function requireRole(user, minRole) {
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[minRole] || 99)) {
    throw forbidden(`Requires ${minRole} role`);
  }
}

// ---- Agent device tokens ----------------------------------------------------
// Accept the device token via X-Device-Token (preferred) or Authorization: Bearer.
export function deviceTokenFrom(request) {
  return (request.headers.get("X-Device-Token") || bearer(request) || "").trim();
}

// Resolve an active device from its token. Throws 401 if unknown/revoked.
export async function requireDevice(env, request) {
  const token = deviceTokenFrom(request);
  if (!token) throw unauthorized("Missing device token");
  const hash = await sha256Hex(token);
  const device = await env.DB.prepare(
    "SELECT * FROM devices WHERE agent_token_hash = ?",
  )
    .bind(hash)
    .first();
  if (!device || device.revoked_at) throw unauthorized("Invalid or revoked device token");
  return device;
}

export async function hashDeviceToken(token) {
  return sha256Hex(token);
}
export function newDeviceToken() {
  // Prefix makes it recognizable in logs/support; body is 256 bits of entropy.
  return "lwd_" + randomToken(32);
}

// ---- Signed view URLs -------------------------------------------------------
// A signed URL is `${origin}/v1/view?id=<shotId>&v=<variant>&exp=<ms>&sig=<hmac>`
// where sig = HMAC(SIGNING_SECRET, "id|variant|exp"). Self-authenticating so an
// <img> tag can load it without an Authorization header; expires quickly.
export async function signViewUrl(env, origin, shotId, variant, ttlSeconds) {
  const exp = Date.now() + ttlSeconds * 1000;
  const sig = await hmacSign(env.SIGNING_SECRET, `${shotId}|${variant}|${exp}`);
  const u = new URL("/v1/view", origin);
  u.searchParams.set("id", shotId);
  u.searchParams.set("v", variant);
  u.searchParams.set("exp", String(exp));
  u.searchParams.set("sig", sig);
  return u.toString();
}

export async function verifyViewSig(env, shotId, variant, exp, sig) {
  const expMs = parseInt(exp, 10);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  if (!shotId || !variant || !sig) return false;
  return hmacVerify(env.SIGNING_SECRET, `${shotId}|${variant}|${expMs}`, sig);
}

export { newId };

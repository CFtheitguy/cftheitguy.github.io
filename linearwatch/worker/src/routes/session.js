// Dashboard auth: email/password login -> revocable bearer session.

import { json, bad, unauthorized, readJson } from "../lib/http.js";
import { audit } from "../lib/db.js";
import { verifyPassword } from "../lib/crypto.js";
import { createSession, requireSession, destroySession } from "../lib/auth.js";
import { bearer } from "../lib/http.js";

async function orgOf(env, orgId) {
  return env.DB.prepare(
    "SELECT id, name, retention_days, capture_interval_seconds, created_at FROM organizations WHERE id = ?",
  )
    .bind(orgId)
    .first();
}

// POST /v1/auth/login
export async function login(request, env, ctx) {
  const { email, password } = await readJson(request);
  const em = String(email || "").trim().toLowerCase();
  if (!em || !password) throw bad("email and password are required");

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(em).first();
  // Always run a verify to keep timing uniform whether or not the user exists.
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, "pbkdf2$sha256$1$AAAA$AAAA");
  if (!user || !ok) throw unauthorized("Invalid email or password");

  const { token, expires_at } = await createSession(env, user, request.headers.get("User-Agent") || "");
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "auth.login", target: user.email }));
  return json({
    token,
    expires_at,
    user: { id: user.id, email: user.email, role: user.role, org_id: user.org_id },
    org: await orgOf(env, user.org_id),
  });
}

// POST /v1/auth/logout
export async function logout(request, env) {
  const token = bearer(request);
  if (token) await destroySession(env, token);
  return json({ ok: true });
}

// GET /v1/auth/me
export async function me(request, env) {
  const { user } = await requireSession(env, request);
  return json({
    user: { id: user.id, email: user.email, role: user.role, org_id: user.org_id },
    org: await orgOf(env, user.org_id),
  });
}

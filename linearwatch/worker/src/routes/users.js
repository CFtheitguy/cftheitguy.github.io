// Dashboard: user & role management. Org-scoped; admin+ to manage. Owner role is
// special — only an owner may grant/revoke owner, and the last owner is protected.

import { json, bad, notFound, forbidden, readJson } from "../lib/http.js";
import { audit } from "../lib/db.js";
import { newId, hashPassword } from "../lib/crypto.js";
import { requireSession, requireRole } from "../lib/auth.js";

const ROLES = ["owner", "admin", "viewer"];

async function ownerCount(env, orgId) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'owner'")
    .bind(orgId)
    .first();
  return r?.n || 0;
}

// GET /v1/users  (admin+)
export async function listUsers(request, env) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const rows = await env.DB.prepare(
    "SELECT id, email, role, created_at FROM users WHERE org_id = ? ORDER BY created_at ASC",
  )
    .bind(user.org_id)
    .all();
  return json({ users: rows.results || [] });
}

// POST /v1/users  (admin+)  body: { email, password, role }
export async function createUser(request, env, ctx) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const role = String(body.role || "viewer");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("A valid email is required");
  if (!ROLES.includes(role)) throw bad("role must be owner, admin, or viewer");
  if (role === "owner") requireRole(user, "owner"); // only an owner can mint an owner
  if (!body.password || String(body.password).length < 8) throw bad("Password must be at least 8 characters");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) throw bad("A user with that email already exists");

  const id = newId();
  const hash = await hashPassword(String(body.password));
  await env.DB.prepare("INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?,?,?,?,?)")
    .bind(id, user.org_id, email, role, hash)
    .run();
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "user.create", target: email, detail: role }));
  return json({ user: { id, email, role, org_id: user.org_id } }, 201);
}

// PATCH /v1/users/:id  (admin+)  body: { role?, password? }
export async function updateUser(request, env, ctx, targetId) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const target = await env.DB.prepare("SELECT id, email, role FROM users WHERE id = ? AND org_id = ?")
    .bind(targetId, user.org_id)
    .first();
  if (!target) throw notFound("User not found");
  const body = await readJson(request);

  const sets = [];
  const binds = [];
  if (body.role != null && body.role !== target.role) {
    if (!ROLES.includes(body.role)) throw bad("role must be owner, admin, or viewer");
    // Only an owner can change owner status (grant or revoke).
    if (body.role === "owner" || target.role === "owner") requireRole(user, "owner");
    // Don't strip the last owner.
    if (target.role === "owner" && body.role !== "owner" && (await ownerCount(env, user.org_id)) <= 1) {
      throw forbidden("Cannot remove the last owner");
    }
    sets.push("role = ?");
    binds.push(body.role);
  }
  if (body.password != null) {
    if (String(body.password).length < 8) throw bad("Password must be at least 8 characters");
    sets.push("password_hash = ?");
    binds.push(await hashPassword(String(body.password)));
  }
  if (!sets.length) throw bad("Nothing to update");

  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`)
    .bind(...binds, targetId, user.org_id)
    .run();
  // A password/role change invalidates existing sessions for that user.
  if (body.password != null || body.role != null) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(targetId).run();
  }
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "user.update", target: target.email, detail: JSON.stringify(Object.keys(body)) }));
  return json({ ok: true });
}

// DELETE /v1/users/:id  (admin+)
export async function deleteUser(request, env, ctx, targetId) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const target = await env.DB.prepare("SELECT id, email, role FROM users WHERE id = ? AND org_id = ?")
    .bind(targetId, user.org_id)
    .first();
  if (!target) throw notFound("User not found");
  if (target.role === "owner" && (await ownerCount(env, user.org_id)) <= 1) {
    throw forbidden("Cannot delete the last owner");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(targetId),
    env.DB.prepare("DELETE FROM users WHERE id = ? AND org_id = ?").bind(targetId, user.org_id),
  ]);
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "user.delete", target: target.email }));
  return json({ ok: true });
}

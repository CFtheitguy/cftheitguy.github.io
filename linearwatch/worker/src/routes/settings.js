// Dashboard: org settings, enrollment codes, audit log. All org-scoped; mutations
// require admin+.

import { json, bad, notFound, readJson } from "../lib/http.js";
import { audit } from "../lib/db.js";
import { newId, enrollmentCode } from "../lib/crypto.js";
import { requireSession, requireRole } from "../lib/auth.js";

// GET /v1/settings  -> org config + active enrollment codes
export async function getSettings(request, env) {
  const { user } = await requireSession(env, request);
  const org = await env.DB.prepare(
    "SELECT id, name, retention_days, capture_interval_seconds, created_at FROM organizations WHERE id = ?",
  )
    .bind(user.org_id)
    .first();
  const codes = await env.DB.prepare(
    `SELECT id, code, label, created_at, expires_at, max_uses, uses, revoked_at
       FROM enrollment_codes WHERE org_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.org_id)
    .all();
  return json({ org, enrollment_codes: codes.results || [] });
}

// PATCH /v1/settings  (admin+)
export async function updateSettings(request, env, ctx) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const body = await readJson(request);

  const fields = [];
  const binds = [];
  if (body.name != null) {
    const name = String(body.name).trim().slice(0, 200);
    if (!name) throw bad("name cannot be empty");
    fields.push("name = ?");
    binds.push(name);
  }
  if (body.capture_interval_seconds != null) {
    const n = parseInt(body.capture_interval_seconds, 10);
    if (!Number.isFinite(n) || n < 15 || n > 3600) throw bad("capture_interval_seconds must be 15–3600");
    fields.push("capture_interval_seconds = ?");
    binds.push(n);
  }
  if (body.retention_days != null) {
    const n = parseInt(body.retention_days, 10);
    if (!Number.isFinite(n) || n < 1 || n > 365) throw bad("retention_days must be 1–365");
    fields.push("retention_days = ?");
    binds.push(n);
  }
  if (!fields.length) throw bad("No valid settings to update");

  await env.DB.prepare(`UPDATE organizations SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...binds, user.org_id)
    .run();
  ctx.waitUntil(
    audit(env, { orgId: user.org_id, actorUserId: user.id, action: "settings.update", detail: JSON.stringify(body) }),
  );
  const org = await env.DB.prepare(
    "SELECT id, name, retention_days, capture_interval_seconds, created_at FROM organizations WHERE id = ?",
  )
    .bind(user.org_id)
    .first();
  return json({ org });
}

// POST /v1/enrollment-codes  (admin+)  body: { label?, expires_at?, max_uses? }
export async function createEnrollmentCode(request, env, ctx) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const body = await readJson(request);
  const id = newId();
  const code = enrollmentCode();
  const label = body.label ? String(body.label).slice(0, 120) : null;
  const maxUses = body.max_uses != null ? Math.max(1, parseInt(body.max_uses, 10) || 1) : null;
  const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null;

  await env.DB.prepare(
    "INSERT INTO enrollment_codes (id, org_id, code, label, created_by, expires_at, max_uses) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(id, user.org_id, code, label, user.id, expiresAt, maxUses)
    .run();
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "enroll_code.create", target: code }));
  return json({ id, code, label, expires_at: expiresAt, max_uses: maxUses, uses: 0 }, 201);
}

// POST /v1/enrollment-codes/:id/revoke  (admin+)
export async function revokeEnrollmentCode(request, env, ctx, codeId) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const row = await env.DB.prepare("SELECT id FROM enrollment_codes WHERE id = ? AND org_id = ?")
    .bind(codeId, user.org_id)
    .first();
  if (!row) throw notFound("Enrollment code not found");
  await env.DB.prepare("UPDATE enrollment_codes SET revoked_at = datetime('now') WHERE id = ? AND org_id = ?")
    .bind(codeId, user.org_id)
    .run();
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "enroll_code.revoke", target: codeId }));
  return json({ ok: true });
}

// GET /v1/audit?limit=  (admin+)
export async function listAudit(request, env, url) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 100));
  const rows = await env.DB.prepare(
    `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.target, a.detail, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(user.org_id, limit)
    .all();
  return json({ audit: rows.results || [] });
}

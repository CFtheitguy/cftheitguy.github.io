// Provisioning: create a new org + its first owner + an initial enrollment code.
// Guarded by the BOOTSTRAP_SECRET (sent as X-Bootstrap-Secret). This is how a new
// customer/tenant is stood up (and how local dev seeds test data).

import { json, bad, forbidden, readJson } from "../lib/http.js";
import { audit } from "../lib/db.js";
import { newId, hashPassword, enrollmentCode, timingSafeEqual } from "../lib/crypto.js";

// POST /v1/bootstrap
export async function bootstrap(request, env, ctx) {
  const secret = env.BOOTSTRAP_SECRET;
  if (!secret) throw forbidden("Provisioning is disabled (BOOTSTRAP_SECRET not set)");
  const provided = request.headers.get("X-Bootstrap-Secret") || "";
  if (!timingSafeEqual(provided, secret)) throw forbidden("Invalid bootstrap secret");

  const body = await readJson(request);
  const orgName = String(body.org_name || "").trim().slice(0, 200);
  const ownerEmail = String(body.owner_email || "").trim().toLowerCase();
  const ownerPassword = String(body.owner_password || "");
  if (!orgName) throw bad("org_name is required");
  if (!ownerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) throw bad("A valid owner_email is required");
  if (ownerPassword.length < 8) throw bad("owner_password must be at least 8 characters");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(ownerEmail).first();
  if (existing) throw bad("A user with that email already exists");

  const interval = Math.min(3600, Math.max(15, parseInt(body.capture_interval_seconds, 10) || 120));
  const retention = Math.min(365, Math.max(1, parseInt(body.retention_days, 10) || 30));

  const orgId = newId();
  const userId = newId();
  const codeId = newId();
  const code = enrollmentCode();
  const hash = await hashPassword(ownerPassword);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, retention_days, capture_interval_seconds) VALUES (?,?,?,?)",
    ).bind(orgId, orgName, retention, interval),
    env.DB.prepare("INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?,?,?,?,?)").bind(
      userId,
      orgId,
      ownerEmail,
      "owner",
      hash,
    ),
    env.DB.prepare(
      "INSERT INTO enrollment_codes (id, org_id, code, label, created_by) VALUES (?,?,?,?,?)",
    ).bind(codeId, orgId, code, "Initial enrollment code", userId),
  ]);

  ctx.waitUntil(audit(env, { orgId, actorUserId: userId, action: "org.bootstrap", target: orgName }));
  return json(
    {
      org: { id: orgId, name: orgName, capture_interval_seconds: interval, retention_days: retention },
      owner: { id: userId, email: ownerEmail, role: "owner" },
      enrollment_code: code,
    },
    201,
  );
}

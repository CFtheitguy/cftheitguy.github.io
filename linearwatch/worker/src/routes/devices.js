// Dashboard: devices, per-device screenshot timeline, signed viewing.
// EVERY query is scoped to the caller's session org_id — a user can never read
// another org's rows (the org_id always comes from the session, never the URL).

import { json, bad, notFound, forbidden } from "../lib/http.js";
import { audit } from "../lib/db.js";
import { requireSession, requireRole, signViewUrl, verifyViewSig } from "../lib/auth.js";

const THUMB_TTL = 1800; // 30 min — used inline in the grid
const FULL_TTL = 300; // 5 min — issued per click

// Normalize a `from`/`to` query value into an ISO boundary for string compare.
function dayBoundary(value, end) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return end ? `${v}T23:59:59Z` : `${v}T00:00:00Z`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// GET /v1/devices
export async function listDevices(request, env) {
  const { user } = await requireSession(env, request);
  const rows = await env.DB.prepare(
    `SELECT d.id, d.hostname, d.monitored_username, d.consent_acknowledged_at,
            d.enrolled_at, d.last_seen_at, d.revoked_at, d.paused_reason, d.paused_at,
            (SELECT COUNT(*) FROM screenshots s WHERE s.device_id = d.id) AS screenshot_count,
            (SELECT MAX(captured_at) FROM screenshots s WHERE s.device_id = d.id) AS last_capture_at
       FROM devices d
      WHERE d.org_id = ?
      ORDER BY d.last_seen_at DESC NULLS LAST, d.enrolled_at DESC`,
  )
    .bind(user.org_id)
    .all();
  return json({ devices: rows.results || [] });
}

// GET /v1/devices/:id
export async function getDevice(request, env, deviceId) {
  const { user } = await requireSession(env, request);
  const device = await env.DB.prepare(
    "SELECT id, hostname, monitored_username, consent_acknowledged_at, enrolled_at, last_seen_at, revoked_at, paused_reason, paused_at FROM devices WHERE id = ? AND org_id = ?",
  )
    .bind(deviceId, user.org_id)
    .first();
  if (!device) throw notFound("Device not found");
  return json({ device });
}

// POST /v1/devices/:id/revoke  (admin+)
export async function revokeDevice(request, env, ctx, deviceId) {
  const { user } = await requireSession(env, request);
  requireRole(user, "admin");
  const device = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND org_id = ?")
    .bind(deviceId, user.org_id)
    .first();
  if (!device) throw notFound("Device not found");
  await env.DB.prepare(
    "UPDATE devices SET revoked_at = datetime('now'), agent_token_hash = NULL WHERE id = ? AND org_id = ?",
  )
    .bind(deviceId, user.org_id)
    .run();
  ctx.waitUntil(audit(env, { orgId: user.org_id, actorUserId: user.id, action: "device.revoke", target: deviceId }));
  return json({ ok: true });
}

// GET /v1/devices/:id/screenshots?from=&to=&limit=&before=
export async function listScreenshots(request, env, deviceId, url) {
  const { user } = await requireSession(env, request);
  const device = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND org_id = ?")
    .bind(deviceId, user.org_id)
    .first();
  if (!device) throw notFound("Device not found");

  const from = dayBoundary(url.searchParams.get("from"), false);
  const to = dayBoundary(url.searchParams.get("to"), true);
  const before = url.searchParams.get("before"); // captured_at cursor for paging
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 200));

  const clauses = ["org_id = ?", "device_id = ?"];
  const binds = [user.org_id, deviceId];
  if (from) { clauses.push("captured_at >= ?"); binds.push(from); }
  if (to) { clauses.push("captured_at <= ?"); binds.push(to); }
  if (before) { clauses.push("captured_at < ?"); binds.push(before); }

  const rows = await env.DB.prepare(
    `SELECT id, captured_at, received_at, width, height, bytes, content_type
       FROM screenshots WHERE ${clauses.join(" AND ")}
      ORDER BY captured_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all();

  const origin = new URL(request.url).origin;
  const items = await Promise.all(
    (rows.results || []).map(async (s) => ({
      ...s,
      thumb_url: await signViewUrl(env, origin, s.id, "thumb", THUMB_TTL),
    })),
  );
  const nextCursor = items.length === limit ? items[items.length - 1].captured_at : null;
  return json({ screenshots: items, next_cursor: nextCursor });
}

// GET /v1/screenshots/:id/full-url  — issues a short-lived signed URL + audits the view.
export async function screenshotFullUrl(request, env, ctx, shotId) {
  const { user } = await requireSession(env, request);
  const shot = await env.DB.prepare("SELECT id, device_id FROM screenshots WHERE id = ? AND org_id = ?")
    .bind(shotId, user.org_id)
    .first();
  if (!shot) throw notFound("Screenshot not found");
  const origin = new URL(request.url).origin;
  const url = await signViewUrl(env, origin, shotId, "full", FULL_TTL);
  ctx.waitUntil(
    audit(env, { orgId: user.org_id, actorUserId: user.id, action: "screenshot.view", target: shotId, detail: shot.device_id }),
  );
  return json({ url, expires_in: FULL_TTL });
}

// GET /v1/view?id=&v=&exp=&sig=  — self-authenticating; streams bytes from R2.
// No session here: an <img> can't send Authorization. The HMAC signature + short
// expiry are the auth. We still confirm the row exists to resolve the R2 key.
export async function viewObject(request, env, url) {
  const id = url.searchParams.get("id");
  const variant = url.searchParams.get("v") === "full" ? "full" : "thumb";
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!(await verifyViewSig(env, id, variant, exp, sig))) throw forbidden("Invalid or expired link");

  const shot = await env.DB.prepare("SELECT r2_key, thumb_r2_key, content_type FROM screenshots WHERE id = ?")
    .bind(id)
    .first();
  if (!shot) throw notFound("Screenshot not found");

  const key = variant === "full" ? shot.r2_key : shot.thumb_r2_key || shot.r2_key;
  const obj = await env.SHOTS.get(key);
  if (!obj) throw notFound("Image bytes not found");

  const headers = new Headers();
  headers.set("Content-Type", obj.httpMetadata?.contentType || (variant === "thumb" ? "image/jpeg" : shot.content_type) || "application/octet-stream");
  headers.set("Cache-Control", `private, max-age=${variant === "full" ? FULL_TTL : THUMB_TTL}`);
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { status: 200, headers });
}

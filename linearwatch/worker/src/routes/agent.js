// Agent (device) endpoints — authenticated by per-device token, never a session.
//   POST /v1/agent/enroll       join an org with an enrollment code -> device token
//   POST /v1/agent/consent      report that the monitored user acknowledged consent
//   GET  /v1/agent/config       fetch capture interval + monitoring state (heartbeat)
//   POST /v1/agent/screenshots  upload a frame (original + thumbnail) -> R2 + D1

import { json, bad, tooMany, HttpError } from "../lib/http.js";
import { nowIso, audit } from "../lib/db.js";
import { newId, newDeviceToken, hashDeviceToken, requireDevice } from "../lib/auth.js";
import { sniffImageType, imageDimensions, makeThumbnail, extForType } from "../lib/images.js";

// ---- POST /v1/agent/enroll --------------------------------------------------
export async function enroll(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || "").trim();
  const hostname = String(body.hostname || "").trim().slice(0, 200);
  const monitoredUsername = String(body.monitored_username || "").trim().slice(0, 200);
  if (!code) throw bad("Enrollment code is required");
  if (!hostname) throw bad("hostname is required");
  if (!monitoredUsername) throw bad("monitored_username is required");

  const row = await env.DB.prepare("SELECT * FROM enrollment_codes WHERE code = ?").bind(code).first();
  if (!row || row.revoked_at) throw bad("Invalid enrollment code");
  if (row.expires_at && row.expires_at <= nowIso()) throw bad("Enrollment code has expired");
  if (row.max_uses != null && row.uses >= row.max_uses) throw bad("Enrollment code has no uses remaining");

  const org = await env.DB.prepare(
    "SELECT id, name, capture_interval_seconds, retention_days FROM organizations WHERE id = ?",
  )
    .bind(row.org_id)
    .first();
  if (!org) throw bad("Organization not found for this code");

  const deviceId = newId();
  const token = newDeviceToken();
  const tokenHash = await hashDeviceToken(token);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO devices (id, org_id, hostname, monitored_username, agent_token_hash) VALUES (?,?,?,?,?)",
    ).bind(deviceId, org.id, hostname, monitoredUsername, tokenHash),
    env.DB.prepare("UPDATE enrollment_codes SET uses = uses + 1 WHERE id = ?").bind(row.id),
  ]);

  ctx.waitUntil(
    audit(env, { orgId: org.id, action: "device.enroll", target: deviceId, detail: hostname }),
  );

  // The plaintext token is returned exactly once; the agent must store it securely.
  return json({
    device_id: deviceId,
    device_token: token,
    org: { id: org.id, name: org.name },
    capture_interval_seconds: org.capture_interval_seconds,
    consent: {
      org_name: org.name,
      what_is_captured:
        "Periodic screenshots of this device's full screen are captured and uploaded to your employer's LinearWatch dashboard.",
      retention_days: org.retention_days,
      notice:
        "This device is monitored. A tray indicator stays visible while monitoring is active. Continuing constitutes acknowledgment.",
    },
  });
}

// ---- POST /v1/agent/consent -------------------------------------------------
export async function reportConsent(request, env, ctx) {
  const device = await requireDevice(env, request);
  const ts = nowIso();
  await env.DB.prepare(
    "UPDATE devices SET consent_acknowledged_at = COALESCE(consent_acknowledged_at, ?), last_seen_at = ? WHERE id = ?",
  )
    .bind(ts, ts, device.id)
    .run();
  ctx.waitUntil(
    audit(env, { orgId: device.org_id, action: "device.consent", target: device.id }),
  );
  return json({ ok: true, consent_acknowledged_at: device.consent_acknowledged_at || ts });
}

// ---- GET /v1/agent/config ---------------------------------------------------
// Heartbeat: agent polls for the current interval and monitoring state.
export async function agentConfig(request, env) {
  const device = await requireDevice(env, request);
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(nowIso(), device.id).run();
  const org = await env.DB.prepare(
    "SELECT name, capture_interval_seconds FROM organizations WHERE id = ?",
  )
    .bind(device.org_id)
    .first();
  return json({
    org_name: org?.name || "",
    capture_interval_seconds: org?.capture_interval_seconds ?? 120,
    consent_acknowledged: !!device.consent_acknowledged_at,
    monitoring: !device.revoked_at,
  });
}

// ---- POST /v1/agent/screenshots ---------------------------------------------
export async function ingestScreenshot(request, env, ctx) {
  const device = await requireDevice(env, request);

  const maxBytes = (parseInt(env.MAX_UPLOAD_MB, 10) || 12) * 1024 * 1024;
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength && contentLength > maxBytes + 1024 * 1024) throw new HttpError(413, "Upload too large");

  // Rate limit: reject frames arriving faster than half the org's capture interval.
  const org = await env.DB.prepare(
    "SELECT capture_interval_seconds, retention_days FROM organizations WHERE id = ?",
  )
    .bind(device.org_id)
    .first();
  const interval = org?.capture_interval_seconds ?? 120;
  const minGapSec = Math.max(3, Math.floor(interval * 0.5));
  const last = await env.DB.prepare(
    "SELECT received_at FROM screenshots WHERE device_id = ? ORDER BY received_at DESC LIMIT 1",
  )
    .bind(device.id)
    .first();
  if (last && Date.now() - Date.parse(last.received_at) < minGapSec * 1000) {
    throw tooMany(`Slow down: minimum ${minGapSec}s between frames`);
  }

  // Per-org daily volume cap (abuse guard).
  const ORG_DAILY_CAP = 20000;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const cnt = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM screenshots WHERE org_id = ? AND received_at > ?",
  )
    .bind(device.org_id, since)
    .first();
  if ((cnt?.n || 0) >= ORG_DAILY_CAP) throw tooMany("Daily capture quota reached for this organization");

  const form = await request.formData().catch(() => null);
  if (!form) throw bad("Expected multipart/form-data");
  const image = form.get("image");
  if (!image || typeof image.arrayBuffer !== "function") throw bad("Missing 'image' file field");

  const buf = new Uint8Array(await image.arrayBuffer());
  if (buf.byteLength === 0) throw bad("Empty image");
  if (buf.byteLength > maxBytes) throw new HttpError(413, "Upload too large");

  const type = sniffImageType(buf);
  if (!type) throw bad("Unsupported image type (need JPEG, PNG, or WebP)");

  // captured_at: trust the device but guard against garbage / future clock skew.
  let capturedAt = String(form.get("captured_at") || "").trim();
  const capMs = Date.parse(capturedAt);
  if (!Number.isFinite(capMs) || capMs > Date.now() + 5 * 60 * 1000) capturedAt = nowIso();
  else capturedAt = new Date(capMs).toISOString().replace(/\.\d+Z$/, "Z");

  const dims =
    imageDimensions(buf, type) || {
      width: parseInt(form.get("width"), 10) || null,
      height: parseInt(form.get("height"), 10) || null,
    };

  const shotId = newId();
  const ext = extForType(type);
  const r2Key = `shots/${device.org_id}/${device.id}/${shotId}.${ext}`;
  const thumbKey = `thumbs/${device.org_id}/${device.id}/${shotId}.jpg`;

  // Thumbnail: prefer a device-provided one; else generate server-side; else
  // fall back to the original so the timeline still works.
  let thumbBytes = null;
  let thumbType = "image/jpeg";
  const providedThumb = form.get("thumb");
  if (providedThumb && typeof providedThumb.arrayBuffer === "function") {
    const tb = new Uint8Array(await providedThumb.arrayBuffer());
    if (tb.byteLength > 0 && tb.byteLength <= maxBytes && sniffImageType(tb)) {
      thumbBytes = tb;
      thumbType = sniffImageType(tb);
    }
  }
  if (!thumbBytes) {
    const gen = await makeThumbnail(buf, parseInt(env.THUMB_MAX_EDGE, 10) || 360);
    if (gen) thumbBytes = gen.bytes;
  }
  let thumbR2Key = thumbKey;
  if (!thumbBytes) {
    // Degraded fallback: use the original as its own thumbnail.
    thumbBytes = buf;
    thumbType = type;
    thumbR2Key = r2Key;
  }

  const meta = { orgId: device.org_id, deviceId: device.id, shotId };
  await env.SHOTS.put(r2Key, buf, {
    httpMetadata: { contentType: type },
    customMetadata: meta,
  });
  if (thumbR2Key !== r2Key) {
    await env.SHOTS.put(thumbR2Key, thumbBytes, {
      httpMetadata: { contentType: thumbType },
      customMetadata: meta,
    });
  }

  await env.DB.prepare(
    `INSERT INTO screenshots (id, org_id, device_id, captured_at, r2_key, thumb_r2_key, width, height, bytes, content_type)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      shotId,
      device.org_id,
      device.id,
      capturedAt,
      r2Key,
      thumbR2Key,
      dims.width,
      dims.height,
      buf.byteLength,
      type,
    )
    .run();

  await env.DB.prepare(
    "UPDATE devices SET last_seen_at = ?, paused_reason = NULL, paused_at = NULL WHERE id = ?",
  )
    .bind(nowIso(), device.id)
    .run();

  return json({ id: shotId, captured_at: capturedAt, bytes: buf.byteLength, width: dims.width, height: dims.height }, 201);
}

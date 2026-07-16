// LinearWatch API — Cloudflare Worker entrypoint
// ==============================================
// Disclosed employee-monitoring SaaS. Two auth realms:
//   * Agents authenticate with a per-device token (X-Device-Token).
//   * Dashboard users authenticate with an email/password session (Bearer).
// Every dashboard query is strictly scoped to the caller's org — see lib/db +
// the requireSession() org_id threading in each handler.
//
// Local dev:  wrangler dev   (Miniflare simulates D1 + R2, no CF account needed)
// Deploy:     wrangler deploy

import { json, withCors, preflight, HttpError, forbidden } from "./lib/http.js";
import { ensureSchema } from "./lib/db.js";
import { timingSafeEqual } from "./lib/crypto.js";
import { runRetention } from "./lib/retention.js";

import { bootstrap } from "./routes/bootstrap.js";
import { login, logout, me } from "./routes/session.js";
import { enroll, reportConsent, agentConfig, ingestScreenshot } from "./routes/agent.js";
import {
  listDevices,
  getDevice,
  revokeDevice,
  listScreenshots,
  screenshotFullUrl,
  viewObject,
} from "./routes/devices.js";
import {
  getSettings,
  updateSettings,
  createEnrollmentCode,
  revokeEnrollmentCode,
  listAudit,
} from "./routes/settings.js";
import { listUsers, createUser, updateUser, deleteUser } from "./routes/users.js";

// Tiny matcher: returns captured groups for `pattern` (":id" style) or null.
function match(pattern, method, path, m) {
  if (method !== m) return null;
  const pp = pattern.split("/");
  const sp = path.split("/");
  if (pp.length !== sp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
    else if (pp[i] !== sp[i]) return null;
  }
  return params;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;
  let g;

  if (p === "/" && m === "GET") return json({ service: "linearwatch-api", ok: true });

  // Provisioning + admin
  if (match("/v1/bootstrap", "POST", p, m)) return bootstrap(request, env, ctx);
  if (match("/v1/admin/run-retention", "POST", p, m)) {
    if (!env.BOOTSTRAP_SECRET || !timingSafeEqual(request.headers.get("X-Bootstrap-Secret") || "", env.BOOTSTRAP_SECRET))
      throw forbidden("Invalid bootstrap secret");
    return json(await runRetention(env));
  }

  // Dashboard auth
  if (match("/v1/auth/login", "POST", p, m)) return login(request, env, ctx);
  if (match("/v1/auth/logout", "POST", p, m)) return logout(request, env);
  if (match("/v1/auth/me", "GET", p, m)) return me(request, env);

  // Agent (device-token auth)
  if (match("/v1/agent/enroll", "POST", p, m)) return enroll(request, env, ctx);
  if (match("/v1/agent/consent", "POST", p, m)) return reportConsent(request, env, ctx);
  if (match("/v1/agent/config", "GET", p, m)) return agentConfig(request, env);
  if (match("/v1/agent/screenshots", "POST", p, m)) return ingestScreenshot(request, env, ctx);

  // Devices + screenshots (session auth, org-scoped)
  if (match("/v1/devices", "GET", p, m)) return listDevices(request, env);
  if ((g = match("/v1/devices/:id", "GET", p, m))) return getDevice(request, env, g.id);
  if ((g = match("/v1/devices/:id/revoke", "POST", p, m))) return revokeDevice(request, env, ctx, g.id);
  if ((g = match("/v1/devices/:id/screenshots", "GET", p, m))) return listScreenshots(request, env, g.id, url);
  if ((g = match("/v1/screenshots/:id/full-url", "GET", p, m))) return screenshotFullUrl(request, env, ctx, g.id);
  if (match("/v1/view", "GET", p, m)) return viewObject(request, env, url);

  // Settings, enrollment codes, audit
  if (match("/v1/settings", "GET", p, m)) return getSettings(request, env);
  if (match("/v1/settings", "PATCH", p, m)) return updateSettings(request, env, ctx);
  if (match("/v1/enrollment-codes", "POST", p, m)) return createEnrollmentCode(request, env, ctx);
  if ((g = match("/v1/enrollment-codes/:id/revoke", "POST", p, m)))
    return revokeEnrollmentCode(request, env, ctx, g.id);
  if (match("/v1/audit", "GET", p, m)) return listAudit(request, env, url);

  // Users
  if (match("/v1/users", "GET", p, m)) return listUsers(request, env);
  if (match("/v1/users", "POST", p, m)) return createUser(request, env, ctx);
  if ((g = match("/v1/users/:id", "PATCH", p, m))) return updateUser(request, env, ctx, g.id);
  if ((g = match("/v1/users/:id", "DELETE", p, m))) return deleteUser(request, env, ctx, g.id);

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return preflight(env, request);
    try {
      await ensureSchema(env);
      const res = await route(request, env, ctx);
      return withCors(env, request, res);
    } catch (err) {
      if (err instanceof HttpError) return withCors(env, request, json({ error: err.message }, err.status));
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return withCors(env, request, json({ error: "Internal error" }, 500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env);
          await runRetention(env);
        } catch (e) {
          console.error("scheduled retention failed:", e && e.stack ? e.stack : e);
        }
      })(),
    );
  },
};

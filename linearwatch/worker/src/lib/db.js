// D1 helpers: idempotent schema bootstrap (self-heal), audit logging, misc.
// The canonical schema lives in schema.sql; these CREATE ... IF NOT EXISTS
// statements mirror it so a fresh D1 works even before the file is applied.

import { newId } from "./crypto.js";

const DDL = [
  `CREATE TABLE IF NOT EXISTS organizations (
     id TEXT PRIMARY KEY, name TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     retention_days INTEGER NOT NULL DEFAULT 30,
     capture_interval_seconds INTEGER NOT NULL DEFAULT 120)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner','admin','viewer')),
     password_hash TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)`,
  `CREATE TABLE IF NOT EXISTS devices (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, hostname TEXT NOT NULL,
     monitored_username TEXT NOT NULL, agent_token_hash TEXT,
     consent_acknowledged_at TEXT,
     enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_seen_at TEXT, revoked_at TEXT, paused_reason TEXT, paused_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(org_id)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(agent_token_hash)`,
  `CREATE TABLE IF NOT EXISTS screenshots (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, device_id TEXT NOT NULL,
     captured_at TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')),
     r2_key TEXT NOT NULL, thumb_r2_key TEXT, width INTEGER, height INTEGER,
     bytes INTEGER, content_type TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_shots_device_captured ON screenshots(device_id, captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shots_org_captured ON screenshots(org_id, captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shots_org_received ON screenshots(org_id, received_at)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_user_id TEXT,
     action TEXT NOT NULL, target TEXT, detail TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log(org_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     expires_at TEXT NOT NULL, user_agent TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS enrollment_codes (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT,
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     expires_at TEXT, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked_at TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_enroll_code ON enrollment_codes(code)`,
  `CREATE INDEX IF NOT EXISTS idx_enroll_org ON enrollment_codes(org_id)`,
];

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return; // once per isolate
  await env.DB.batch(DDL.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// Append an audit entry. Best-effort: monitoring reads must be logged, but a log
// failure should never break the read itself, so callers use ctx.waitUntil.
export async function audit(env, { orgId, actorUserId = null, action, target = null, detail = null }) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, org_id, actor_user_id, action, target, detail) VALUES (?,?,?,?,?,?)",
    )
      .bind(newId(), orgId, actorUserId, action, target, detail == null ? null : String(detail))
      .run();
  } catch (e) {
    console.error("audit failed", action, e);
  }
}

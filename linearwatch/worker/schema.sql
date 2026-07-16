-- LinearWatch — D1 (SQLite) schema
-- ================================
-- Disclosed employee-monitoring SaaS. Every table is org-scoped; the Worker
-- NEVER lets one org read another org's rows (see src/lib/db.js orgScoped()).
--
-- Apply locally (Miniflare):
--   wrangler d1 execute linearwatch --local --file=./schema.sql
-- Apply to your real D1:
--   wrangler d1 execute linearwatch --remote --file=./schema.sql
--
-- The Worker also self-heals this schema on boot (ensureSchema in src/lib/db.js),
-- so a fresh D1 works even before you run the file. Running the file is still the
-- recommended, explicit way to provision.

-- Tenants ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  retention_days            INTEGER NOT NULL DEFAULT 30,
  capture_interval_seconds  INTEGER NOT NULL DEFAULT 120
);

-- Dashboard logins ------------------------------------------------------------
-- password_hash format: "pbkdf2$sha256$<iterations>$<salt_b64url>$<hash_b64url>"
-- (PBKDF2-HMAC-SHA256 via WebCrypto — the platform-native strong KDF on Workers;
--  the versioned prefix lets us migrate to argon2id later without a data reset.)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  email         TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','viewer')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Login is by email, so email is globally unique (case-insensitive; we store lower).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

-- Monitored devices -----------------------------------------------------------
-- agent_token_hash: sha256(device_token). We store only the hash; the plaintext
-- token is shown once at enrollment. NULL/revoked_at set = token revoked.
CREATE TABLE IF NOT EXISTS devices (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES organizations(id),
  hostname                TEXT NOT NULL,
  monitored_username      TEXT NOT NULL,
  agent_token_hash        TEXT,
  consent_acknowledged_at TEXT,
  enrolled_at             TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at            TEXT,
  revoked_at              TEXT,
  paused_reason           TEXT,
  paused_at               TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(org_id);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(agent_token_hash);

-- Captured screenshots (metadata; bytes live in R2) ---------------------------
CREATE TABLE IF NOT EXISTS screenshots (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  captured_at   TEXT NOT NULL,                              -- device-reported ISO8601 (validated)
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),   -- server receive time
  r2_key        TEXT NOT NULL,
  thumb_r2_key  TEXT,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  content_type  TEXT
);
CREATE INDEX IF NOT EXISTS idx_shots_device_captured ON screenshots(device_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_shots_org_captured ON screenshots(org_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_shots_org_received ON screenshots(org_id, received_at);

-- Admin audit trail -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log(org_id, created_at);

-- ==== Additions beyond the base spec (needed for a working product) ==========

-- Dashboard sessions (opaque bearer tokens; revocable + org-scoped). We use
-- bearer tokens rather than cookies because the dashboard (Cloudflare Pages) and
-- the API (Worker) are different origins — same reasoning as the existing chat app.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,   -- the opaque bearer value (high-entropy random)
  user_id     TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Enrollment codes — how an agent joins an org. Shown in Settings; entered in
-- the agent on first run. Revocable, optionally expiring / use-capped.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  code        TEXT NOT NULL,
  label       TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  max_uses    INTEGER,             -- NULL = unlimited
  uses        INTEGER NOT NULL DEFAULT 0,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_enroll_code ON enrollment_codes(code);
CREATE INDEX IF NOT EXISTS idx_enroll_org ON enrollment_codes(org_id);

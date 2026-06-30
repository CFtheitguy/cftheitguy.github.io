-- Run once in Cloudflare D1 console: paste and click "Execute"

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash            TEXT    NOT NULL,
  pw_salt            TEXT    NOT NULL,
  stripe_customer_id TEXT,
  stripe_sub_id      TEXT,
  plan               TEXT    NOT NULL DEFAULT 'starter',
  storage_limit      INTEGER NOT NULL DEFAULT 10737418240,
  status             TEXT    NOT NULL DEFAULT 'active',
  trial_until        TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key      TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);

CREATE TABLE IF NOT EXISTS shares (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT    NOT NULL UNIQUE,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  pw_hash      TEXT    NOT NULL,
  pw_salt      TEXT    NOT NULL,
  recipient_email TEXT,
  expires_at   TEXT,
  viewed       INTEGER NOT NULL DEFAULT 0,
  max_views    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);

-- Public password / secret sharing (free, no account) — pwpush-style
CREATE TABLE IF NOT EXISTS secrets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT    NOT NULL UNIQUE,
  payload     TEXT    NOT NULL,   -- AES-GCM encrypted, base64
  iv          TEXT    NOT NULL,   -- AES-GCM nonce, base64
  pw_hash     TEXT,               -- optional extra password
  pw_salt     TEXT,
  expires_at  TEXT,
  viewed      INTEGER NOT NULL DEFAULT 0,
  max_views   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_secrets_token ON secrets(token);

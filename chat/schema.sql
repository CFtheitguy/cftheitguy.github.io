-- Linear Chat — D1 schema (chat.linearit.co)
-- Run once in the D1 console, OR just let the Worker self-heal: it runs these
-- same CREATE IF NOT EXISTS statements on first request.

-- People who can sign in. A user is created the first time an email logs in,
-- or when a group admin adds them by email.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,   -- 1 = may create groups
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time MFA codes emailed at login. Codes are hashed, never stored raw.
CREATE TABLE IF NOT EXISTS login_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,             -- epoch milliseconds
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL              -- epoch milliseconds
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

-- Chat groups. (Named chat_groups because GROUPS is a SQLite keyword.)
CREATE TABLE IF NOT EXISTS chat_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,                -- admin email
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who belongs to which group, and their role inside it.
CREATE TABLE IF NOT EXISTS group_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_id, email)
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_email ON group_members(email);

-- Group messages.
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL,
  sender_email  TEXT NOT NULL,
  sender_name   TEXT,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id);

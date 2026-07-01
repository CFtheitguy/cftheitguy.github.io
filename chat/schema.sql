-- Linear Chat — D1 schema (chat.linearit.co)
-- Run once in the D1 console, OR just let the Worker self-heal: it runs these
-- same statements (and the migrations below) on first request.

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

-- Group messages. parent_id is NULL for top-level messages, or the id of the
-- message a reply belongs to (single-level threads, Slack-style).
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL,
  parent_id     INTEGER,
  sender_email  TEXT NOT NULL,
  sender_name   TEXT,
  body          TEXT,
  kind          TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'call'
  meta          TEXT,                            -- JSON (e.g. call room info)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_group  ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

-- Emoji reactions. One row per (message, person, emoji).
CREATE TABLE IF NOT EXISTS reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL,
  email       TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, email, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);

-- File attachments. Bytes live in R2 (binding FILES); this row is the metadata.
-- message_id is NULL only momentarily during upload, then linked to the message.
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER,
  group_id      INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size          INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

-- Migrations for databases created before threads/calls existed (the Worker
-- runs these too, ignoring "duplicate column" errors):
--   ALTER TABLE messages ADD COLUMN parent_id INTEGER;
--   ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
--   ALTER TABLE messages ADD COLUMN meta TEXT;

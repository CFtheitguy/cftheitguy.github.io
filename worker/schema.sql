CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  sid TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_number ON messages(number);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT,
  duration INTEGER DEFAULT 0,
  sid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at);
CREATE TABLE IF NOT EXISTS voicemail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  recording_url TEXT,
  transcript TEXT,
  sid TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  number TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_number ON contacts(number);

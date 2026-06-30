-- Ohel Feiga Alerts — D1 schema
-- Run once in the Cloudflare D1 console (or `wrangler d1 execute ohelfeiga --file=schema.sql`).
-- This database is completely separate from the Linear Phone database.

-- Everyone who can receive a broadcast.
CREATE TABLE IF NOT EXISTS subscribers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT NOT NULL UNIQUE,          -- E.164, e.g. +18455551234
  name        TEXT,
  opted_out   INTEGER NOT NULL DEFAULT 0,    -- 1 = texted STOP, never message again
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers(opted_out);

-- One row per "send to everyone" job.
CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  body        TEXT NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,    -- recipients queued
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | sending | done
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The per-recipient queue for a broadcast. We drain this in small batches so the
-- whole job stays inside Cloudflare's free-plan limits (<=50 sends per call).
CREATE TABLE IF NOT EXISTS outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id  INTEGER NOT NULL,
  number        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_drain ON outbox(broadcast_id, status);

-- Inbound texts (mainly so STOP / START is auditable).
CREATE TABLE IF NOT EXISTS inbound (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT NOT NULL,
  body        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

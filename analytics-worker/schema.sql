-- Schema for `linear_analytics` — one row per page view on www.linearit.co.
--
-- Apply with:
--   npx wrangler d1 execute linear_analytics --remote --file=./schema.sql
--
-- (The Worker also creates this table on its own first request, so this file is
-- belt-and-braces rather than strictly required.)

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  path TEXT NOT NULL,
  query TEXT,
  ip TEXT,
  country TEXT,
  city TEXT,
  region TEXT,
  asn INTEGER,
  -- The network the visitor came from. For office/business traffic this is
  -- frequently the company itself, which is the closest thing to a name you
  -- get without a paid reverse-IP service.
  org TEXT,
  ua TEXT,
  referer TEXT,
  status INTEGER,
  is_bot INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_path ON visits(path);
CREATE INDEX IF NOT EXISTS idx_visits_org ON visits(org);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);

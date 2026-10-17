-- Link registry. The PRIMARY KEY is what makes "slug already exists" fail
-- atomically: KV has no compare-and-set, so uniqueness is enforced here.
CREATE TABLE links (
  slug         TEXT PRIMARY KEY,
  url          TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,          -- epoch ms
  expires_at   INTEGER,                   -- epoch ms, NULL = never
  max_clicks   INTEGER,                   -- NULL = no cap
  fallback_url TEXT,
  hits         INTEGER NOT NULL DEFAULT 0 -- non-bot clicks, only counted for capped links
);

-- One row per click. No IP address is stored.
CREATE TABLE clicks (
  id      INTEGER PRIMARY KEY,
  slug    TEXT    NOT NULL,
  ts      INTEGER NOT NULL,               -- epoch ms
  country TEXT,
  city    TEXT,
  device  TEXT    NOT NULL,               -- desktop | mobile | tablet | bot | unknown
  referer TEXT,
  outcome TEXT    NOT NULL                -- ok | expired | capped
);

CREATE INDEX clicks_slug_ts ON clicks (slug, ts);
CREATE INDEX clicks_ts ON clicks (ts);

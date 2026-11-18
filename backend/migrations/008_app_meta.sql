-- 008: small key/value store for app state that must survive restarts
-- (e.g. last successful ATOM sync time, so a dev restart does not trigger an immediate sync).
CREATE TABLE IF NOT EXISTS app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

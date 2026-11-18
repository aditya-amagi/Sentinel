-- 001_initial_schema.sql
-- Core Sentinel tables for ATOM issues, occurrences, tickets, and playlist timeline

CREATE TABLE IF NOT EXISTS issues (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_issue_id             TEXT NOT NULL,
  playlist_id               TEXT NOT NULL DEFAULT '',
  feed_code                 TEXT,
  region                    TEXT,
  host                      TEXT,
  account                   TEXT,
  issue_type                TEXT,
  consolidated_status       TEXT,
  playlist_date             TEXT,
  playlist_start_time       DATETIME,
  earliest_scheduled        DATETIME,
  status                    TEXT DEFAULT 'open',
  occurrence_count          INTEGER DEFAULT 0,
  ticket_link               TEXT,
  ticket_id                 TEXT,
  acknowledged              BOOLEAN DEFAULT 0,
  penalty                   BOOLEAN DEFAULT 1,
  state                     TEXT DEFAULT 'penalty',
  asset_id                  TEXT,
  has_previous_ticket_same_day BOOLEAN DEFAULT 0,
  previous_ticket_id        TEXT,
  previous_playlist_id      TEXT,
  previous_playlist_time    DATETIME,
  created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(atom_issue_id, playlist_id)
);

CREATE TABLE IF NOT EXISTS occurrences (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_issue_id        TEXT NOT NULL,
  playlist_id          TEXT NOT NULL DEFAULT '',
  playlist_start_time  DATETIME,
  playout_start_time   DATETIME,
  duration             TEXT,
  asset_id             TEXT,
  feed_code            TEXT,
  region               TEXT,
  playlist_date        TEXT,
  issue_type           TEXT,
  resolved_playlist_id TEXT,
  raw_payload          TEXT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_issue_id  TEXT NOT NULL,
  playlist_id    TEXT NOT NULL,
  feed_code      TEXT,
  issue_type     TEXT,
  asset_id       TEXT,
  ticket_number  TEXT,
  ticket_link    TEXT,
  status         TEXT DEFAULT 'open',
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_timeline (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_code     TEXT NOT NULL,
  playlist_date TEXT NOT NULL,
  playlist_id   TEXT NOT NULL,
  published_at  DATETIME NOT NULL,
  region        TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_issues_composite  ON issues(atom_issue_id, playlist_id);
CREATE INDEX IF NOT EXISTS idx_issues_feed       ON issues(feed_code);
CREATE INDEX IF NOT EXISTS idx_issues_region     ON issues(region);
CREATE INDEX IF NOT EXISTS idx_issues_start      ON issues(playlist_start_time);
CREATE INDEX IF NOT EXISTS idx_occ_composite     ON occurrences(atom_issue_id, playlist_id);
CREATE INDEX IF NOT EXISTS idx_occ_playout       ON occurrences(playout_start_time);
CREATE INDEX IF NOT EXISTS idx_tickets_feed_type ON tickets(feed_code, issue_type, created_at);
CREATE INDEX IF NOT EXISTS idx_pl_feed_date      ON playlist_timeline(feed_code, playlist_date);

-- 002_contacts_and_freshdesk.sql
-- Freshdesk integration tables, feed contact routing, and issue overrides

CREATE TABLE IF NOT EXISTS feed_ticket_config (
  feed_code           TEXT PRIMARY KEY,
  customer_name       TEXT,
  product_version     TEXT,
  contact_email       TEXT,
  cc_emails           TEXT,
  use_general_for_all BOOLEAN DEFAULT 1,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issue_contact_override (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_code     TEXT NOT NULL,
  issue_type    TEXT NOT NULL,
  contact_email TEXT,
  cc_emails     TEXT,
  enabled       BOOLEAN DEFAULT 0,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(feed_code, issue_type)
);

CREATE TABLE IF NOT EXISTS freshdesk_tickets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_issue_id    TEXT NOT NULL,
  playlist_id      TEXT NOT NULL,
  feed_code        TEXT,
  issue_type       TEXT,
  asset_id         TEXT,
  freshdesk_id     INTEGER,
  ticket_number    TEXT,
  ticket_url       TEXT,
  subject          TEXT,
  requester_email  TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fdt_composite ON freshdesk_tickets(atom_issue_id, playlist_id);

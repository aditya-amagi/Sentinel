-- 004: Store the full ATOM alert record and the ATOM feed catalog.
-- consolidated_status holds ATOM's lifecycle state (active | snoozed | resolved);
-- issues.state remains Sentinel's own triage state (penalty | ack | ticketed).

ALTER TABLE issues ADD COLUMN severity             TEXT;
ALTER TABLE issues ADD COLUMN alert_name           TEXT;
ALTER TABLE issues ADD COLUMN description          TEXT;
ALTER TABLE issues ADD COLUMN raw_type             TEXT;
ALTER TABLE issues ADD COLUMN product              TEXT;
ALTER TABLE issues ADD COLUMN entity_service       TEXT;
ALTER TABLE issues ADD COLUMN automation_url       TEXT;
ALTER TABLE issues ADD COLUMN headend_code         TEXT;
ALTER TABLE issues ADD COLUMN dedup_key            TEXT;
ALTER TABLE issues ADD COLUMN correlation_id       TEXT;
ALTER TABLE issues ADD COLUMN duration_ms          INTEGER;
ALTER TABLE issues ADD COLUMN snoozed_until        DATETIME;
ALTER TABLE issues ADD COLUMN snoozed_by           TEXT;
ALTER TABLE issues ADD COLUMN resolved_at          DATETIME;
ALTER TABLE issues ADD COLUMN resolved_by          TEXT;
ALTER TABLE issues ADD COLUMN atom_updated_at      DATETIME;
ALTER TABLE issues ADD COLUMN labels               TEXT;
ALTER TABLE issues ADD COLUMN custom_details       TEXT;
ALTER TABLE issues ADD COLUMN atom_writeback_error TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_severity    ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_atom_state  ON issues(consolidated_status);
CREATE INDEX IF NOT EXISTS idx_issues_automation  ON issues(automation_url);

CREATE TABLE IF NOT EXISTS atom_feeds (
  feed_code            TEXT PRIMARY KEY,
  feed_name            TEXT,
  automation_url       TEXT,
  customer_name        TEXT,
  amg_id               TEXT,
  account_domain       TEXT,
  time_zone            TEXT,
  broadcast_start_time TEXT,
  days_to_monitor      INTEGER,
  headends_json        TEXT,
  synced_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_atom_feeds_automation ON atom_feeds(automation_url);

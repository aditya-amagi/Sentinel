-- 007: ingest by ATOM saved views (/me/views). Each alert records the views it appears in;
-- the view's group (EMEA, APAC, America, …) becomes the alert's region in the UI and its
-- family (Schedule / Asset / Live) a sub-filter.
ALTER TABLE issues ADD COLUMN atom_view_ids   TEXT;   -- ",16,19," for LIKE matching
ALTER TABLE issues ADD COLUMN atom_view_names TEXT;   -- JSON array of view names
ALTER TABLE issues ADD COLUMN view_group      TEXT;
ALTER TABLE issues ADD COLUMN view_family     TEXT;
CREATE INDEX IF NOT EXISTS idx_issues_view_group ON issues(view_group, view_family);

CREATE TABLE IF NOT EXISTS atom_views (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  grp        TEXT,
  family     TEXT,
  selected   INTEGER DEFAULT 0,
  synced_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

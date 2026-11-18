-- 006: which feeds are actually monitored in ATOM.
--   data_only  ← customer.data_only ("monitoring is off, metadata-only")
--   monitored  ← 1 when the customer is not data_only and at least one headend has
--                health.monitoring = true (or the feed has no headend data); else 0
-- Sentinel only ingests alerts for monitored feeds (feeds not in the catalog are kept).
ALTER TABLE atom_feeds ADD COLUMN data_only INTEGER DEFAULT 0;
ALTER TABLE atom_feeds ADD COLUMN monitored INTEGER DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_atom_feeds_monitored ON atom_feeds(monitored);

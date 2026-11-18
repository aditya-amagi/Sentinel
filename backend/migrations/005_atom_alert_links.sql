-- 005: fields seen on real ATOM staging alerts (Nov 2026).
--   feed_name   ← labels.feed_name / entity.name (entity.name is the feed name, not a host)
--   amg_id      ← entity.amgID (Amagi account ID, e.g. AMG01079)
--   source_url  ← custom_details.playlist_url (deep link into CloudPort)
ALTER TABLE issues ADD COLUMN feed_name  TEXT;
ALTER TABLE issues ADD COLUMN amg_id     TEXT;
ALTER TABLE issues ADD COLUMN source_url TEXT;

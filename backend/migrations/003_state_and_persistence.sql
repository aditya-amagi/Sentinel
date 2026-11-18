-- 003_state_and_persistence.sql
-- Enforces canonical 3-state lifecycle (penalty -> ack -> ticketed) and deduplication indexes

CREATE INDEX IF NOT EXISTS idx_issues_state_time ON issues(state, playlist_start_time);
CREATE INDEX IF NOT EXISTS idx_issues_persistence ON issues(has_previous_ticket_same_day);

const AT = require('./alertTypes');
const TZ = require('./atomTime');
const { applyMigrations } = require('./migrator');
// db.js — SQLite with playlist-scoped occurrences + ticket warning system
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'atom_dashboard.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    initSchema();
    initFreshdeskSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_issues_composite     ON issues(atom_issue_id, playlist_id);
    CREATE INDEX IF NOT EXISTS idx_issues_feed          ON issues(feed_code);
    CREATE INDEX IF NOT EXISTS idx_issues_region        ON issues(region);
    CREATE INDEX IF NOT EXISTS idx_issues_start         ON issues(playlist_start_time);
    CREATE INDEX IF NOT EXISTS idx_occ_composite        ON occurrences(atom_issue_id, playlist_id);
    CREATE INDEX IF NOT EXISTS idx_occ_playout          ON occurrences(playout_start_time);
    CREATE INDEX IF NOT EXISTS idx_tickets_feed_type    ON tickets(feed_code, issue_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_pl_feed_date         ON playlist_timeline(feed_code, playlist_date);
  `);

  // Safe migrations for existing DBs
  const safeAdd = (table, col, def) => {
    try {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch {}
  };
  safeAdd('issues', 'state',                        "TEXT DEFAULT 'penalty'");
  // Migrate any legacy not_ticketed rows → ack (not_ticketed state is removed)
  try { getDb().prepare(`UPDATE issues SET state='ack' WHERE state='not_ticketed'`).run(); } catch {}
  safeAdd('issues', 'playlist_start_time',          'DATETIME');
  safeAdd('issues', 'asset_id',                     'TEXT');
  safeAdd('issues', 'has_previous_ticket_same_day', 'BOOLEAN DEFAULT 0');
  safeAdd('issues', 'previous_ticket_id',           'TEXT');
  safeAdd('issues', 'previous_playlist_id',         'TEXT');
  safeAdd('issues', 'previous_playlist_time',       'DATETIME');
  safeAdd('occurrences', 'playlist_id',             "TEXT NOT NULL DEFAULT ''");
  safeAdd('occurrences', 'playlist_start_time',     'DATETIME');
  safeAdd('occurrences', 'feed_code',               'TEXT');
  safeAdd('occurrences', 'region',                  'TEXT');
  safeAdd('occurrences', 'resolved_playlist_id',    'TEXT');
}

// ── Issue upsert (keyed on atom_issue_id + playlist_id) ──────────────────────

// Full-fidelity ATOM columns (migration 004). Written on insert; on update they are only
// overwritten when the caller marks the row as coming from an ATOM sync (atom_sync: true),
// so demo seeds and legacy callers never wipe them.
const ATOM_COLS = [
  'severity','alert_name','description','raw_type','product','entity_service','automation_url',
  'headend_code','dedup_key','correlation_id','duration_ms','snoozed_until','snoozed_by',
  'resolved_at','resolved_by','atom_updated_at','labels','custom_details',
  'feed_name','amg_id','source_url',
];

function upsertIssue(issue) {
  const params = {
    atom_issue_id: issue.atom_issue_id,
    playlist_id: issue.playlist_id,
    feed_code: issue.feed_code ?? null,
    region: issue.region ?? null,
    host: issue.host ?? null,
    account: issue.account ?? null,
    issue_type: issue.issue_type ?? null,
    consolidated_status: issue.consolidated_status ?? null,
    playlist_date: issue.playlist_date ?? null,
    playlist_start_time: issue.playlist_start_time ?? null,
    earliest_scheduled: issue.earliest_scheduled ?? null,
    status: issue.status ?? 'open',
    penalty: issue.penalty != null ? (issue.penalty ? 1 : 0) : 0,
    asset_id: issue.asset_id ?? null,
    state: issue.state ?? 'penalty',
    atom_sync: issue.atom_sync ? 1 : 0,
  };
  for (const c of ATOM_COLS) {
    const v = issue[c];
    params[c] = v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v);
  }
  getDb().prepare(`
    INSERT INTO issues (
      atom_issue_id, playlist_id, feed_code, region, host, account,
      issue_type, consolidated_status, playlist_date, playlist_start_time,
      earliest_scheduled, status, penalty, asset_id, state,
      ${ATOM_COLS.join(', ')}
    ) VALUES (
      @atom_issue_id, @playlist_id, @feed_code, @region, @host, @account,
      @issue_type, @consolidated_status, @playlist_date, @playlist_start_time,
      @earliest_scheduled, @status, @penalty, @asset_id, COALESCE(@state, 'penalty'),
      ${ATOM_COLS.map(c => '@' + c).join(', ')}
    )
    ON CONFLICT(atom_issue_id, playlist_id) DO UPDATE SET
      feed_code           = excluded.feed_code,
      region              = excluded.region,
      host                = excluded.host,
      account             = excluded.account,
      issue_type          = excluded.issue_type,
      consolidated_status = excluded.consolidated_status,
      playlist_date       = excluded.playlist_date,
      playlist_start_time = excluded.playlist_start_time,
      earliest_scheduled  = excluded.earliest_scheduled,
      status              = excluded.status,
      penalty             = excluded.penalty,
      asset_id            = excluded.asset_id,
      ${ATOM_COLS.map(c => `${c} = CASE WHEN @atom_sync = 1 THEN excluded.${c} ELSE COALESCE(excluded.${c}, issues.${c}) END`).join(',\n      ')},
      updated_at          = CURRENT_TIMESTAMP
  `).run(params);
}

/** Open (active/snoozed) ATOM issues in the DB — candidates for resolution detection. */
function getOpenAtomIssues() {
  return getDb().prepare(`
    SELECT atom_issue_id FROM issues
    WHERE consolidated_status IN ('active','snoozed') OR consolidated_status IS NULL
    GROUP BY atom_issue_id
    ORDER BY MIN(updated_at) ASC, MIN(id) ASC
  `).all().map(r => r.atom_issue_id);
}

/** Apply ATOM lifecycle fields (state, snooze, resolve) to every playlist row of an alert. */
function updateAtomLifecycle(atom_issue_id, f) {
  const status = f.consolidated_status;
  getDb().prepare(`
    UPDATE issues SET
      consolidated_status = @status,
      status        = CASE WHEN @status = 'resolved' THEN 'resolved' ELSE status END,
      snoozed_until = @snoozed_until,
      snoozed_by    = @snoozed_by,
      resolved_at   = @resolved_at,
      resolved_by   = @resolved_by,
      atom_updated_at = COALESCE(@atom_updated_at, atom_updated_at),
      updated_at    = CURRENT_TIMESTAMP
    WHERE atom_issue_id = @atom_issue_id
  `).run({
    atom_issue_id, status,
    snoozed_until: f.snoozed_until ?? null, snoozed_by: f.snoozed_by ?? null,
    resolved_at: f.resolved_at ?? null, resolved_by: f.resolved_by ?? null,
    atom_updated_at: f.atom_updated_at ?? null,
  });
}

function updateOccurrenceCount(atom_issue_id, playlist_id) {
  getDb().prepare(`
    UPDATE issues SET
      occurrence_count = (SELECT COUNT(*) FROM occurrences WHERE atom_issue_id=? AND playlist_id=?),
      updated_at = CURRENT_TIMESTAMP
    WHERE atom_issue_id=? AND playlist_id=?
  `).run(atom_issue_id, playlist_id, atom_issue_id, playlist_id);
}

// ── Occurrence insert scoped to playlist ─────────────────────────────────────

function insertOccurrenceIfNotExists(occ) {
  const db = getDb();
  const exists = db.prepare(`
    SELECT id FROM occurrences
    WHERE atom_issue_id=? AND playlist_id=? AND playout_start_time=? AND asset_id IS ?
    LIMIT 1
  `).get(occ.atom_issue_id, occ.playlist_id, occ.playout_start_time, occ.asset_id || null);

  if (!exists) {
    let resolved = occ.playlist_id;
    if (occ.feed_code && occ.playlist_date && occ.playout_start_time) {
      const m = resolvePlaylistAtTime(occ.feed_code, occ.playlist_date, occ.playout_start_time);
      if (m) resolved = m.playlist_id;
    }
    const occParams = {
      atom_issue_id: occ.atom_issue_id,
      playlist_id: occ.playlist_id,
      playlist_start_time: occ.playlist_start_time ?? null,
      playout_start_time: occ.playout_start_time ?? null,
      duration: occ.duration ?? null,
      asset_id: occ.asset_id ?? null,
      feed_code: occ.feed_code ?? null,
      region: occ.region ?? null,
      playlist_date: occ.playlist_date ?? null,
      issue_type: occ.issue_type ?? null,
      resolved_playlist_id: resolved ?? null,
      raw_payload: occ.raw_payload ?? null,
    };
    db.prepare(`
      INSERT INTO occurrences (
        atom_issue_id, playlist_id, playlist_start_time, playout_start_time,
        duration, asset_id, feed_code, region, playlist_date,
        issue_type, resolved_playlist_id, raw_payload
      ) VALUES (
        @atom_issue_id, @playlist_id, @playlist_start_time, @playout_start_time,
        @duration, @asset_id, @feed_code, @region, @playlist_date,
        @issue_type, @resolved_playlist_id, @raw_payload
      )
    `).run(occParams);
  }
}

// ── Same-day ticket check ────────────────────────────────────────────────────

/**
 * Returns prior ticket if same feed + issue_type + asset + same calendar day
 * and a DIFFERENT playlist already has a ticket.
 */
function findSameDayPreviousTicket({ feed_code, issue_type, asset_id, playlist_id, playlist_date }) {
  return getDb().prepare(`
    SELECT t.*, i.playlist_start_time as prev_playlist_time, i.playlist_id as prev_playlist_id
    FROM tickets t
    JOIN issues i ON i.atom_issue_id = t.atom_issue_id AND i.playlist_id = t.playlist_id
    WHERE t.feed_code  = ?
      AND t.issue_type = ?
      AND (t.asset_id IS NULL OR t.asset_id = ? OR ? IS NULL)
      AND t.playlist_id != ?
      AND DATE(i.playlist_start_time) = DATE(?)
    ORDER BY t.created_at DESC
    LIMIT 1
  `).get(feed_code, issue_type, asset_id || null, asset_id || null, playlist_id, playlist_date || new Date().toISOString());
}

/**
 * Called during sync to stamp has_previous_ticket_same_day on the issue.
 */
function checkAndMarkPersistence(atom_issue_id, playlist_id, feed_code, issue_type, asset_id, playlist_date, playlist_start_time) {
  const prev = findSameDayPreviousTicket({ feed_code, issue_type, asset_id, playlist_id, playlist_date: playlist_start_time || playlist_date });
  if (prev) {
    getDb().prepare(`
      UPDATE issues SET
        has_previous_ticket_same_day = 1,
        previous_ticket_id   = ?,
        previous_playlist_id = ?,
        previous_playlist_time = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE atom_issue_id=? AND playlist_id=? AND has_previous_ticket_same_day=0
    `).run(
      prev.ticket_number || String(prev.id),
      prev.prev_playlist_id,
      prev.prev_playlist_time,
      atom_issue_id, playlist_id
    );
  }
}

// ── Ticket creation ──────────────────────────────────────────────────────────

function createTicket({ atom_issue_id, playlist_id, feed_code, issue_type, asset_id, ticket_number, ticket_link }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO tickets (atom_issue_id, playlist_id, feed_code, issue_type, asset_id, ticket_number, ticket_link)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(atom_issue_id, playlist_id, feed_code, issue_type, asset_id || null, ticket_number || null, ticket_link || null);

  // Reflect on issue row
  db.prepare(`
    UPDATE issues SET ticket_id=?, ticket_link=?, updated_at=CURRENT_TIMESTAMP
    WHERE atom_issue_id=? AND playlist_id=?
  `).run(ticket_number || null, ticket_link || null, atom_issue_id, playlist_id);

  // Re-check persistence on any same-day playlists that don't have warning yet
  if (feed_code && issue_type) {
    const sameDayIssues = db.prepare(`
      SELECT i.atom_issue_id, i.playlist_id, i.asset_id, i.playlist_date, i.playlist_start_time
      FROM issues i
      WHERE i.feed_code=? AND i.issue_type=?
        AND DATE(i.playlist_start_time) = DATE(?)
        AND i.playlist_id != ?
        AND i.has_previous_ticket_same_day = 0
    `).all(feed_code, issue_type, new Date().toISOString(), playlist_id);
    for (const row of sameDayIssues) {
      checkAndMarkPersistence(row.atom_issue_id, row.playlist_id, feed_code, issue_type, row.asset_id, row.playlist_date, row.playlist_start_time);
    }
  }

  return db.prepare(`SELECT * FROM tickets WHERE id=?`).get(result.lastInsertRowid);
}

// ── Playlist timeline ────────────────────────────────────────────────────────

function insertPlaylistVersionIfNew(entry) {
  const db = getDb();
  const ex = db.prepare(`SELECT id FROM playlist_timeline WHERE feed_code=? AND playlist_date=? AND playlist_id=? LIMIT 1`)
    .get(entry.feed_code, entry.playlist_date, entry.playlist_id);
  if (!ex) { db.prepare(`INSERT INTO playlist_timeline (feed_code,playlist_date,playlist_id,published_at,region) VALUES (@feed_code,@playlist_date,@playlist_id,@published_at,@region)`).run(entry); return true; }
  return false;
}

function resolvePlaylistAtTime(feed_code, playlist_date, alert_time) {
  // playlist_id is globally sequential — higher ID = later publish.
  // ORDER BY playlist_id DESC finds the most recent version published
  // at or before the alert time, matching the real-world assignment logic.
  return getDb().prepare(`
    SELECT playlist_id, published_at FROM playlist_timeline
    WHERE feed_code = ? AND playlist_date = ? AND published_at <= ?
    ORDER BY playlist_id DESC
    LIMIT 1
  `).get(feed_code, playlist_date, alert_time);
}

function getPlaylistTimeline(feed_code, playlist_date) {
  // Order by playlist_id ASC = chronological publish order (sequential IDs)
  return getDb().prepare(`
    SELECT * FROM playlist_timeline
    WHERE feed_code = ? AND playlist_date = ?
    ORDER BY playlist_id ASC
  `).all(feed_code, playlist_date);
}

// ── Upcoming (dashboard) ─────────────────────────────────────────────────────

function getUpcomingIssues(filters = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  let q = `
    SELECT i.*,
      MIN(o.playout_start_time) as first_occurrence,
      MAX(o.playout_start_time) as last_occurrence,
      COUNT(o.id) as occ_count
    FROM issues i
    LEFT JOIN occurrences o ON o.atom_issue_id=i.atom_issue_id AND o.playlist_id=i.playlist_id
    WHERE (i.playlist_start_time >= ? OR i.playlist_start_time IS NULL)
  `;
  const params = [now];
  applyFilters(filters, q, params, (clause, vals) => { q += clause; params.push(...vals); });
  q += ` GROUP BY i.atom_issue_id, i.playlist_id ORDER BY `
     + (filters.sort === 'severity' ? `${SEVERITY_RANK_SQL}, ` : '')
     + `i.playlist_start_time ASC NULLS LAST, i.earliest_scheduled ASC NULLS LAST, i.updated_at DESC`;
  return db.prepare(q).all(...params);
}

// ── History ──────────────────────────────────────────────────────────────────

function getHistoryFeeds(region) {
  const db = getDb();
  let q = `SELECT DISTINCT feed_code, region FROM issues WHERE playlist_start_time < datetime('now') OR playlist_start_time IS NULL`;
  const p = [];
  if (region) { q += ` AND region=?`; p.push(region); }
  q += ` ORDER BY feed_code`;
  return db.prepare(q).all(...p);
}

function getHistoryPlaylists(feed_code, region) {
  const db = getDb();
  let q = `
    SELECT i.playlist_id, i.playlist_date, i.playlist_start_time, i.region,
      COUNT(DISTINCT i.atom_issue_id) as issue_count,
      SUM(CASE WHEN i.ticket_id IS NOT NULL THEN 1 ELSE 0 END) as ticketed_count,
      SUM(CASE WHEN i.penalty=1 THEN 1 ELSE 0 END) as penalty_count
    FROM issues i
    WHERE i.feed_code=?
      AND (i.playlist_start_time < datetime('now') OR i.playlist_start_time IS NULL)
  `;
  const p = [feed_code];
  if (region) { q += ` AND i.region=?`; p.push(region); }
  // Most recent playlist first: highest playlist_id = latest assigned = most recent publish
  q += ` GROUP BY i.playlist_id ORDER BY CAST(i.playlist_id AS INTEGER) DESC, i.playlist_start_time DESC NULLS LAST`;
  return db.prepare(q).all(...p);
}

function getHistoryIssues(feed_code, playlist_id) {
  return getDb().prepare(`
    SELECT i.*,
      MIN(o.playout_start_time) as first_occurrence,
      MAX(o.playout_start_time) as last_occurrence,
      COUNT(o.id) as occ_count
    FROM issues i
    LEFT JOIN occurrences o ON o.atom_issue_id=i.atom_issue_id AND o.playlist_id=i.playlist_id
    WHERE i.feed_code=? AND i.playlist_id=?
    GROUP BY i.atom_issue_id, i.playlist_id
    ORDER BY first_occurrence ASC NULLS LAST
  `).all(feed_code, playlist_id);
}

// ── Issue detail ─────────────────────────────────────────────────────────────

function getIssueByCompositeKey(atom_issue_id, playlist_id) {
  const db = getDb();
  const issue = db.prepare(`SELECT * FROM issues WHERE atom_issue_id=? AND playlist_id=?`).get(atom_issue_id, playlist_id);
  if (!issue) return null;

  const occurrences = db.prepare(`
    SELECT * FROM occurrences WHERE atom_issue_id=? AND playlist_id=?
    ORDER BY playout_start_time ASC
  `).all(atom_issue_id, playlist_id);

  const playlistTimeline = (issue.feed_code && issue.playlist_date)
    ? getPlaylistTimeline(issue.feed_code, issue.playlist_date) : [];

  // Previous ticket detail
  let previousTicketDetail = null;
  if (issue.previous_ticket_id && issue.previous_playlist_id) {
    previousTicketDetail = db.prepare(`
      SELECT t.*, i.playlist_date, i.playlist_start_time
      FROM tickets t
      JOIN issues i ON i.atom_issue_id=t.atom_issue_id AND i.playlist_id=t.playlist_id
      WHERE t.playlist_id=? AND t.feed_code=? LIMIT 1
    `).get(issue.previous_playlist_id, issue.feed_code);
  }

  return { issue, occurrences, playlistTimeline, previousTicketDetail };
}

function getIssueById(id) {
  const issue = getDb().prepare(`SELECT * FROM issues WHERE id=?`).get(id);
  if (!issue) return null;
  return getIssueByCompositeKey(issue.atom_issue_id, issue.playlist_id);
}

// ── General issue list ───────────────────────────────────────────────────────

function getIssues(filters = {}) {
  const db = getDb();
  let q = `
    SELECT i.*,
      MIN(o.playout_start_time) as first_occurrence,
      MAX(o.playout_start_time) as last_occurrence,
      COUNT(o.id) as occ_count
    FROM issues i
    LEFT JOIN occurrences o ON o.atom_issue_id=i.atom_issue_id AND o.playlist_id=i.playlist_id
    WHERE 1=1
  `;
  const params = [];
  applyFilters(filters, q, params, (c, v) => { q += c; params.push(...v); });
  q += ` GROUP BY i.atom_issue_id, i.playlist_id ORDER BY i.updated_at DESC`;
  return db.prepare(q).all(...params);
}

function applyFilters(filters, _q, _p, push) {
  if (filters.region)       push(` AND i.region=?`,               [filters.region]);
  if (filters.feed_code)    push(` AND i.feed_code LIKE ?`,        [`%${filters.feed_code}%`]);
  if (filters.issue_type)   push(` AND i.issue_type=?`,            [filters.issue_type]);
  if (filters.playlist_id)  push(` AND i.playlist_id=?`,           [filters.playlist_id]);
  if (filters.playlist_date)push(` AND i.playlist_date=?`,         [filters.playlist_date]);
  if (filters.acknowledged !== undefined && filters.acknowledged !== '')
    push(` AND i.acknowledged=?`, [filters.acknowledged === 'true' ? 1 : 0]);
  if (filters.has_ticket === 'true')  push(` AND i.ticket_link IS NOT NULL AND i.ticket_link!=''`, []);
  if (filters.has_ticket === 'false') push(` AND (i.ticket_link IS NULL OR i.ticket_link='')`, []);
  if (filters.penalty === 'true')     push(` AND i.penalty=1`, []);
  if (filters.state)        push(` AND i.state=?`,           [filters.state]);
  if (filters.date_from)    push(` AND i.playlist_date>=?`, [filters.date_from]);
  if (filters.date_to)      push(` AND i.playlist_date<=?`, [filters.date_to]);
  if (filters.severity) {
    const sev = String(filters.severity).split(',').map(x => x.trim()).filter(Boolean);
    if (sev.length) push(` AND i.severity IN (${sev.map(() => '?').join(',')})`, sev);
  }
  // ATOM lifecycle: open = active + snoozed (+ rows that predate ATOM state tracking)
  if (filters.atom_state === 'open')
    push(` AND (i.consolidated_status IS NULL OR i.consolidated_status NOT IN ('resolved'))`, []);
  else if (['active','snoozed','resolved'].includes(filters.atom_state))
    push(` AND i.consolidated_status=?`, [filters.atom_state]);
  // TOC split: the 4 canonical types vs every other ATOM type
  if (filters.toc_only === 'true')  push(` AND i.issue_type IN (${AT.ALERT_KEYS.map(() => '?').join(',')})`, AT.ALERT_KEYS);
  if (filters.toc_only === 'false') push(` AND (i.issue_type IS NULL OR i.issue_type NOT IN (${AT.ALERT_KEYS.map(() => '?').join(',')}))`, AT.ALERT_KEYS);
}

// Severity rank for ORDER BY (blocker first)
const SEVERITY_RANK_SQL = `CASE i.severity WHEN 'blocker' THEN 0 WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 WHEN 'dev' THEN 4 ELSE 5 END`;

function updateIssue(id, fields) {
  const db = getDb();
  const allowed = ['ticket_link','ticket_id','acknowledged','status','state',
    'consolidated_status','snoozed_until','snoozed_by','atom_writeback_error'];
  const sets = [], vals = [];
  for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]); }
  if (!sets.length) return false;
  sets.push('updated_at=CURRENT_TIMESTAMP');
  vals.push(id);
  db.prepare(`UPDATE issues SET ${sets.join(',')} WHERE id=?`).run(...vals);
  return true;
}

// ── Meta ─────────────────────────────────────────────────────────────────────

function getDistinctIssueTypes() {
  // Always return fixed enum keys — never dynamic
  return AT.ALERT_KEYS;
}

/** Non-TOC ATOM alert types present in the DB, with counts (for the "Other" filter group). */
function getOtherIssueTypes() {
  return getDb().prepare(`
    SELECT issue_type AS key, COUNT(*) AS count FROM issues
    WHERE issue_type IS NOT NULL AND issue_type NOT IN (${AT.ALERT_KEYS.map(() => '?').join(',')})
    GROUP BY issue_type ORDER BY count DESC, issue_type
  `).all(...AT.ALERT_KEYS).map(r => ({ ...r, label: AT.label(r.key) }));
}
function getDistinctRegions() {
  return getDb().prepare(`SELECT DISTINCT region FROM issues WHERE region IS NOT NULL ORDER BY region`).all().map(r => r.region);
}

function getStats(region) {
  const db = getDb();
  const w  = region ? `AND region='${region.replace(/'/g,"''")}'` : '';
  const now = new Date().toISOString();
  return {
    total:     db.prepare(`SELECT COUNT(*) as c FROM issues WHERE 1=1 ${w}`).get().c,
    upcoming:  db.prepare(`SELECT COUNT(*) as c FROM issues WHERE (playlist_start_time>=? OR playlist_start_time IS NULL) ${w}`).get(now).c,
    open:      db.prepare(`SELECT COUNT(*) as c FROM issues WHERE acknowledged=0 ${w}`).get().c,
    with_ticket: db.prepare(`SELECT COUNT(*) as c FROM issues WHERE ticket_link IS NOT NULL AND ticket_link!='' ${w}`).get().c,
    penalty:      db.prepare(`SELECT COUNT(*) as c FROM issues WHERE penalty=1 ${w}`).get().c,
    state_penalty:      db.prepare(`SELECT COUNT(*) as c FROM issues WHERE state='penalty' AND (playlist_start_time>=? OR playlist_start_time IS NULL) ${w}`).get(now).c,
    state_ack:          db.prepare(`SELECT COUNT(*) as c FROM issues WHERE state='ack' AND (playlist_start_time>=? OR playlist_start_time IS NULL) ${w}`).get(now).c,
    state_ticketed:     db.prepare(`SELECT COUNT(*) as c FROM issues WHERE state='ticketed' AND (playlist_start_time>=? OR playlist_start_time IS NULL) ${w}`).get(now).c,
    last_sync: db.prepare(`SELECT MAX(updated_at) as t FROM issues`).get().t,
    atom_active:   db.prepare(`SELECT COUNT(*) as c FROM issues WHERE consolidated_status='active' ${w}`).get().c,
    atom_snoozed:  db.prepare(`SELECT COUNT(*) as c FROM issues WHERE consolidated_status='snoozed' ${w}`).get().c,
    atom_resolved: db.prepare(`SELECT COUNT(*) as c FROM issues WHERE consolidated_status='resolved' ${w}`).get().c,
    toc_open:      db.prepare(`SELECT COUNT(*) as c FROM issues WHERE issue_type IN (${AT.ALERT_KEYS.map(k => `'${k}'`).join(',')}) AND (consolidated_status IS NULL OR consolidated_status!='resolved') ${w}`).get().c,
    other_open:    db.prepare(`SELECT COUNT(*) as c FROM issues WHERE (issue_type IS NULL OR issue_type NOT IN (${AT.ALERT_KEYS.map(k => `'${k}'`).join(',')})) AND (consolidated_status IS NULL OR consolidated_status!='resolved') ${w}`).get().c,
    by_severity:   Object.fromEntries(db.prepare(`SELECT COALESCE(severity,'unknown') s, COUNT(*) c FROM issues WHERE (consolidated_status IS NULL OR consolidated_status!='resolved') ${w} GROUP BY s`).all().map(r => [r.s, r.c])),
    writeback_errors: db.prepare(`SELECT COUNT(*) as c FROM issues WHERE atom_writeback_error IS NOT NULL ${w}`).get().c,
  };
}

module.exports = {
  getDb, upsertIssue, updateOccurrenceCount, insertOccurrenceIfNotExists,
  insertPlaylistVersionIfNew, resolvePlaylistAtTime, getPlaylistTimeline,
  checkAndMarkPersistence, findSameDayPreviousTicket, createTicket,
  getUpcomingIssues, getHistoryFeeds, getHistoryPlaylists, getHistoryIssues,
  getIssueById, getIssueByCompositeKey, getIssues, updateIssue,
  getDistinctIssueTypes, getDistinctRegions, getStats,
  getOpenAtomIssues, updateAtomLifecycle, getOtherIssueTypes,
};

// ══════════════════════════════════════════════════════════════════════════════
// FRESHDESK / CONTACT CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

function initFreshdeskSchema() {
  getDb().exec(`
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
      ticket_type      TEXT NOT NULL,
      subject          TEXT,
      requester_email  TEXT,
      status           TEXT DEFAULT 'open',
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migrations for issues table
  const safeAdd = (col, def) => {
    try {
      if (!getDb().prepare(`PRAGMA table_info(issues)`).all().some(r => r.name === col))
        getDb().exec(`ALTER TABLE issues ADD COLUMN ${col} ${def}`);
    } catch {}
  };
  safeAdd('ticket_type',       'TEXT');
  safeAdd('ticket_url',        'TEXT');
  safeAdd('ticket_created_at', 'DATETIME');
  safeAdd('freshdesk_id',      'INTEGER');

  // Migration 002 creates freshdesk_tickets without these columns, and because migrations run
  // before this CREATE TABLE IF NOT EXISTS, fresh databases never got them (ticket creation
  // then failed with "no column named ticket_type"). Add them idempotently.
  const fdCols = getDb().prepare(`PRAGMA table_info(freshdesk_tickets)`).all().map(r => r.name);
  const fdAdd = (col, def) => { if (!fdCols.includes(col)) getDb().exec(`ALTER TABLE freshdesk_tickets ADD COLUMN ${col} ${def}`); };
  fdAdd('ticket_type', "TEXT NOT NULL DEFAULT 'customer'");
  fdAdd('status',      "TEXT DEFAULT 'open'");
  fdAdd('updated_at',  'DATETIME');
}

// ── Feed ticket config ────────────────────────────────────────────────────────

function getFeedTicketConfig(feed_code) {
  return getDb().prepare(`SELECT * FROM feed_ticket_config WHERE feed_code = ?`).get(feed_code) || null;
}

function getAllFeedTicketConfigs() {
  return getDb().prepare(`SELECT * FROM feed_ticket_config ORDER BY feed_code`).all();
}

function upsertFeedTicketConfig(cfg) {
  getDb().prepare(`
    INSERT INTO feed_ticket_config
      (feed_code, customer_name, product_version, contact_email, cc_emails, use_general_for_all, updated_at)
    VALUES
      (@feed_code, @customer_name, @product_version, @contact_email, @cc_emails, @use_general_for_all, CURRENT_TIMESTAMP)
    ON CONFLICT(feed_code) DO UPDATE SET
      customer_name       = excluded.customer_name,
      product_version     = excluded.product_version,
      contact_email       = excluded.contact_email,
      cc_emails           = excluded.cc_emails,
      use_general_for_all = excluded.use_general_for_all,
      updated_at          = CURRENT_TIMESTAMP
  `).run(cfg);
  return getFeedTicketConfig(cfg.feed_code);
}

// ── Issue contact overrides ───────────────────────────────────────────────────

function getIssueOverridesForFeed(feed_code) {
  return getDb().prepare(`
    SELECT * FROM issue_contact_override WHERE feed_code = ? ORDER BY issue_type
  `).all(feed_code);
}

function upsertIssueOverride(ov) {
  getDb().prepare(`
    INSERT INTO issue_contact_override
      (feed_code, issue_type, contact_email, cc_emails, enabled, updated_at)
    VALUES
      (@feed_code, @issue_type, @contact_email, @cc_emails, @enabled, CURRENT_TIMESTAMP)
    ON CONFLICT(feed_code, issue_type) DO UPDATE SET
      contact_email = excluded.contact_email,
      cc_emails     = excluded.cc_emails,
      enabled       = excluded.enabled,
      updated_at    = CURRENT_TIMESTAMP
  `).run(ov);
}

function upsertManyIssueOverrides(feed_code, overrides) {
  const db = getDb();
  const run = db.transaction(() => {
    for (const ov of overrides) {
      upsertIssueOverride({ feed_code, ...ov });
    }
  });
  run();
}

// ── Contact resolution ────────────────────────────────────────────────────────

const INTERNAL_EMAIL       = process.env.INTERNAL_TICKET_EMAIL || 'amagisupportcontact@amagi.com';
const INTERNAL_CUSTOMER    = 'Internal - Amagi';

function resolveContacts(feed_code, issue_type, ticket_type) {
  if (ticket_type === 'internal') {
    return {
      contact_email: INTERNAL_EMAIL,
      cc_emails:     [],
      customer_name: INTERNAL_CUSTOMER,
      product_version: null,
    };
  }

  const cfg = getFeedTicketConfig(feed_code);
  const base = {
    contact_email:   cfg?.contact_email   || null,
    cc_emails:       parseCcEmails(cfg?.cc_emails),
    customer_name:   cfg?.customer_name   || null,
    product_version: cfg?.product_version || null,
  };

  // If use_general_for_all = false, check for issue-specific override
  if (cfg && !cfg.use_general_for_all) {
    const ovr = getDb().prepare(`
      SELECT * FROM issue_contact_override
      WHERE feed_code = ? AND issue_type = ? AND enabled = 1
    `).get(feed_code, issue_type); // issue_type is enum key (HOLE, NO_PLAYLIST, etc.)
    if (ovr) {
      return {
        ...base,
        contact_email: ovr.contact_email || base.contact_email,
        cc_emails:     parseCcEmails(ovr.cc_emails) || base.cc_emails,
      };
    }
  }

  return base;
}

function parseCcEmails(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// ── Subject generation ────────────────────────────────────────────────────────

// Alert type helpers delegated to alertTypes.js (single source of truth)
const ISSUE_TYPE_FRIENDLY = AT.ALERT_LABEL; // kept for backward compat

function friendlyIssueType(issue_type) {
  // issue_type is the enum key for the 4 TOC types, or the raw ATOM type for everything else
  const key = AT.isValid(issue_type) ? issue_type : (AT.toEnumKey(issue_type) || issue_type);
  return AT.label(key) || 'Unknown Issue';
}

function buildSubject(issue_type, feed_code, playlist_date) {
  const key = AT.isValid(issue_type) ? issue_type : (AT.toEnumKey(issue_type) || issue_type);
  return AT.buildSubject(key, feed_code, playlist_date);
}

// ── Description generation ────────────────────────────────────────────────────

const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const utcLabel = iso => { const ms = Date.parse(iso); return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC') : null; };

function fmtDuration(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 'Ongoing';
  const s = Math.round(n / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h && `${h}h`, m && `${m}m`, (r || (!h && !m)) && `${r}s`].filter(Boolean).join(' ');
}

const SEVERITY_LABEL = { blocker: 'Blocker', critical: 'Critical', major: 'Major', minor: 'Minor', dev: 'Dev' };

function buildDescription(issue, customer_name) {
  const feed  = issue.feed_code ? getAtomFeed(issue.feed_code) : null;
  const start = issue.earliest_scheduled || issue.playlist_start_time;
  const local = start && feed?.time_zone ? TZ.formatLocal(start, feed.time_zone) : null;

  const rows = [
    ['Feed',          (feed?.feed_name || issue.feed_name) ? `${issue.feed_code} (${feed?.feed_name || issue.feed_name})` : (issue.feed_code || '—')],
    ['AMG ID',        issue.amg_id],
    ['Issue Type',    friendlyIssueType(issue.issue_type) || '—'],
    ['Alert',         issue.alert_name],
    ['Severity',      SEVERITY_LABEL[issue.severity] || issue.severity],
    ['Details',       issue.description],
    ['Asset ID',      issue.asset_id     || '—'],
    ['Playlist ID',   issue.playlist_id  || '—'],
    ['Playlist Date', issue.playlist_date|| '—'],
    ['Start Time',    issue.playlist_start_time ? utcLabel(issue.playlist_start_time) : '—'],
    ['Issue Start',   start && issue.earliest_scheduled ? [utcLabel(start), local].filter(Boolean).join(' / ') : null],
    ['Duration',      fmtDuration(issue.duration_ms)],
    ['Headend',       issue.headend_code],
    ['Automation',    issue.automation_url],
    ['Customer',      customer_name || feed?.customer_name],
    ['ATOM Alert ID', issue.atom_issue_id],
    ['Link',          issue.source_url],
  ].filter(([, v]) => v != null && v !== '');

  const table = [
    '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:13px;">',
    '<tr style="background:#f5f5f5;"><th>Field</th><th>Value</th></tr>',
    ...rows.map(([f, v]) => `<tr><td><b>${f}</b></td><td>${esc(v)}</td></tr>`),
    '</table>',
  ].join('\n');

  const greetName = customer_name || feed?.customer_name;
  const intro = greetName
    ? `<p>Dear ${esc(greetName)} Team,</p><p>We have detected the following alert in your playout system. Please review the details below and take necessary action.</p>`
    : `<p>The following alert has been detected in the playout system. Please review and take necessary action.</p>`;

  const footer = `<p>Please do not hesitate to reach out if you need further assistance.</p><p>Regards,<br/>Amagi TOC Team</p>`;

  return `${intro}\n${table}\n${footer}`;
}

// Freshdesk priority: 1 Low, 2 Medium, 3 High, 4 Urgent
const SEVERITY_PRIORITY = { blocker: 4, critical: 4, major: 3, minor: 2, dev: 1 };
function priorityForSeverity(sev) { return SEVERITY_PRIORITY[sev] || 2; }

// ── Freshdesk payload builder ─────────────────────────────────────────────────

function buildFreshdeskPayload(issue, ticket_type) {
  const contacts = resolveContacts(issue.feed_code, issue.issue_type, ticket_type);
  const subject  = buildSubject(issue.issue_type, issue.feed_code, issue.playlist_date);
  const desc     = buildDescription(issue, contacts.customer_name);

  return {
    email:         contacts.contact_email,
    subject,
    description:   desc,
    priority:      priorityForSeverity(issue.severity),
    status:        2,
    cc_emails:     contacts.cc_emails,
    custom_fields: {
      customer_name:   contacts.customer_name   || undefined,
      product_version: contacts.product_version || undefined,
    },
    _meta: { contacts, subject, ticket_type },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ATOM FEED CATALOG (atom_feeds, migration 004)
// ══════════════════════════════════════════════════════════════════════════════

function getAtomFeed(feed_code) {
  if (!feed_code) return null;
  const row = getDb().prepare(`SELECT * FROM atom_feeds WHERE feed_code = ?`).get(feed_code);
  if (!row) return null;
  try { row.headends = row.headends_json ? JSON.parse(row.headends_json) : []; } catch { row.headends = []; }
  return row;
}

function upsertAtomFeed(f) {
  getDb().prepare(`
    INSERT INTO atom_feeds (feed_code, feed_name, automation_url, customer_name, amg_id, account_domain,
      time_zone, broadcast_start_time, days_to_monitor, headends_json, data_only, monitored, synced_at)
    VALUES (@feed_code, @feed_name, @automation_url, @customer_name, @amg_id, @account_domain,
      @time_zone, @broadcast_start_time, @days_to_monitor, @headends_json, @data_only, @monitored, CURRENT_TIMESTAMP)
    ON CONFLICT(feed_code) DO UPDATE SET
      feed_name = excluded.feed_name, automation_url = excluded.automation_url,
      customer_name = excluded.customer_name, amg_id = excluded.amg_id,
      account_domain = excluded.account_domain, time_zone = excluded.time_zone,
      broadcast_start_time = excluded.broadcast_start_time, days_to_monitor = excluded.days_to_monitor,
      headends_json = excluded.headends_json, data_only = excluded.data_only,
      monitored = excluded.monitored, synced_at = CURRENT_TIMESTAMP
  `).run({
    feed_code: f.feed_code, feed_name: f.feed_name ?? null, automation_url: f.automation_url ?? null,
    customer_name: f.customer_name ?? null, amg_id: f.amg_id ?? null, account_domain: f.account_domain ?? null,
    time_zone: f.time_zone ?? null, broadcast_start_time: f.broadcast_start_time ?? null,
    days_to_monitor: f.days_to_monitor ?? null,
    headends_json: f.headends ? JSON.stringify(f.headends) : null,
    data_only: f.data_only ? 1 : 0,
    monitored: f.monitored === undefined ? 1 : (f.monitored ? 1 : 0),
  });
}

/**
 * Is this alert on a feed/headend that ATOM monitors?
 * Unknown feed (not in catalog) → true (fail open). Customer data_only → false.
 * Alert names a headend whose monitoring is off → false. Feed with no monitored headend → false.
 */
function isAlertMonitored(issue) {
  const feed = getAtomFeed(issue.feed_code);
  if (!feed) return true;
  if (feed.data_only) return false;
  if (issue.headend_code) {
    const h = (feed.headends || []).find(x => x.code === issue.headend_code);
    if (h && h.health && h.health.monitoring === false) return false;
  }
  return feed.monitored !== 0;
}

/**
 * Remove untouched (Penalty, never ticketed) ATOM alerts on feeds now known to be unmonitored.
 * Rows someone triaged or ticketed are kept for the record.
 */
function purgeUnmonitoredAlerts() {
  const db = getDb();
  const ids = db.prepare(`
    SELECT i.atom_issue_id, i.playlist_id FROM issues i
    JOIN atom_feeds f ON f.feed_code = i.feed_code
    WHERE i.raw_type IS NOT NULL AND COALESCE(i.state,'penalty') = 'penalty'
      AND (i.ticket_id IS NULL OR i.ticket_id = '')
      AND (f.monitored = 0 OR f.data_only = 1)
  `).all();
  const delOcc = db.prepare(`DELETE FROM occurrences WHERE atom_issue_id=? AND playlist_id=?`);
  const delIss = db.prepare(`DELETE FROM issues WHERE atom_issue_id=? AND playlist_id=?`);
  db.transaction(() => { for (const r of ids) { delOcc.run(r.atom_issue_id, r.playlist_id); delIss.run(r.atom_issue_id, r.playlist_id); } })();
  return ids.length;
}

/** automation_urls seen on issues whose catalog entry is missing or older than maxAgeHours. */
function getStaleAutomationUrls(maxAgeHours) {
  return getDb().prepare(`
    SELECT DISTINCT i.automation_url AS url FROM issues i
    WHERE i.automation_url IS NOT NULL AND i.automation_url != ''
      AND NOT EXISTS (
        SELECT 1 FROM atom_feeds f
        WHERE f.automation_url = i.automation_url
          AND f.synced_at >= datetime('now', ?)
      )
  `).all(`-${Number(maxAgeHours) || 6} hours`).map(r => r.url);
}

/** True when the catalog for this automation was synced within maxAgeHours. */
function automationSyncedWithin(automation_url, maxAgeHours) {
  return !!getDb().prepare(`
    SELECT 1 FROM atom_feeds WHERE automation_url = ? AND synced_at >= datetime('now', ?) LIMIT 1
  `).get(automation_url, `-${Number(maxAgeHours) || 6} hours`);
}

function countAtomFeeds() {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM atom_feeds`).get().c;
}

/** Fill feed_ticket_config.customer_name from ATOM only when nobody has set it. */
function prefillCustomerName(feed_code, customer_name) {
  if (!feed_code || !customer_name) return false;
  const r = getDb().prepare(`
    INSERT INTO feed_ticket_config (feed_code, customer_name, use_general_for_all, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(feed_code) DO UPDATE SET
      customer_name = excluded.customer_name, updated_at = CURRENT_TIMESTAMP
    WHERE feed_ticket_config.customer_name IS NULL OR feed_ticket_config.customer_name = ''
  `).run(feed_code, customer_name);
  return r.changes > 0;
}

// ── Freshdesk ticket storage ──────────────────────────────────────────────────

function storeFreshdeskTicket({ atom_issue_id, playlist_id, feed_code, issue_type, asset_id,
  freshdesk_id, ticket_number, ticket_url, ticket_type, subject, requester_email }) {
  const db = getDb();

  db.prepare(`
    INSERT INTO freshdesk_tickets
      (atom_issue_id, playlist_id, feed_code, issue_type, asset_id,
       freshdesk_id, ticket_number, ticket_url, ticket_type, subject, requester_email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(atom_issue_id, playlist_id, feed_code, issue_type, asset_id || null,
         freshdesk_id || null, ticket_number || null, ticket_url || null,
         ticket_type, subject || null, requester_email || null);

  // Update issues table
  db.prepare(`
    UPDATE issues SET
      ticket_id         = ?,
      ticket_link       = ?,
      ticket_type       = ?,
      ticket_url        = ?,
      ticket_created_at = CURRENT_TIMESTAMP,
      freshdesk_id      = ?,
      updated_at        = CURRENT_TIMESTAMP
    WHERE atom_issue_id = ? AND playlist_id = ?
  `).run(ticket_number || String(freshdesk_id || ''), ticket_url || null,
         ticket_type, ticket_url || null, freshdesk_id || null,
         atom_issue_id, playlist_id);

  return db.prepare(`SELECT * FROM freshdesk_tickets WHERE id = last_insert_rowid()`).get();
}

function getFreshdeskTicketsForIssue(atom_issue_id, playlist_id) {
  return getDb().prepare(`
    SELECT * FROM freshdesk_tickets
    WHERE atom_issue_id = ? AND playlist_id = ?
    ORDER BY created_at DESC
  `).all(atom_issue_id, playlist_id);
}

function getDistinctFeedCodes() {
  return getDb().prepare(`SELECT DISTINCT feed_code FROM issues WHERE feed_code IS NOT NULL ORDER BY feed_code`).all().map(r => r.feed_code);
}

// ── Attach to initSchema ──────────────────────────────────────────────────────
// Call this after the main initSchema
initFreshdeskSchema._attached = false;

module.exports = Object.assign(module.exports || {}, {
  initFreshdeskSchema,
  getFeedTicketConfig,
  getAllFeedTicketConfigs,
  upsertFeedTicketConfig,
  getIssueOverridesForFeed,
  upsertIssueOverride,
  upsertManyIssueOverrides,
  resolveContacts,
  buildSubject,
  buildDescription,
  buildFreshdeskPayload,
  storeFreshdeskTicket,
  getFreshdeskTicketsForIssue,
  getDistinctFeedCodes,
  friendlyIssueType,
  ISSUE_TYPE_FRIENDLY,
  priorityForSeverity,
  fmtDuration,
  getAtomFeed,
  upsertAtomFeed,
  getStaleAutomationUrls,
  automationSyncedWithin,
  countAtomFeeds,
  isAlertMonitored,
  purgeUnmonitoredAlerts,
  prefillCustomerName,
});

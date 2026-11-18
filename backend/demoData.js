const AT = require('./alertTypes');

// demoData.js — Deterministic demo data seeded with "atom-demo"
// Playlist IDs use a global sequential counter (22262007, 22262008, …).
// Every publish or update — regardless of feed or date — consumes the next ID.
// Old IDs are never reused. Re-seeding is idempotent (ON CONFLICT DO NOTHING).

'use strict';

// ── Fixed master data ─────────────────────────────────────────────────────────

const FEEDS = [
  { feed_code: 'BALP_APAC_HD',  feed_name: 'Blue Ant Love Pets',  region: 'APAC' },
  { feed_code: 'OCA_APAC_HD',   feed_name: 'Outdoor Channel Asia', region: 'APAC' },
  { feed_code: 'FAILARMY_US',   feed_name: 'FailArmy FAST',        region: 'US'   },
  { feed_code: 'WSSPY_EMEA_HD', feed_name: 'WeatherSpy',           region: 'EMEA' },
  { feed_code: 'INSIGHTV_EMEA', feed_name: 'Insight TV',           region: 'EMEA' },
];

// Fixed enum keys — single source of truth from alertTypes.js
const ISSUE_TYPES = AT.ALERT_KEYS; // ['HOLE', 'NO_PLAYLIST', 'DURATION_MISMATCH', 'MISSING_IN_CLOUD']

const DATES = ['2026-04-13', '2026-04-14', '2026-04-15'];

// Playlist start times per date (fixed, UTC)
const PLAYLIST_START_HOURS = {
  '2026-04-13': '08:00:00',
  '2026-04-14': '10:00:00',
  '2026-04-15': '14:00:00',
};

const ASSETS = [
  'FC_BookLoversBookmark',
  'FC_LovePetsPromo',
  'FC_OutdoorSpot30',
  'FC_FailArmyClip01',
];

// Occurrence offsets from playlist start (minutes)
const OCCURRENCE_OFFSETS_MIN = [120, 360, 600]; // 02:00, 06:00, 10:00 after start

// Which 2 issue types each feed uses per date (indices into ISSUE_TYPES)
const FEED_DATE_ISSUES = {
  'BALP_APAC_HD':  { '2026-04-13': [0, 1], '2026-04-14': [1, 3], '2026-04-15': [0, 2] },
  'OCA_APAC_HD':   { '2026-04-13': [2, 3], '2026-04-14': [0, 3], '2026-04-15': [1, 2] },
  'FAILARMY_US':   { '2026-04-13': [0, 3], '2026-04-14': [1, 2], '2026-04-15': [0, 1] },
  'WSSPY_EMEA_HD': { '2026-04-13': [1, 2], '2026-04-14': [0, 2], '2026-04-15': [2, 3] },
  'INSIGHTV_EMEA': { '2026-04-13': [0, 3], '2026-04-14': [1, 3], '2026-04-15': [0, 2] },
};

const FEED_CONTACTS = {
  'BALP_APAC_HD':  { customer_name: 'Blue Ant Media',    contact_email: 'ops@blueant.com',    cc_emails: 'alerts@blueant.com',   product_version: '3.31' },
  'OCA_APAC_HD':   { customer_name: 'Outdoor Channel',   contact_email: 'ops@outdoor.com',    cc_emails: '',                     product_version: '3.28' },
  'FAILARMY_US':   { customer_name: 'FailArmy Inc',      contact_email: 'ops@failarmy.com',   cc_emails: 'noc@failarmy.com',     product_version: '3.30' },
  'WSSPY_EMEA_HD': { customer_name: 'WeatherSpy GmbH',   contact_email: 'ops@weatherspy.de',  cc_emails: '',                     product_version: '3.29' },
  'INSIGHTV_EMEA': { customer_name: 'Insight TV Europe', contact_email: 'ops@insighttv.eu',   cc_emails: 'support@insighttv.eu', product_version: '3.31' },
};

const BLUEANT_OVERRIDES = [
  { issue_type: AT.ALERT_ENUM.MISSING_IN_CLOUD,  contact_email: 'playout@blueant.com',  cc_emails: '',                enabled: 1 },
  { issue_type: AT.ALERT_ENUM.NO_PLAYLIST,        contact_email: 'schedule@blueant.com', cc_emails: 'ops@blueant.com', enabled: 1 },
  { issue_type: AT.ALERT_ENUM.HOLE,               contact_email: 'schedule@blueant.com', cc_emails: '',                enabled: 0 },
];

// ── Global sequential playlist ID counter ─────────────────────────────────────
// Starts at 22262007. Every publish or update for ANY feed/date consumes next().
// This mirrors real-world ATOM behavior where IDs are globally incremented.

const PLAYLIST_ID_START = 22262007;
let _playlistCounter = PLAYLIST_ID_START;
function nextPlaylistId() { return _playlistCounter++; }
function resetPlaylistCounter() { _playlistCounter = PLAYLIST_ID_START; }

// ── Playlist timeline definition ──────────────────────────────────────────────
// Each entry is: { date, feed_code, delta_min }
// They are processed in chronological order. Each entry gets next global ID.
//
// This is the global publish log — ordered by publish time across ALL feeds.
// Simulates: initial publishes for all feeds, then updates come in over the day.
//
// 2026-04-13 sequence (chronological across feeds):
//   08:00  BALP  initial   → 22262007
//   08:00  OCA   initial   → 22262008
//   08:00  FAIL  initial   → 22262009
//   08:00  WSSPY initial   → 22262010
//   08:00  INSGT initial   → 22262011
//   10:15  BALP  update    → 22262012   (BALP 2026-04-13 updated, gets next global ID)
//   10:30  OCA   update    → 22262013
//   12:30  BALP  update    → 22262014   (BALP 2026-04-13 updated again)
//   13:00  WSSPY update    → 22262015
// ... and so on for 2026-04-14 and 2026-04-15

const PUBLISH_LOG = [
  // ── 2026-04-13 initial publishes (all feeds at 08:00) ──
  { date: '2026-04-13', feed_code: 'BALP_APAC_HD',  delta_min:   0 },
  { date: '2026-04-13', feed_code: 'OCA_APAC_HD',   delta_min:   0 },
  { date: '2026-04-13', feed_code: 'FAILARMY_US',   delta_min:   0 },
  { date: '2026-04-13', feed_code: 'WSSPY_EMEA_HD', delta_min:   0 },
  { date: '2026-04-13', feed_code: 'INSIGHTV_EMEA', delta_min:   0 },
  // ── 2026-04-13 updates ──
  { date: '2026-04-13', feed_code: 'BALP_APAC_HD',  delta_min: 135 },  // 10:15
  { date: '2026-04-13', feed_code: 'OCA_APAC_HD',   delta_min: 150 },  // 10:30
  { date: '2026-04-13', feed_code: 'BALP_APAC_HD',  delta_min: 270 },  // 12:30 — BALP updated again
  { date: '2026-04-13', feed_code: 'WSSPY_EMEA_HD', delta_min: 300 },  // 13:00
  { date: '2026-04-13', feed_code: 'FAILARMY_US',   delta_min: 330 },  // 13:30

  // ── 2026-04-14 initial publishes (all feeds at 10:00) ──
  { date: '2026-04-14', feed_code: 'BALP_APAC_HD',  delta_min:   0 },
  { date: '2026-04-14', feed_code: 'OCA_APAC_HD',   delta_min:   0 },
  { date: '2026-04-14', feed_code: 'FAILARMY_US',   delta_min:   0 },
  { date: '2026-04-14', feed_code: 'WSSPY_EMEA_HD', delta_min:   0 },
  { date: '2026-04-14', feed_code: 'INSIGHTV_EMEA', delta_min:   0 },
  // ── 2026-04-14 updates ──
  { date: '2026-04-14', feed_code: 'OCA_APAC_HD',   delta_min:  90 },  // 11:30
  { date: '2026-04-14', feed_code: 'INSIGHTV_EMEA', delta_min: 120 },  // 12:00

  // ── 2026-04-15 initial publishes (all feeds at 14:00) ──
  { date: '2026-04-15', feed_code: 'BALP_APAC_HD',  delta_min:   0 },
  { date: '2026-04-15', feed_code: 'OCA_APAC_HD',   delta_min:   0 },
  { date: '2026-04-15', feed_code: 'FAILARMY_US',   delta_min:   0 },
  { date: '2026-04-15', feed_code: 'WSSPY_EMEA_HD', delta_min:   0 },
  { date: '2026-04-15', feed_code: 'INSIGHTV_EMEA', delta_min:   0 },
  // ── 2026-04-15 updates ──
  { date: '2026-04-15', feed_code: 'FAILARMY_US',   delta_min:  60 },  // 15:00
  { date: '2026-04-15', feed_code: 'BALP_APAC_HD',  delta_min: 120 },  // 16:00
  { date: '2026-04-15', feed_code: 'OCA_APAC_HD',   delta_min: 180 },  // 17:00
  { date: '2026-04-15', feed_code: 'WSSPY_EMEA_HD', delta_min: 240 },  // 18:00
  { date: '2026-04-15', feed_code: 'BALP_APAC_HD',  delta_min: 300 },  // 19:00 — BALP updated again
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toISO(dateStr, timeStr) {
  return `${dateStr}T${timeStr}Z`;
}

function addMinutes(isoTs, mins) {
  return new Date(new Date(isoTs).getTime() + mins * 60000).toISOString();
}

function makeIssueId(feed_code, date, issue_type) {
  return `${feed_code}_${date.replace(/-/g, '')}_${issue_type.replace(/\s+/g, '_').toUpperCase()}`;
}

// ── Main seed function ────────────────────────────────────────────────────────

function seedDemoData(db) {
  console.log('[demo] Seeding deterministic demo data (global sequential playlist IDs)…');

  // Reset counter so re-seeding always produces same IDs
  resetPlaylistCounter();

  // ── 1. Feed contacts & issue overrides ────────────────────────────────────

  for (const [feed_code, cfg] of Object.entries(FEED_CONTACTS)) {
    db.prepare(`
      INSERT INTO feed_ticket_config
        (feed_code, customer_name, product_version, contact_email, cc_emails, use_general_for_all)
      VALUES (?,?,?,?,?,1)
      ON CONFLICT(feed_code) DO UPDATE SET
        customer_name   = excluded.customer_name,
        product_version = excluded.product_version,
        contact_email   = excluded.contact_email,
        cc_emails       = excluded.cc_emails
    `).run(feed_code, cfg.customer_name, cfg.product_version, cfg.contact_email, cfg.cc_emails || '');
  }

  // Blue Ant has issue-specific overrides
  db.prepare(`UPDATE feed_ticket_config SET use_general_for_all=0 WHERE feed_code='BALP_APAC_HD'`).run();

  for (const ov of BLUEANT_OVERRIDES) {
    db.prepare(`
      INSERT INTO issue_contact_override (feed_code, issue_type, contact_email, cc_emails, enabled)
      VALUES ('BALP_APAC_HD', ?, ?, ?, ?)
      ON CONFLICT(feed_code, issue_type) DO UPDATE SET
        contact_email = excluded.contact_email,
        cc_emails     = excluded.cc_emails,
        enabled       = excluded.enabled
    `).run(ov.issue_type, ov.contact_email, ov.cc_emails, ov.enabled);
  }

  // ── 2. Build playlist timeline from PUBLISH_LOG ───────────────────────────
  // Each entry in PUBLISH_LOG gets the next global sequential playlist ID.
  // We also build a lookup: { feed+date → latest playlist_id } for issue assignment.

  // latestPlaylistId[feed_code][date] = most recently assigned playlist_id for that feed+date
  const latestPlaylistId = {};

  for (const entry of PUBLISH_LOG) {
    const { date, feed_code, delta_min } = entry;
    const feed      = FEEDS.find(f => f.feed_code === feed_code);
    const startHour = PLAYLIST_START_HOURS[date];
    const startTs   = toISO(date, startHour);
    const publishTs = addMinutes(startTs, delta_min);
    const pid       = String(nextPlaylistId()); // ← global sequential ID

    db.prepare(`
      INSERT INTO playlist_timeline (feed_code, playlist_date, playlist_id, published_at, region)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(feed_code, date, pid, publishTs, feed?.region || null);

    // Track latest ID per feed+date (last write wins — log is chronological)
    if (!latestPlaylistId[feed_code]) latestPlaylistId[feed_code] = {};
    latestPlaylistId[feed_code][date] = pid;
  }

  // ── 3. Issues and occurrences ─────────────────────────────────────────────
  // Each issue uses the LATEST playlist_id for that feed+date.
  // Occurrences resolve to whichever playlist_id was active at their playout time.

  let issueCount = 0;

  for (const feed of FEEDS) {
    for (const date of DATES) {
      const startHour      = PLAYLIST_START_HOURS[date];
      const playlist_start = toISO(date, startHour);
      const playlist_id    = latestPlaylistId[feed.feed_code]?.[date];
      if (!playlist_id) continue; // shouldn't happen but guard

      const issueTypeIdxs = FEED_DATE_ISSUES[feed.feed_code][date] || [0, 1];

      for (const typeIdx of issueTypeIdxs) {
        const issue_type    = ISSUE_TYPES[typeIdx];
        const atom_issue_id = makeIssueId(feed.feed_code, date, issue_type);
        const assetIdx      = (FEEDS.indexOf(feed) + typeIdx) % ASSETS.length;
        // No Playlist and Hole in Playlist don't have an associated asset
        const asset_id      = (issue_type === AT.ALERT_ENUM.NO_PLAYLIST || issue_type === AT.ALERT_ENUM.HOLE)
                              ? null : ASSETS[assetIdx];

        db.prepare(`
          INSERT INTO issues (
            atom_issue_id, playlist_id, feed_code, region,
            issue_type, consolidated_status,
            playlist_date, playlist_start_time, earliest_scheduled,
            status, penalty, asset_id, state, occurrence_count
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'penalty',0)
          ON CONFLICT(atom_issue_id, playlist_id) DO NOTHING
        `).run(
          atom_issue_id, playlist_id, feed.feed_code, feed.region,
          issue_type, 'active',
          date, playlist_start, playlist_start,
          'open', 1, asset_id
        );
        issueCount++;

        // Occurrences at fixed offsets — each resolves to the playlist
        // that was active (latest published_at <= playout_start_time) at that moment
        let occCount = 0;
        for (const offsetMin of OCCURRENCE_OFFSETS_MIN) {
          const playout_ts    = addMinutes(playlist_start, offsetMin);
          const resolved_pid  = resolvePlaylistAtTime(db, feed.feed_code, date, playout_ts);

          db.prepare(`
            INSERT INTO occurrences (
              atom_issue_id, playlist_id, playlist_start_time, playout_start_time,
              duration, asset_id, feed_code, region, playlist_date,
              issue_type, resolved_playlist_id, raw_payload
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT DO NOTHING
          `).run(
            atom_issue_id, playlist_id, playlist_start, playout_ts,
            `${30 + typeIdx * 15}s`,
            asset_id,
            feed.feed_code, feed.region, date,
            issue_type, resolved_pid,
            JSON.stringify({ demo: true, feed: feed.feed_code, date, issue_type })
          );
          occCount++;
        }

        db.prepare(`
          UPDATE issues SET occurrence_count=? WHERE atom_issue_id=? AND playlist_id=?
        `).run(occCount, atom_issue_id, playlist_id);
      }
    }
  }

  // ── 3b. ATOM enrichment: catalog, severity, lifecycle, non-TOC alert types ──
  seedAtomEnrichment(db, latestPlaylistId);

  // ── 4. Pre-create two demo Freshdesk tickets ──────────────────────────────

  _ticketCounter = 10001;

  const demoTickets = [
    { feed_code: 'BALP_APAC_HD', date: '2026-04-13', issue_type: AT.ALERT_ENUM.MISSING_IN_CLOUD,  ticket_type: 'customer' },
    { feed_code: 'FAILARMY_US',  date: '2026-04-14', issue_type: AT.ALERT_ENUM.DURATION_MISMATCH, ticket_type: 'internal' },
  ];

  for (const dt of demoTickets) {
    const tid       = nextTicketId();
    const pid       = latestPlaylistId[dt.feed_code]?.[dt.date];
    const aiid      = makeIssueId(dt.feed_code, dt.date, dt.issue_type);
    const tnum      = `INC-${tid}`;
    const turl      = `https://freshdesk.test/ticket/${tid}`;
    const email     = dt.ticket_type === 'internal'
                      ? 'amagisupportcontact@amagi.com'
                      : (FEED_CONTACTS[dt.feed_code]?.contact_email || 'ops@example.com');

    if (!pid) continue;
    const issueRow = db.prepare(`SELECT id FROM issues WHERE atom_issue_id=? AND playlist_id=?`).get(aiid, pid);
    if (!issueRow) continue;

    db.prepare(`
      INSERT INTO freshdesk_tickets
        (atom_issue_id, playlist_id, feed_code, issue_type, freshdesk_id,
         ticket_number, ticket_url, ticket_type, requester_email)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING
    `).run(aiid, pid, dt.feed_code, dt.issue_type, tid, tnum, turl, dt.ticket_type, email);

    db.prepare(`
      UPDATE issues SET
        ticket_id=?, ticket_link=?, ticket_type=?, ticket_url=?,
        ticket_created_at=CURRENT_TIMESTAMP, freshdesk_id=?
      WHERE atom_issue_id=? AND playlist_id=?
    `).run(tnum, turl, dt.ticket_type, turl, tid, aiid, pid);
  }

  // ── 5. Same-day persistence warning on Blue Ant 2026-04-13 MISSING_IN_CLOUD ──
  // INC-10001 was created for BALP on 2026-04-13. The issue also exists on
  // 2026-04-13 under a different (updated) playlist — mark it with the warning.

  const prevTicket = db.prepare(`
    SELECT * FROM freshdesk_tickets
    WHERE feed_code='BALP_APAC_HD' AND issue_type='Asset Missing' LIMIT 1
  `).get();

  if (prevTicket) {
    // Find the other BALP+2026-04-13+Asset Missing issue (different playlist_id)
    const otherIssues = db.prepare(`
      SELECT * FROM issues
      WHERE feed_code='BALP_APAC_HD' AND playlist_date='2026-04-13'
        AND issue_type='Asset Missing' AND playlist_id != ?
    `).all(prevTicket.playlist_id);

    for (const oi of otherIssues) {
      db.prepare(`
        UPDATE issues SET
          has_previous_ticket_same_day = 1,
          previous_ticket_id           = ?,
          previous_playlist_id         = ?,
          previous_playlist_time       = ?
        WHERE atom_issue_id=? AND playlist_id=?
      `).run(
        prevTicket.ticket_number,
        prevTicket.playlist_id,
        toISO('2026-04-13', PLAYLIST_START_HOURS['2026-04-13']),
        oi.atom_issue_id,
        oi.playlist_id
      );
    }
  }

  console.log(
    `[demo] Done — ${FEEDS.length} feeds, ${issueCount} issues, ` +
    `${PUBLISH_LOG.length} playlist timeline rows (IDs ${PLAYLIST_ID_START}–${_playlistCounter - 1}), ` +
    `2 demo tickets`
  );
}

// ── ATOM enrichment (deterministic) ───────────────────────────────────────────

const DEMO_ATOM_FEEDS = {
  BALP_APAC_HD:  { customer: 'Blue Ant Media',     automation: 'blueant.amagi.tv',    tz: 'Asia/Singapore',   bst: '06:00:00' },
  OCA_APAC_HD:   { customer: 'Outdoor Channel',    automation: 'outdoor.amagi.tv',    tz: 'Asia/Kolkata',     bst: '06:00:00' },
  FAILARMY_US:   { customer: 'Jukin Media',        automation: 'jukin.amagi.tv',      tz: 'America/New_York', bst: '05:00:00' },
  WSSPY_EMEA_HD: { customer: 'WeatherSpy Ltd',     automation: 'weatherspy.amagi.tv', tz: 'Europe/London',    bst: '00:00:00' },
  INSIGHTV_EMEA: { customer: 'Insight TV',         automation: 'insight.amagi.tv',    tz: 'Europe/Amsterdam', bst: '06:00:00' },
};

const DEMO_SEVERITY = { HOLE: 'critical', NO_PLAYLIST: 'blocker', DURATION_MISMATCH: 'minor', MISSING_IN_CLOUD: 'major' };
const DEMO_DESCRIPTION = {
  HOLE:              'Unscheduled gap detected between consecutive playlist events.',
  NO_PLAYLIST:       'No playlist has been published for the broadcast date.',
  DURATION_MISMATCH: 'Scheduled duration differs from the ingested asset duration.',
  MISSING_IN_CLOUD:  'Scheduled asset is not present in cloud storage.',
};
const DEMO_OTHER_ALERTS = [
  { feed_code: 'OCA_APAC_HD',   date: '2026-04-14', type: 'tarang_media_seq_stall_alert',               severity: 'critical', state: 'active',  name: 'Media sequence stall',        duration_ms: -1 },
  { feed_code: 'FAILARMY_US',   date: '2026-04-15', type: 'ingest_audio_channel_misconfiguration_alert', severity: 'major',    state: 'snoozed', name: 'Audio channel misconfigured', duration_ms: 900000 },
  { feed_code: 'WSSPY_EMEA_HD', date: '2026-04-13', type: 'medialive_degraded_status_alert',            severity: 'minor',    state: 'resolved', name: 'MediaLive degraded',         duration_ms: 120000 },
];

function seedAtomEnrichment(db, latestPlaylistId) {
  for (const feed of FEEDS) {
    const a = DEMO_ATOM_FEEDS[feed.feed_code];
    if (!a) continue;
    db.prepare(`
      INSERT INTO atom_feeds (feed_code, feed_name, automation_url, customer_name, amg_id, account_domain,
        time_zone, broadcast_start_time, days_to_monitor, headends_json, synced_at)
      VALUES (?,?,?,?,?,?,?,?,3,?,CURRENT_TIMESTAMP)
      ON CONFLICT(feed_code) DO NOTHING
    `).run(feed.feed_code, feed.feed_name, a.automation, a.customer, `amg-${feed.feed_code.toLowerCase()}`,
      a.automation.split('.')[0], a.tz, a.bst,
      JSON.stringify([
        { code: `${feed.feed_code.toLowerCase()}_main`,   name: 'Main',   active: true,  health: { playback: 'ok', monitoring: 'ok' } },
        { code: `${feed.feed_code.toLowerCase()}_backup`, name: 'Backup', active: false, health: { playback: feed.region === 'US' ? 'degraded' : 'ok', monitoring: 'ok' } },
      ]));

    // Enrich the TOC issues on this feed (only fields still empty — idempotent)
    for (const [type, sev] of Object.entries(DEMO_SEVERITY)) {
      db.prepare(`
        UPDATE issues SET
          severity       = COALESCE(severity, ?),
          alert_name     = COALESCE(alert_name, ?),
          description    = COALESCE(description, ?),
          raw_type       = COALESCE(raw_type, ?),
          product        = COALESCE(product, 'CP'),
          automation_url = COALESCE(automation_url, ?),
          headend_code   = COALESCE(headend_code, ?),
          duration_ms    = COALESCE(duration_ms, ?)
        WHERE feed_code = ? AND issue_type = ?
      `).run(sev, AT.label(type), DEMO_DESCRIPTION[type], type.toLowerCase(), a.automation,
        `${feed.feed_code.toLowerCase()}_main`, type === 'NO_PLAYLIST' ? -1 : 45000, feed.feed_code, type);
    }
  }

  // A few non-TOC ATOM alerts for the "Other ATOM Alerts" section
  for (const o of DEMO_OTHER_ALERTS) {
    const feed = FEEDS.find(f => f.feed_code === o.feed_code);
    const a    = DEMO_ATOM_FEEDS[o.feed_code];
    const pid  = latestPlaylistId[o.feed_code]?.[o.date];
    if (!feed || !pid) continue;
    const start = toISO(o.date, PLAYLIST_START_HOURS[o.date]);
    const id    = makeIssueId(o.feed_code, o.date, o.type);
    db.prepare(`
      INSERT INTO issues (atom_issue_id, playlist_id, feed_code, region, issue_type, raw_type, consolidated_status,
        playlist_date, playlist_start_time, earliest_scheduled, status, penalty, state, occurrence_count,
        severity, alert_name, description, product, automation_url, headend_code, duration_ms,
        snoozed_until, resolved_at, resolved_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'penalty',1,?,?,?,'CP',?,?,?,?,?,?)
      ON CONFLICT(atom_issue_id, playlist_id) DO NOTHING
    `).run(id, pid, o.feed_code, feed.region, o.type, o.type, o.state,
      o.date, start, addMinutes(start, 45), o.state === 'resolved' ? 'resolved' : 'open',
      o.severity, o.name, `${o.name} reported by ATOM on ${feed.feed_name}.`, a.automation,
      `${o.feed_code.toLowerCase()}_main`, o.duration_ms,
      o.state === 'snoozed' ? addMinutes(start, 240) : null,
      o.state === 'resolved' ? addMinutes(start, 60) : null,
      o.state === 'resolved' ? 'monitoring-service' : null);
    db.prepare(`
      INSERT INTO occurrences (atom_issue_id, playlist_id, playlist_start_time, playout_start_time, duration,
        feed_code, region, playlist_date, issue_type, resolved_playlist_id, raw_payload)
      SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM occurrences WHERE atom_issue_id=? AND playlist_id=?)
    `).run(id, pid, start, addMinutes(start, 45), o.duration_ms < 0 ? 'ongoing' : `${o.duration_ms / 1000}s`,
      o.feed_code, feed.region, o.date, o.type, pid,
      JSON.stringify({ demo: true, alert_id: id, type: o.type, severity: o.severity, state: o.state }), id, pid);
  }
}

// ── Resolve active playlist at a given time (SQLite query) ────────────────────
// Uses ORDER BY playlist_id DESC (highest sequential ID = most recent publish)
// which is equivalent to ORDER BY published_at DESC for sequential IDs.
function resolvePlaylistAtTime(db, feed_code, playlist_date, playout_ts) {
  const row = db.prepare(`
    SELECT playlist_id FROM playlist_timeline
    WHERE feed_code = ? AND playlist_date = ? AND published_at <= ?
    ORDER BY playlist_id DESC
    LIMIT 1
  `).get(feed_code, playlist_date, playout_ts);
  return row ? row.playlist_id : null;
}

// ── Ticket counter ────────────────────────────────────────────────────────────

let _ticketCounter = 10001;
function nextTicketId() { return _ticketCounter++; }

// Freshdesk mock sequence (starts after 2 pre-seeded tickets)
let _demoTicketSeq = 10003;
function nextDemoTicketId() { return ++_demoTicketSeq; }

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  seedDemoData,
  FEEDS,
  ISSUE_TYPES,
  DATES,
  PLAYLIST_START_HOURS,
  FEED_CONTACTS,
  PUBLISH_LOG,
  nextDemoTicketId,
  makeIssueId,
};

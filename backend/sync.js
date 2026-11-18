const cron        = require('node-cron');
const atomApi     = require('./atomApi');
const atomCatalog = require('./atomCatalog');
const db          = require('./db');

// Load budgets (ATOM went down under ~4k requests in 2 h — keep these conservative).
// The global rate cap in atomApi (ATOM_MAX_REQUESTS_PER_MIN, default 20) applies on top.
const SYNC_INTERVAL_MIN = Math.min(60, Math.max(5, Number(process.env.ATOM_SYNC_INTERVAL_MIN) || 10));
// GET /alerts/{id} checks per sync for alerts that dropped out of the fetch (oldest first)
const RESOLVE_CHECK_LIMIT = Number(process.env.ATOM_RESOLVE_CHECKS_PER_SYNC) || 25;
const RESOLVE_CONCURRENCY = 1;
// Published-playlist lookups: at most N per sync, and each feed+date at most every 30 minutes
const PLAYLIST_LOOKUPS_PER_SYNC = Number(process.env.ATOM_PLAYLIST_LOOKUPS_PER_SYNC) || 20;
const PLAYLIST_LOOKUP_TTL_MS = 30 * 60 * 1000;
const playlistLookedUp = new Map(); // feed__date → last lookup ms

let isSyncing=false, lastSyncTime=null, lastSyncStatus='never', lastSyncError=null;
let lastCounts = { issues: 0, occurrences: 0, playlist_versions: 0, resolved: 0, catalog_feeds: 0, truncated: false };

async function sync() {
  // In demo mode, data is seeded directly — no need to poll ATOM
  if (process.env.DEMO_MODE === 'true') {
    lastSyncTime   = new Date().toISOString();
    lastSyncStatus = 'demo';
    return;
  }
  if (isSyncing) return;
  if (atomApi.isPaused()) {
    lastSyncStatus = 'paused'; lastSyncError = atomApi.rateInfo().pause_reason;
    console.warn('[sync] skipped — ATOM calls are paused by the circuit breaker');
    return;
  }
  isSyncing = true; lastSyncStatus = 'running'; lastSyncError = null;
  console.log(`[sync] Start ${new Date().toISOString()}`);
  try {
    const feedLookup = fc => db.getAtomFeed(fc);
    let { issues, truncated, mode, viewErrors, failedViewIds = [] } = await atomApi.fetchAlerts({ feedLookup });
    const viewsMode = mode === 'views';
    if (viewsMode) db.saveAtomViews(atomApi.getViewList());

    // Refresh the feed catalog for automations on these alerts, then re-derive
    // region / broadcast date with the feeds' real timezones.
    const catalog = await atomCatalog.syncCatalog(issues.map(i => i.automation_url));
    if (catalog.feeds) issues = atomApi.applyFeedInfo(issues, feedLookup);

    // Scope. Views mode: the views (with ATOM's ignore rules) define what is in scope, so alerts that
    // left every view are purged (if untouched). Type mode: keep only monitored feeds/headends.
    const fetchedIds = new Set(issues.map(i => i.id));
    let skippedUnmonitored = 0, purged = 0;
    if (viewsMode) {
      if (!truncated) purged = db.purgeUntouchedNotIn(fetchedIds, failedViewIds);
    } else {
      const before = issues.length;
      issues = issues.filter(i => db.isAlertMonitored(i));
      skippedUnmonitored = before - issues.length;
      purged = atomApi.isLive() ? db.purgeUnmonitoredAlerts() : 0;
    }

    const plSynced = new Set();
    const seen = new Set();
    let plLookups = 0;
    let upserted=0, occs=0, plVers=0;

    for (const iss of issues) {
      seen.add(iss.id);
      db.upsertIssue({
        ...iss,
        atom_issue_id: iss.id,
        region: iss.region || null,
        status: iss.consolidated_status === 'resolved' ? 'resolved' : 'open',
        penalty: iss.penalty ? 1 : 0,
        state: 'penalty', // default for new issues; COALESCE in upsert preserves existing state
        atom_sync: atomApi.isLive(),
      });
      upserted++;

      // Playlist timeline (once per feed+date)
      const ptKey = `${iss.feed_code}__${iss.playlist_date}`;
      const recentlyLooked = Date.now() - (playlistLookedUp.get(ptKey) || 0) < PLAYLIST_LOOKUP_TTL_MS;
      if (iss.feed_code && iss.playlist_date && !plSynced.has(ptKey) && !recentlyLooked && plLookups < PLAYLIST_LOOKUPS_PER_SYNC) {
        plSynced.add(ptKey);
        playlistLookedUp.set(ptKey, Date.now());
        plLookups++;
        try {
          const vers = await atomApi.getPlaylistTimeline(iss.feed_code, iss.playlist_date, iss.region, iss.automation_url);
          for (const v of vers) if (db.insertPlaylistVersionIfNew(v)) plVers++;
        } catch {}
      }

      // Occurrences scoped to this playlist
      let details = [];
      try { details = await atomApi.getIssueDetails(iss); } catch {}
      for (const occ of details) {
        db.insertOccurrenceIfNotExists({
          atom_issue_id: occ.atom_issue_id, playlist_id: iss.playlist_id,
          playlist_start_time: iss.playlist_start_time||null,
          playout_start_time: occ.playout_start_time,
          duration: occ.duration, asset_id: occ.asset_id,
          feed_code: iss.feed_code, region: iss.region||null,
          playlist_date: iss.playlist_date, issue_type: occ.issue_type,
          raw_payload: occ.raw_payload,
        });
        occs++;
      }
      db.updateOccurrenceCount(iss.id, iss.playlist_id);

      // Check if a same-day previous playlist already had a ticket
      db.checkAndMarkPersistence(
        iss.id, iss.playlist_id, iss.feed_code, iss.issue_type,
        iss.asset_id, iss.playlist_date, iss.playlist_start_time
      );
    }

    // Alerts skipped as unmonitored still exist in ATOM — don't resolution-check them
    for (const id of fetchedIds) seen.add(id);
    // Resolution checks are skipped while any view failed (can't tell "left the view" from "not fetched")
    const incomplete = truncated || failedViewIds.length > 0;
    const resolved = await detectResolved(seen, incomplete);

    lastCounts = {
      issues: upserted, occurrences: occs, playlist_versions: plVers, resolved,
      skipped_unmonitored: skippedUnmonitored, purged_unmonitored: purged,
      mode: mode || 'types', views: viewsMode ? atomApi.getViewList().filter(v => v.selected).length : 0,
      view_errors: viewErrors ? viewErrors.length : 0,
      catalog_feeds: db.countAtomFeeds(), catalog_errors: catalog.errors.length, truncated: incomplete,
    };
    lastSyncTime = new Date().toISOString(); lastSyncStatus = 'success';
    try { db.setMeta('last_atom_sync', lastSyncTime); } catch {}
    console.log(`[sync] Done (${viewsMode ? `views:${lastCounts.views}` : 'types'}) — issues:${upserted} skippedUnmonitored:${skippedUnmonitored} purged:${purged} occs:${occs} plVers:${plVers} resolved:${resolved} catalogFeeds:${lastCounts.catalog_feeds}${truncated ? ' (TRUNCATED)' : failedViewIds.length ? ` (${failedViewIds.length} view(s) failed)` : ''}`);
  } catch (err) {
    lastSyncStatus='error'; lastSyncError=err.message;
    console.error('[sync] Failed:', err.message);
  } finally { isSyncing=false; }
}

/**
 * Alerts that were open locally but did not come back from ATOM have changed state
 * (resolved, or moved out of the fetched states). Confirm each with GET /alerts/{id}.
 * Skipped when the fetch was truncated, so a partial sync never marks alerts resolved.
 */
async function detectResolved(seen, truncated) {
  if (!atomApi.isLive() || truncated) return 0;
  const missing = db.getOpenAtomIssues().filter(id => !seen.has(id)).slice(0, RESOLVE_CHECK_LIMIT);
  let resolved = 0;
  const queue = [...missing];
  const worker = async () => { for (let id = queue.shift(); id !== undefined; id = queue.shift()) await checkOne(id); };
  const checkOne = async id => {
    try {
      const a = await atomApi.getAlert(id);
      if (!a) return; // unknown to ATOM (e.g. mock/legacy row) — leave untouched
      db.updateAtomLifecycle(id, {
        consolidated_status: a.state || 'resolved',
        snoozed_until: a.state === 'snoozed' ? a.snoozed_until : null,
        snoozed_by:    a.state === 'snoozed' ? a.snoozed_by : null,
        resolved_at:   a.state === 'resolved' ? (a.resolved_at || new Date().toISOString()) : null,
        resolved_by:   a.state === 'resolved' ? (a.resolved_by || null) : null,
        atom_updated_at: a.updated_at || null,
      });
      if (a.state === 'resolved') resolved++;
    } catch (err) {
      console.warn(`[sync] resolve check ${id}: ${err.message}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, worker));
  return resolved;
}

function startSyncScheduler() {
  // Don't sync on every restart (dev servers restart a lot): only if the last success is old enough
  let last = null;
  try { last = Date.parse(db.getMeta('last_atom_sync')); } catch {}
  const due = !Number.isFinite(last) || Date.now() - last >= SYNC_INTERVAL_MIN * 60e3;
  if (due) sync();
  else console.log(`[sync] last sync ${Math.round((Date.now() - last) / 60e3)} min ago — next on schedule`);
  cron.schedule(`*/${SYNC_INTERVAL_MIN} * * * *`, () => sync());
  console.log(`[sync] Scheduler started (every ${SYNC_INTERVAL_MIN} min, ATOM cap ${atomApi.rateInfo().limit_per_min} req/min)`);
}

module.exports = {
  startSyncScheduler,
  getSyncStatus: () => ({
    isSyncing, lastSyncTime, lastSyncStatus, lastSyncError,
    counts: lastCounts,
    atom_live: atomApi.isLive(),
    atom_writeback: atomApi.isWritebackEnabled(),
    atom_auth: atomApi.authInfo(),
    atom_rate: atomApi.rateInfo(),
    interval_min: SYNC_INTERVAL_MIN,
  }),
  triggerSync: () => sync(),
};

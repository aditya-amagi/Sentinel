const cron        = require('node-cron');
const atomApi     = require('./atomApi');
const atomCatalog = require('./atomCatalog');
const db          = require('./db');

// Load budgets (ATOM went down under ~4k requests in 2 h — keep these conservative).
// The global rate cap in atomApi (ATOM_MAX_REQUESTS_PER_MIN, default 20) applies on top.
// Each lane of ATOM views syncs on its own interval (minutes, 5–120):
//   asset    → "<Group> Asset [Alerts]" views          ATOM_SYNC_ASSET_MIN    (default 15)
//   schedule → "<Group> Schedule [Alerts]" views       ATOM_SYNC_SCHEDULE_MIN (default 30)
//   other    → Live views, Service Alerts, …          ATOM_SYNC_OTHER_MIN    (default 15)
// The scheduler ticks every 5 min and fetches only the lanes that are due (lanes due together share
// one run). Type mode (no views) syncs everything on the shortest interval.
const laneMin = (v, d) => Math.min(120, Math.max(5, Number(v) || d));
const LANE_INTERVAL_MIN = {
  asset:    laneMin(process.env.ATOM_SYNC_ASSET_MIN, 15),
  schedule: laneMin(process.env.ATOM_SYNC_SCHEDULE_MIN, 30),
  other:    laneMin(process.env.ATOM_SYNC_OTHER_MIN, 15),
};
const TICK_MIN = 5;
const SYNC_INTERVAL_MIN = Math.min(...Object.values(LANE_INTERVAL_MIN));
const laneMetaKey = lane => `last_atom_sync_${lane}`;
const lastLaneSync = {};   // lane → ISO time of its last successful sync
// GET /alerts/{id} checks per sync for alerts that dropped out of the fetch (oldest first)
const RESOLVE_CHECK_LIMIT = Number(process.env.ATOM_RESOLVE_CHECKS_PER_SYNC) || 25;
const RESOLVE_CONCURRENCY = 1;
// Published-playlist lookups: at most N per sync, and each feed+date at most every 30 minutes
const PLAYLIST_LOOKUPS_PER_SYNC = Number(process.env.ATOM_PLAYLIST_LOOKUPS_PER_SYNC) || 20;
const PLAYLIST_LOOKUP_TTL_MS = 30 * 60 * 1000;
const playlistLookedUp = new Map(); // feed__date → last lookup ms

let isSyncing=false, lastSyncTime=null, lastSyncStatus='never', lastSyncError=null;
let lastCounts = { issues: 0, occurrences: 0, playlist_versions: 0, resolved: 0, catalog_feeds: 0, truncated: false };

/** lanes: which view lanes to fetch (subset of atomApi.LANES); omitted = all (manual sync, tests). */
async function sync({ lanes } = {}) {
  lanes = lanes && lanes.length ? lanes : atomApi.LANES;
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
  const partial = lanes.length < atomApi.LANES.length;
  console.log(`[sync] Start ${new Date().toISOString()} (${partial ? lanes.join(' + ') : 'all lanes'})`);
  try {
    const feedLookup = fc => db.getAtomFeed(fc);
    let { issues, truncated, mode, viewErrors, failedViewIds = [], fetchedViewIds = [] } =
      await atomApi.fetchAlerts({ feedLookup, lanes, priorViews: db.getPriorViewMembership() });
    const viewsMode = mode === 'views';
    if (viewsMode) db.saveAtomViews(atomApi.getViewList());
    // Selected views not fetched this run (other lanes, or failed): their alerts are left alone
    const fetchedSet = new Set(fetchedViewIds);
    const unfetchedViewIds = viewsMode
      ? atomApi.getViewList().filter(v => v.selected && !fetchedSet.has(v.id)).map(v => v.id) : [];

    // Refresh the feed catalog for automations on these alerts, then re-derive
    // region / broadcast date with the feeds' real timezones.
    const catalog = await atomCatalog.syncCatalog(issues.map(i => i.automation_url));
    if (catalog.feeds) issues = atomApi.applyFeedInfo(issues, feedLookup);

    // Scope. Views mode: the views (with ATOM's ignore rules) define what is in scope, so alerts that
    // left every view are purged (if untouched). Type mode: keep only monitored feeds/headends.
    const fetchedIds = new Set(issues.map(i => i.id));
    let skippedUnmonitored = 0, purged = 0;
    if (viewsMode) {
      if (!truncated) {
        purged = db.purgeUntouchedNotIn(fetchedIds, unfetchedViewIds);
        db.pruneViewMembership(fetchedIds, fetchedViewIds);
      }
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
    }

    // Playlist versions come from the alerts themselves (works even when the playlist endpoint is 403),
    // then flag alerts whose earlier playlist version was already ticketed
    plVers += db.recordVersionsFromAlerts(issues);
    for (const iss of issues) db.checkAndMarkPersistence(iss.id, iss.playlist_id);

    // Alerts skipped as unmonitored still exist in ATOM — don't resolution-check them
    for (const id of fetchedIds) seen.add(id);
    // Resolution checks are skipped while any view failed (can't tell "left the view" from "not fetched");
    // alerts in views of other lanes are checked when their lane syncs
    const incomplete = truncated || failedViewIds.length > 0;
    const resolved = await detectResolved(seen, incomplete, unfetchedViewIds);

    lastCounts = {
      issues: upserted, occurrences: occs, playlist_versions: plVers, resolved,
      skipped_unmonitored: skippedUnmonitored, purged_unmonitored: purged,
      mode: mode || 'types', views: viewsMode ? atomApi.getViewList().filter(v => v.selected).length : 0,
      view_errors: viewErrors ? viewErrors.length : 0,
      catalog_feeds: db.countAtomFeeds(), catalog_errors: catalog.errors.length, truncated: incomplete,
      lanes, views_fetched: fetchedViewIds.length,
    };
    lastSyncTime = new Date().toISOString(); lastSyncStatus = 'success';
    // Type mode fetches everything, so every lane is fresh
    for (const lane of viewsMode ? lanes : atomApi.LANES) {
      lastLaneSync[lane] = lastSyncTime;
      try { db.setMeta(laneMetaKey(lane), lastSyncTime); } catch {}
    }
    try { db.setMeta('last_atom_sync', lastSyncTime); } catch {}
    console.log(`[sync] Done (${viewsMode ? `views:${fetchedViewIds.length} [${lanes.join('+')}]` : 'types'}) — issues:${upserted} skippedUnmonitored:${skippedUnmonitored} purged:${purged} occs:${occs} plVers:${plVers} resolved:${resolved} catalogFeeds:${lastCounts.catalog_feeds}${truncated ? ' (TRUNCATED)' : failedViewIds.length ? ` (${failedViewIds.length} view(s) failed)` : ''}`);
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
async function detectResolved(seen, truncated, skipViewIds = []) {
  if (!atomApi.isLive() || truncated) return 0;
  const missing = db.getOpenAtomIssues(skipViewIds).filter(id => !seen.has(id)).slice(0, RESOLVE_CHECK_LIMIT);
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

/** Lanes whose last successful sync is older than their interval (1 min slack for tick jitter). */
function dueLanes(now = Date.now()) {
  return atomApi.LANES.filter(lane => {
    let last = Date.parse(lastLaneSync[lane]);
    if (!Number.isFinite(last)) {
      // Before per-lane tracking existed, fall back to the last full sync
      try { last = Date.parse(db.getMeta(laneMetaKey(lane)) || db.getMeta('last_atom_sync')); } catch {}
    }
    return !Number.isFinite(last) || now - last >= (LANE_INTERVAL_MIN[lane] - 1) * 60e3;
  });
}

function tick() {
  const lanes = dueLanes();
  if (lanes.length) return sync({ lanes });
}

function startSyncScheduler() {
  // Don't sync on every restart (dev servers restart a lot): only lanes that are actually due
  const due = dueLanes();
  if (due.length) sync({ lanes: due });
  else console.log('[sync] all lanes synced recently — next on schedule');
  cron.schedule(`*/${TICK_MIN} * * * *`, () => tick());
  const every = Object.entries(LANE_INTERVAL_MIN).map(([l, m]) => `${l} ${m} min`).join(', ');
  console.log(`[sync] Scheduler started (${every}; ATOM cap ${atomApi.rateInfo().limit_per_min} req/min)`);
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
    lane_interval_min: LANE_INTERVAL_MIN,
    lane_last_sync: Object.fromEntries(atomApi.LANES.map(l => [l, lastLaneSync[l] || null])),
  }),
  triggerSync: (opts) => sync(opts),
  dueLanes,
};

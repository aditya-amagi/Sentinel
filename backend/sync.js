const cron        = require('node-cron');
const atomApi     = require('./atomApi');
const atomCatalog = require('./atomCatalog');
const db          = require('./db');

// GET /alerts/{id} checks per sync for alerts that dropped out of the fetch (oldest first)
const RESOLVE_CHECK_LIMIT = Number(process.env.ATOM_RESOLVE_CHECKS_PER_SYNC) || 200;
const RESOLVE_CONCURRENCY = 8;
// Published-playlist lookups: at most N per sync, and each feed+date at most every 30 minutes
const PLAYLIST_LOOKUPS_PER_SYNC = Number(process.env.ATOM_PLAYLIST_LOOKUPS_PER_SYNC) || 150;
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
  isSyncing = true; lastSyncStatus = 'running'; lastSyncError = null;
  console.log(`[sync] Start ${new Date().toISOString()}`);
  try {
    const feedLookup = fc => db.getAtomFeed(fc);
    let { issues, truncated } = await atomApi.fetchAlerts({ feedLookup });

    // Refresh the feed catalog for automations on these alerts, then re-derive
    // region / broadcast date with the feeds' real timezones.
    const catalog = await atomCatalog.syncCatalog(issues.map(i => i.automation_url));
    if (catalog.feeds) issues = atomApi.applyFeedInfo(issues, feedLookup);

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

    const resolved = await detectResolved(seen, truncated);

    lastCounts = {
      issues: upserted, occurrences: occs, playlist_versions: plVers, resolved,
      catalog_feeds: db.countAtomFeeds(), catalog_errors: catalog.errors.length, truncated,
    };
    lastSyncTime = new Date().toISOString(); lastSyncStatus = 'success';
    console.log(`[sync] Done — issues:${upserted} occs:${occs} plVers:${plVers} resolved:${resolved} catalogFeeds:${lastCounts.catalog_feeds}${truncated ? ' (TRUNCATED)' : ''}`);
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
  sync();
  cron.schedule('*/5 * * * *', () => sync());
  console.log('[sync] Scheduler started (every 5 min)');
}

module.exports = {
  startSyncScheduler,
  getSyncStatus: () => ({
    isSyncing, lastSyncTime, lastSyncStatus, lastSyncError,
    counts: lastCounts,
    atom_live: atomApi.isLive(),
    atom_writeback: atomApi.isWritebackEnabled(),
    atom_auth: atomApi.authInfo(),
  }),
  triggerSync: () => sync(),
};

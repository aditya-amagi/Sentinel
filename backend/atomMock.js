// atomMock.js — realistic offline ATOM (used when ATOM_BASE_URL is empty).
//
// Produces raw alerts in the exact shape prod ATOM returns (observed 2026-11-18) and the same kind
// of saved views, so mock mode exercises the real ingestion path: views → normalise → catalog →
// dashboard. Alerts are deterministic per UTC day and evolve: each has a lifetime after which it
// disappears from its views (resolved), and a few are snoozed. Nothing here touches the network.

'use strict';

// Groups mirror prod view groups; feeds/customers are fictional.
const GROUPS = [
  { group: 'EMEA', tz: 'Europe/London', customers: [
    { name: 'Northwind Media', automation: 'northwind.cloudport.amagi.tv', amg: 'AMG10021', feeds: [['NWM1', 'Northwind One'], ['NWMNEWS', 'Northwind News']] },
    { name: 'Alpenblick TV', automation: 'alpenblick.cloudport.amagi.tv', amg: 'AMG10044', tz: 'Europe/Berlin', feeds: [['ALPHD', 'Alpenblick HD']] } ] },
  { group: 'APAC', tz: 'Asia/Kolkata', customers: [
    { name: 'Lotus Broadcast', automation: 'lotus.cloudport.amagi.tv', amg: 'AMG20117', feeds: [['LOTUS1', 'Lotus Movies'], ['LOTUSKID', 'Lotus Kids']] },
    { name: 'Harbour Pacific', automation: 'harbour.cloudport.amagi.tv', amg: 'AMG20230', tz: 'Australia/Sydney', feeds: [['HPSPORT', 'Harbour Sport']] } ] },
  { group: 'America', tz: 'America/New_York', customers: [
    { name: 'Prairie Networks', automation: 'prairie.cloudport.amagi.tv', amg: 'AMG30311', feeds: [['PRNFAST', 'Prairie FAST'], ['PRNWX', 'Prairie Weather']] },
    { name: 'Andes Media', automation: 'andes.cloudport.amagi.tv', amg: 'AMG30479', tz: 'America/Bogota', feeds: [['ANDES', 'Andes Uno']] } ] },
  { group: 'Enterprise Customer', tz: 'Asia/Manila', customers: [
    { name: 'Archipelago TV', automation: 'archipelago.cloudport.amagi.tv', amg: 'AMG40055', feeds: [['ARCHI1', 'Archipelago One'], ['ARCHI2', 'Archipelago Two']] } ] },
  { group: 'Bein EMEA', tz: 'Asia/Qatar', customers: [
    { name: 'Gulf Sports Group', automation: 'gulfsports.cloudport.amagi.tv', amg: 'AMG50008', feeds: [['GSG1', 'Gulf Sports 1'], ['GSG2', 'Gulf Sports 2']] } ] },
];

// View ids/names follow prod; "All CP Alerts" is a catch-all Sentinel does not select by default.
const VIEWS = [
  { id: 1,  name: 'All CP Alerts' },
  { id: 13, name: 'Enterprise Customer Schedule Alerts' }, { id: 14, name: 'Enterprise Customer Asset Alerts' }, { id: 15, name: 'Enterprise Customer Live Alerts' },
  { id: 16, name: 'EMEA Schedule Alerts' },    { id: 17, name: 'EMEA Asset Alerts' },    { id: 18, name: 'EMEA Live Alerts' },
  { id: 19, name: 'APAC Schedule Alerts' },    { id: 20, name: 'APAC Asset Alerts' },    { id: 21, name: 'APAC Live Alerts' },
  { id: 31, name: 'America Schedule Alerts' }, { id: 32, name: 'America Asset Alerts' }, { id: 33, name: 'America Live Alerts' },
  { id: 38, name: 'Playout Rescue' },
  { id: 53, name: 'Bein EMEA Asset' },
];

// Type mix per family, weighted like prod (asset_missing_in_cloud dominates Schedule views)
const FAMILY_TYPES = {
  Schedule: [['asset_missing_in_cloud', 6, 'asset'], ['hole_in_playlist', 3, 'playlist'], ['no_published_playlist', 2, 'playlist'], ['asset_duration_mismatch', 1, 'playlist']],
  Asset:    [['asset_missing_in_cloud', 4, 'asset'], ['asset_failed', 3, 'asset'], ['asset_qc_failed', 1, 'asset'], ['asset_download_waiting', 2, 'asset']],
  Live:     [['ingest_configuration_issue_alert', 2, 'ingest'], ['ingest_health_error_black_frame', 1, 'ingest']],
  Rescue:   [['player_rescue_detected_alert', 1, 'player']],
};
const NAMES = {
  asset_missing_in_cloud: 'asset missing in cloud', hole_in_playlist: 'hole in playlist',
  no_published_playlist: 'no published playlist', asset_duration_mismatch: 'asset duration mismatch',
  asset_failed: 'asset failed', asset_qc_failed: 'asset QC failed', asset_download_waiting: 'asset download waiting',
  ingest_configuration_issue_alert: 'ingest configuration issue', ingest_health_error_black_frame: 'black frame on ingest',
  player_rescue_detected_alert: 'rescue content played',
};
const SEVERITY = {
  no_published_playlist: 'critical', hole_in_playlist: 'major', asset_missing_in_cloud: 'major', asset_duration_mismatch: 'minor',
  asset_failed: 'major', asset_qc_failed: 'minor', asset_download_waiting: 'minor', ingest_configuration_issue_alert: 'major',
  ingest_health_error_black_frame: 'critical', player_rescue_detected_alert: 'critical',
};

function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h / 2 ** 32; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function weighted(r, list) {
  const total = list.reduce((n, x) => n + x[1], 0);
  let x = r() * total;
  for (const item of list) { x -= item[1]; if (x <= 0) return item; }
  return list[list.length - 1];
}
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dateIn = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** All feeds with their group, customer and timezone. */
function allFeeds() {
  const out = [];
  for (const g of GROUPS) for (const c of g.customers) for (const [code, name] of c.feeds) {
    out.push({ group: g.group, customer: c, code, name, tz: c.tz || g.tz });
  }
  return out;
}

/**
 * Today's alerts (seeded by UTC day + yesterday, so alerts carry over midnight) that are still
 * "open" at `now`. Returns { alerts, membership: Map(alert_id → [view ids]) }.
 */
function generate(now = Date.now()) {
  const viewByName = new Map(VIEWS.map(v => [v.name, v.id]));
  const feeds = allFeeds();
  const alerts = [];
  const membership = new Map();
  const dayMs = 864e5;

  for (const dayOffset of [-1, 0]) {
    const day = Math.floor(now / dayMs) * dayMs + dayOffset * dayMs;
    const r = rng(`sentinel-mock-${iso(day).slice(0, 10)}`);
    const count = 70;
    for (let i = 0; i < count; i++) {
      const f = pick(r, feeds);
      const family = r() < 0.12 ? 'Rescue' : weighted(r, [['Schedule', 6], ['Asset', 3], ['Live', 1]])[0];
      const [type, , service] = weighted(r, FAMILY_TYPES[family]);
      const created = day + Math.floor(r() * dayMs);
      if (created > now) continue;                                   // not raised yet
      // Most alerts are about upcoming playout (hours ahead); rescue/ingest/live happen "now"
      const ahead = family === 'Rescue' || family === 'Live' ? 0 : Math.floor((0.5 + r() * 47) * 3600e3);
      const start = created + ahead;
      const lifetime = Math.floor((1 + r() * 30) * 3600e3);          // resolves after 1–31 h
      if (created + lifetime < now) continue;                        // already resolved → gone from views
      const duration = type === 'no_published_playlist' ? 86400000
        : family === 'Live' ? -1
        : family === 'Rescue' ? Math.floor((20 + r() * 400) * 1000)
        : Math.floor((5 + r() * 900) * 1000);
      const id = String(900000000 + Math.floor(day / dayMs) * 1000 + i);
      const playlistDate = dateIn(start, f.tz);
      const assetId = service === 'asset' || type === 'asset_duration_mismatch' ? `${f.code}_${Math.floor(r() * 90000) + 10000}` : null;
      const snoozed = r() < 0.08;
      const custom = {
        automation_url: f.customer.automation, account_domain: f.customer.automation.split('.')[0], feed_code: f.code,
        ...(service === 'playlist' || service === 'asset' ? { playlist_date: playlistDate } : {}),
        ...(assetId ? { asset_id: assetId, asset_title: `${f.name} — item ${assetId.slice(-4)}` } : {}),
        ...(service === 'player' || service === 'ingest' ? { headend_code: `${f.code.toLowerCase()}_main` } : {}),
      };
      alerts.push({
        alert_id: id,
        dedup_key: id.slice(-16).padStart(16, 'a'),
        correlation_id: `mock-${id}`,
        name: NAMES[type] || type, type,
        description: type === 'no_published_playlist'
          ? `playlists exist but none are published for feed ${f.code} on ${playlistDate}`
          : `${NAMES[type] || type} on ${f.name}${assetId ? ` (asset ${assetId})` : ''}`,
        severity: SEVERITY[type] || 'major',
        timestamp: iso(created), issue_start_time: iso(start), duration,
        source_id: family === 'Rescue' ? 'player' : 'atom_syncer', version: 'v1.0.2',
        custom_details: { feed_code: f.code, ...(service === 'playlist' || service === 'asset'
          ? { playlist_date: playlistDate, playlist_url: `https://${f.customer.automation}/nexus/plec/#/${f.code}/playlists/${playlistDate}/` } : {}) },
        labels: { feed_name: f.name, feed_time_zone: f.tz },
        entity: { id: id.padStart(16, '0'), name: f.name, service, amgID: f.customer.amg, product: 'CP', custom },
        state: snoozed ? 'snoozed' : 'active',
        ...(snoozed ? { snoozed_until: iso(now + 2 * 3600e3), snoozed_by: 'toc.operator@amagi.com' } : {}),
        created_at: iso(created), updated_at: iso(created), transitions: [],
      });
      const viewName = family === 'Rescue' ? 'Playout Rescue'
        : f.group === 'Bein EMEA' ? (family === 'Asset' || type === 'asset_missing_in_cloud' ? 'Bein EMEA Asset' : null)
        : `${f.group} ${family} Alerts`;
      const ids = [viewByName.get('All CP Alerts')];
      if (viewName && viewByName.has(viewName)) ids.push(viewByName.get(viewName));
      membership.set(id, ids);
    }
  }
  return { alerts, membership };
}

/** Customer record like GET /customers/{url}?detailed=true. */
function customer(automation_url) {
  for (const g of GROUPS) for (const c of g.customers) {
    if (c.automation !== automation_url) continue;
    return {
      name: c.name, url: c.automation, days_to_monitor: 3, data_only: false,
      accounts: [{ amg_id: c.amg, domain: c.automation.split('.')[0], automation_url: c.automation,
        feeds: c.feeds.map(([code, name]) => ({
          code, name, time_zone: c.tz || g.tz, broadcast_start_time: '06:00:00', days_to_monitor: 3,
          headends: [
            { code: `${code.toLowerCase()}_main`,   name: 'Main',   active: true,  health: { monitoring: true,  playback: 'ok' } },
            { code: `${code.toLowerCase()}_backup`, name: 'Backup', active: false, health: { monitoring: false, playback: 'standby' } },
          ],
        })) }],
    };
  }
  return null;
}

module.exports = { generate, customer, VIEWS };

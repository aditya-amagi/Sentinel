// atomMock.js — realistic offline ATOM (used when ATOM_BASE_URL is empty).
//
// Produces raw alerts in the exact shape prod ATOM returns (observed 2026-11-18) and the same kind
// of saved views, so mock mode exercises the real ingestion path: views → normalise → catalog →
// dashboard. Alerts are deterministic per UTC day and evolve: each has a lifetime after which it
// disappears from its views (resolved), and a few are snoozed. Nothing here touches the network.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Production snapshot replay ────────────────────────────────────────────────
// If backend/data/atom_snapshot.json exists (captured by scripts/atomSnapshot.js from a real
// view-based sync), mock mode replays production exactly: same views, alerts, feeds, customers.
// Times move forward in whole days so broadcast dates stay consistent. ATOM_MOCK_SNAPSHOT=off
// forces the generated data below; ATOM_MOCK_SNAPSHOT=<path> uses another file.
const SNAPSHOT_SETTING = process.env.ATOM_MOCK_SNAPSHOT || path.join(__dirname, 'data', 'atom_snapshot.json');
let snapshot = null;
function loadSnapshot() {
  if (snapshot !== null) return snapshot || null;
  snapshot = false;
  if (/^off$/i.test(SNAPSHOT_SETTING)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(SNAPSHOT_SETTING, 'utf8'));
    if (Array.isArray(s.views) && Array.isArray(s.alerts)) {
      snapshot = s;
      console.log(`[mock] replaying production snapshot from ${s.captured_at}: ${s.alerts.length} alerts, ${s.views.length} views`);
    }
  } catch { /* no snapshot → generated mock */ }
  return snapshot || null;
}

const DAY = 864e5;
const shiftIso = (v, ms) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t + ms).toISOString().replace(/\.000Z$/, 'Z') : v; };
const shiftDate = (d, days) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return d;
  return new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
};

// ATOM_MOCK_SAMPLE=N keeps only the N most recent alerts per view and alert type (default 3), so
// the mock stays small but every view and type is still represented. ATOM_MOCK_SAMPLE=all replays everything.
function sampleSize() {
  const v = String(process.env.ATOM_MOCK_SAMPLE ?? '3').trim();
  if (/^(all|0|)$/i.test(v)) return Infinity;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function sample(alerts, membership, n) {
  if (!Number.isFinite(n)) return alerts;
  const buckets = new Map();
  const sorted = alerts.slice().sort((a, b) => String(b.issue_start_time).localeCompare(String(a.issue_start_time)));
  const keep = new Set();
  for (const a of sorted) {
    for (const vid of membership.get(String(a.alert_id)) || ['none']) {
      const key = `${vid}|${a.type}`;
      const c = buckets.get(key) || 0;
      if (c < n) { buckets.set(key, c + 1); keep.add(a.alert_id); }
    }
  }
  return alerts.filter(a => keep.has(a.alert_id));
}

function replay(s, now) {
  const days = Math.max(0, Math.floor((now - Date.parse(s.captured_at)) / DAY));
  const ms = days * DAY;
  const membership = new Map(Object.entries(s.membership || {}).map(([k, v]) => [k, v]));
  const source = sample(s.alerts, membership, sampleSize());
  if (!days) return { alerts: source, membership };
  const alerts = source.map(a => {
    const b = JSON.parse(JSON.stringify(a));
    for (const k of ['issue_start_time', 'created_at', 'updated_at', 'timestamp', 'snoozed_until', 'snoozed_at', 'resolved_at']) if (b[k]) b[k] = shiftIso(b[k], ms);
    for (const o of [b.entity?.custom, b.custom_details]) {
      if (!o) continue;
      if (o.playlist_date) {
        const nd = shiftDate(o.playlist_date, days);
        if (o.playlist_url) o.playlist_url = String(o.playlist_url).split(o.playlist_date).join(nd);
        o.playlist_date = nd;
      }
    }
    return b;
  });
  return { alerts, membership };
}

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
  { group: 'AN1', tz: 'America/Los_Angeles', customers: [
    { name: 'Amagi NOW Channels 1', automation: 'anvir1.now.amagi.tv', amg: 'AMG01868', feeds: [['AMG01868C1', 'NOW Comedy'], ['AMG01888C7', 'NOW Retro']] } ] },
  { group: 'AN2', tz: 'America/Chicago', customers: [
    { name: 'Amagi NOW Channels 2', automation: 'anvir2.now.amagi.tv', amg: 'AMG00658', feeds: [['AMG00658C10', 'NOW Outdoors'], ['AMG00658C11', 'NOW Cooking']] } ] },
  { group: 'AN3', tz: 'Europe/Madrid', customers: [
    { name: 'Amagi NOW Channels 3', automation: 'anvir3.now.amagi.tv', amg: 'AMG00069', feeds: [['AMG00069C1', 'NOW Clásicos'], ['AMG00069C2', 'NOW Música']] } ] },
  { group: 'Cloudport Now', tz: 'Asia/Singapore', customers: [
    { name: 'Cloudport NOW', automation: 'cloudport.now.amagi.tv', amg: 'AMG00376', feeds: [['AMG00376C1', 'Nexus Travel'], ['AMG00376C10', 'Nexus Docs']] } ] },
  { group: 'Bein EMEA', tz: 'Asia/Qatar', customers: [
    { name: 'Gulf Sports Group', automation: 'gulfsports.cloudport.amagi.tv', amg: 'AMG50008', feeds: [['GSG1', 'Gulf Sports 1'], ['GSG2', 'Gulf Sports 2']] } ] },
];

// View ids/names follow prod; "All CP Alerts" is a catch-all Sentinel does not select by default.
const VIEWS = [
  { id: 1,  name: 'All CP Alerts' },
  { id: 13, name: 'Enterprise Customer Schedule Alerts' }, { id: 14, name: 'Enterprise Customer Asset Alerts' }, { id: 15, name: 'Enterprise Customer Live Alerts' },
  { id: 16, name: 'EMEA Schedule Alerts' },    { id: 17, name: 'EMEA Asset Alerts' },    { id: 18, name: 'EMEA Live Alerts' },
  { id: 19, name: 'APAC Schedule Alerts' },    { id: 20, name: 'APAC Asset Alerts' },    { id: 21, name: 'APAC Live Alerts' },
  { id: 22, name: 'AN3 Schedule Alerts' },     { id: 23, name: 'AN3 Asset Alerts' },     { id: 24, name: 'AN3 Live Alerts' },
  { id: 25, name: 'AN1 Schedule Alerts' },     { id: 26, name: 'AN1 Asset Alerts' },     { id: 27, name: 'AN1 Live Alerts' },
  { id: 28, name: 'Cloudport Now Schedule Alerts' }, { id: 29, name: 'Cloudport Now Asset Alerts' }, { id: 30, name: 'Cloudport Now Live Alerts' },
  { id: 31, name: 'America Schedule Alerts' }, { id: 32, name: 'America Asset Alerts' }, { id: 33, name: 'America Live Alerts' },
  { id: 34, name: 'AN2 Schedule Alerts' },     { id: 35, name: 'AN2 Asset Alerts' },     { id: 36, name: 'AN2 Live Alerts' },
  { id: 45, name: 'All AN3 Alerts' },
  { id: 37, name: 'Service Alerts' },
  { id: 38, name: 'Playout Rescue' },
  { id: 53, name: 'Bein EMEA Asset' },
];

// Type mix per family, weighted like prod (asset_missing_in_cloud dominates Schedule views)
const FAMILY_TYPES = {
  Schedule: [['asset_missing_in_cloud', 6, 'asset'], ['hole_in_playlist', 3, 'playlist'], ['no_published_playlist', 2, 'playlist'], ['asset_duration_mismatch', 1, 'playlist']],
  Asset:    [['asset_missing_in_cloud', 4, 'asset'], ['asset_failed', 3, 'asset'], ['asset_qc_failed', 1, 'asset'], ['asset_download_waiting', 2, 'asset']],
  Live:     [['ingest_configuration_issue_alert', 2, 'ingest'], ['ingest_health_error_black_frame', 1, 'ingest']],
  Service:  [['player_no_input_stream_alert', 2, 'player'], ['sidekiq_high_crash_status_alert', 1, 'service'], ['plsh_pubnub_connection_failure_status_alert', 1, 'service']],
};
const NAMES = {
  asset_missing_in_cloud: 'asset missing in cloud', hole_in_playlist: 'hole in playlist',
  no_published_playlist: 'no published playlist', asset_duration_mismatch: 'asset duration mismatch',
  asset_failed: 'asset failed', asset_qc_failed: 'asset QC failed', asset_download_waiting: 'asset download waiting',
  ingest_configuration_issue_alert: 'ingest configuration issue', ingest_health_error_black_frame: 'black frame on ingest',
  player_no_input_stream_alert: 'no input stream on player', sidekiq_high_crash_status_alert: 'sidekiq crashing',
  plsh_pubnub_connection_failure_status_alert: 'pubnub connection failure',
};
const SEVERITY = {
  no_published_playlist: 'critical', hole_in_playlist: 'major', asset_missing_in_cloud: 'major', asset_duration_mismatch: 'minor',
  asset_failed: 'major', asset_qc_failed: 'minor', asset_download_waiting: 'minor', ingest_configuration_issue_alert: 'major',
  ingest_health_error_black_frame: 'critical', player_no_input_stream_alert: 'critical',
  sidekiq_high_crash_status_alert: 'major', plsh_pubnub_connection_failure_status_alert: 'major',
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
  const snap = loadSnapshot();
  if (snap) return replay(snap, now);
  const viewByName = new Map(VIEWS.map(v => [v.name, v.id]));
  const feeds = allFeeds();
  const alerts = [];
  const membership = new Map();
  const dayMs = 864e5;

  for (const dayOffset of [-1, 0]) {
    const day = Math.floor(now / dayMs) * dayMs + dayOffset * dayMs;
    const r = rng(`sentinel-mock-${iso(day).slice(0, 10)}`);
    const count = 110;
    for (let i = 0; i < count; i++) {
      const f = pick(r, feeds);
      const family = r() < 0.12 ? 'Service' : weighted(r, [['Schedule', 6], ['Asset', 3], ['Live', 1]])[0];
      const [type, , service] = weighted(r, FAMILY_TYPES[family]);
      const created = day + Math.floor(r() * dayMs);
      if (created > now) continue;                                   // not raised yet
      // Most alerts are about upcoming playout (hours ahead); service/ingest/live happen "now"
      const ahead = family === 'Service' || family === 'Live' ? 0 : Math.floor((0.5 + r() * 47) * 3600e3);
      const start = created + ahead;
      const lifetime = Math.floor((1 + r() * 30) * 3600e3);          // resolves after 1–31 h
      if (created + lifetime < now) continue;                        // already resolved → gone from views
      const duration = type === 'no_published_playlist' ? 86400000
        : family === 'Live' ? -1
        : family === 'Service' ? Math.floor((20 + r() * 400) * 1000)
        : Math.floor((5 + r() * 900) * 1000);
      const id = String(900000000 + Math.floor(day / dayMs) * 1000 + i);
      const playlistDate = dateIn(start, f.tz);
      const assetId = service === 'asset' || type === 'asset_duration_mismatch' ? `${f.code}_${Math.floor(r() * 90000) + 10000}` : null;
      const snoozed = r() < 0.08;
      // Published playlist id per feed + broadcast date (sequential like CloudPort's)
      const playlistId = 400000 + (Math.abs([...`${f.code}${playlistDate}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 90000);
      const custom = {
        automation_url: f.customer.automation, account_domain: f.customer.automation.split('.')[0], feed_code: f.code,
        ...(service === 'playlist' || service === 'asset' ? { playlist_date: playlistDate, playlist_id: String(playlistId) } : {}),
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
        source_id: family === 'Service' ? 'player' : 'atom_syncer', version: 'v1.0.2',
        custom_details: { feed_code: f.code, ...(service === 'playlist' || service === 'asset'
          ? { playlist_date: playlistDate, blip_playlist_id: playlistId, playlist_url: `https://${f.customer.automation}/nexus/plec/#/${f.code}/playlists/${playlistDate}/` } : {}) },
        labels: { feed_name: f.name, feed_time_zone: f.tz },
        entity: { id: id.padStart(16, '0'), name: f.name, service, amgID: f.customer.amg, product: 'CP', custom },
        state: snoozed ? 'snoozed' : 'active',
        ...(snoozed ? { snoozed_until: iso(now + 2 * 3600e3), snoozed_by: 'toc.operator@amagi.com' } : {}),
        created_at: iso(created), updated_at: iso(created), transitions: [],
      });
      const viewName = family === 'Service' ? 'Service Alerts'
        : f.group === 'Bein EMEA' ? (family === 'Asset' || type === 'asset_missing_in_cloud' ? 'Bein EMEA Asset' : null)
        : `${f.group} ${family} Alerts`;
      // Republish: ~1 in 6 playlist/asset alerts was also raised on the previous playlist version
      // (same feed, day, type, asset/start; lower playlist id) — a separate ATOM alert, as in prod
      if ((service === 'playlist' || service === 'asset') && r() < 0.17) {
        const prev = JSON.parse(JSON.stringify(alerts[alerts.length - 1]));
        const prevPid = playlistId - 1 - Math.floor(r() * 3);
        prev.alert_id = String(Number(id) + 500);
        prev.dedup_key = prev.alert_id.slice(-16).padStart(16, 'b');
        prev.entity.custom.playlist_id = String(prevPid);
        prev.custom_details.blip_playlist_id = prevPid;
        prev.created_at = prev.timestamp = prev.updated_at = iso(created - Math.floor((1 + r() * 5) * 3600e3));
        prev.state = 'active'; delete prev.snoozed_until; delete prev.snoozed_by;
        alerts.push(prev);
        membership.set(prev.alert_id, null);   // filled in below with the same views
        alerts[alerts.length - 1]._twinOf = id;
      }
      const ids = [viewByName.get('All CP Alerts')];
      if (f.group === 'AN3') ids.push(viewByName.get('All AN3 Alerts'));   // catch-all, not selected
      if (viewName && viewByName.has(viewName)) ids.push(viewByName.get(viewName));
      membership.set(id, ids);
      for (const a of alerts) if (a._twinOf === id) { membership.set(a.alert_id, ids.slice()); delete a._twinOf; }
    }
  }
  return { alerts, membership };
}

/** Customer record like GET /customers/{url}?detailed=true. */
function customer(automation_url) {
  const snap = loadSnapshot();
  if (snap) return snap.customers?.[automation_url] || null;
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

/** The ATOM views mock mode exposes (snapshot views when replaying). */
function views() {
  const snap = loadSnapshot();
  return snap ? snap.views.map(v => ({ id: v.id, name: v.name })) : VIEWS;
}

module.exports = { generate, customer, views, VIEWS, isReplay: () => !!loadSnapshot() };

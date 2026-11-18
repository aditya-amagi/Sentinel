// atomApi.js — ATOM API client (ATOM v1 API, spec at <base>/docs.yaml)
//
// Modes:
//   DEMO_MODE=true   → no polling; deterministic data is pre-seeded into SQLite (demoData.js)
//   ATOM_BASE_URL set → real ATOM API (e.g. https://am-staging.amagi.tv/v1/api)
//   neither set       → random mock data (development fallback)
//
// Auth (first one configured wins):
//   ATOM_API_KEY                 → header  X-API-Key: <key>                      (service key, no expiry)
//   ATOM_REFRESH_TOKEN           → SSO refresh token; access token renewed via POST /auth/sso/refresh
//                                  before expiry and on 401. Rotated refresh tokens are saved to
//                                  ATOM_SESSION_FILE so restarts keep working. ATOM_BEARER_TOKEN, if
//                                  set, is used as the first access token.
//   ATOM_BEARER_TOKEN            → header  Authorization: Bearer <jwt>          (static, expires)
//   ATOM_EMAIL + ATOM_PASSWORD   → POST /auth/user/login; token cached, renewed on expiry/401
//
// Reads:  GET /alerts, GET /alerts/{id}, GET /cache/published_playlist,
//         GET /customers/{automation_url}/feeds/{feed_code}/playlist, GET /customers/{automation_url}
// Writes: PATCH /alerts (snooze / desnooze / comment) — only when ATOM_WRITEBACK=true.
//         Sentinel never resolves ATOM alerts and never patches labels/custom_details
//         (ATOM replaces those fields wholesale).

'use strict';

const axios = require('axios');
const AT    = require('./alertTypes');
const TZ    = require('./atomTime');

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const BASE_URL  = (process.env.ATOM_BASE_URL || '').replace(/\/+$/, '');
const DEMO_MODE = process.env.DEMO_MODE === 'true';

const API_KEY      = process.env.ATOM_API_KEY      || '';
const BEARER_TOKEN = process.env.ATOM_BEARER_TOKEN || '';
const EMAIL        = process.env.ATOM_EMAIL        || '';
const PASSWORD     = process.env.ATOM_PASSWORD     || '';
const REFRESH_TOKEN = process.env.ATOM_REFRESH_TOKEN || '';
const SESSION_FILE  = process.env.ATOM_SESSION_FILE || path.join(__dirname, '.atom_session.json');

// Alert types pulled by default — chosen from a prod census (Nov 2026, 21k open CP alerts):
// the 4 TOC types plus real fault types. Pipeline-progress states (asset_download_waiting,
// asset_submitted, asset_queued — 13.5k alerts) are deliberately excluded.
// ATOM_ALERT_TYPES overrides this list; ATOM_ALERT_TYPES=* pulls every type.
const DEFAULT_ALERT_TYPES = [
  // TOC
  'asset_missing_in_cloud', 'hole_in_playlist', 'no_published_playlist', 'asset_duration_mismatch',
  // Other faults
  'ingest_configuration_issue_alert', 'player_rescue_detected_alert', 'asset_failed', 'asset_qc_failed',
  'player_no_playlist_scheduled_status_alert', 'ingest_health_error_black_frame', 'ingest_health_error_freeze_frame',
  'incorrect_som', 'sidekiq_high_crash_status_alert', 'subtitle_tcin_not_present_status_alert',
  'player_websocket_handshake_bad_gateway_status_alert', 'tardis_livein_app_incorrect_config_status_alert',
  'avs_av_sync_failure_alert', 'avs_subtitle_sync_failure_alert', 'playlist_publish_blocked_status_alert',
  'player_no_input_stream_alert', 'plsh_pubnub_connection_failure_status_alert',
  'playlist_missing_in_player_status_alert', 'tarang_media_seq_stall_alert',
];
const RAW_TYPES   = (process.env.ATOM_ALERT_TYPES || '').trim();
const ALERT_TYPES = RAW_TYPES === '*' || RAW_TYPES.toLowerCase() === 'all' ? [] : (RAW_TYPES ? csv(RAW_TYPES) : DEFAULT_ALERT_TYPES);
// Only alerts whose issue starts within the last N hours (or later — upcoming) are pulled. 0 = no window.
const LOOKBACK_HOURS = Number(process.env.ATOM_LOOKBACK_HOURS ?? 72);
const ALERT_STATES = csv(process.env.ATOM_ALERT_STATES || 'active,snoozed');
const PRODUCT      = process.env.ATOM_PRODUCT ?? 'CP';
const PAGE_SIZE    = clamp(parseInt(process.env.ATOM_PAGE_SIZE, 10) || 500, 1, 1000); // spec max 1000
const MAX_PAGES    = Math.max(1, parseInt(process.env.ATOM_MAX_PAGES, 10) || 20);

const client = BASE_URL ? axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  timeout: 15000,
}) : null;

const IS_LIVE = Boolean(client) && !DEMO_MODE;
const WRITEBACK_ENABLED = IS_LIVE && process.env.ATOM_WRITEBACK === 'true';

// ── Auth ──────────────────────────────────────────────────────────────────────

let session = null; // { token, expiresAt } for email/password login
const authState = { lastRefreshAt: null, lastError: null };

function authMode() {
  if (API_KEY)            return 'api_key';
  if (REFRESH_TOKEN)      return 'refresh';
  if (BEARER_TOKEN)       return 'bearer';
  if (EMAIL && PASSWORD)  return 'login';
  return 'none';
}

/** `exp` claim of a JWT as epoch ms (no signature check — only used to schedule renewal). */
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

async function login() {
  const res = await client.post('/auth/user/login', { email: EMAIL, password: PASSWORD });
  const { token, expires_at } = res.data || {};
  if (!token) throw new Error('ATOM login succeeded but returned no token');
  const exp = Date.parse(expires_at);
  session = { token, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 30 * 60 * 1000 };
  return token;
}

// ── SSO refresh-token session ─────────────────────────────────────────────────
// Refresh tokens rotate: each POST /auth/sso/refresh returns a new one and the old one stops
// working. The latest pair is kept in SESSION_FILE (0600). `seed` fingerprints the env token the
// file grew from, so pasting a new ATOM_REFRESH_TOKEN into .env takes precedence over the file.
const seedOf = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
let sso = null;        // { seed, refresh_token, token, expiresAt }
let refreshing = null; // in-flight refresh promise (single-flight: rotation breaks parallel refreshes)

function loadSso() {
  if (sso) return sso;
  const seed = seedOf(REFRESH_TOKEN);
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (saved.seed === seed && saved.refresh_token) {
      sso = { seed, refresh_token: saved.refresh_token, token: saved.token || null, expiresAt: saved.expiresAt || 0 };
      return sso;
    }
  } catch {}
  sso = { seed, refresh_token: REFRESH_TOKEN, token: BEARER_TOKEN || null, expiresAt: BEARER_TOKEN ? (jwtExpiry(BEARER_TOKEN) || 0) : 0 };
  return sso;
}

function saveSso() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...sso, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn(`[atom] could not save session to ${SESSION_FILE}: ${err.message}`);
  }
}

async function refreshSso() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cur = loadSso();
    try {
      const res = await client.post('/auth/sso/refresh', { refresh_token: cur.refresh_token });
      const { token, refresh_token, expires_at } = res.data || {};
      if (!token) throw new Error('refresh succeeded but returned no token');
      const exp = Date.parse(expires_at);
      sso = { ...cur, token, refresh_token: refresh_token || cur.refresh_token,
        expiresAt: Number.isFinite(exp) ? exp : (jwtExpiry(token) || Date.now() + 30 * 60 * 1000) };
      saveSso();
      authState.lastRefreshAt = new Date().toISOString();
      authState.lastError = null;
      console.log(`[atom] access token renewed (expires ${new Date(sso.expiresAt).toISOString()})`);
      return sso.token;
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error || err.message;
      authState.lastError = `Token refresh failed${status ? ` (${status})` : ''}: ${msg}. Copy a fresh refresh token from the ATOM web app into ATOM_REFRESH_TOKEN.`;
      throw new Error(authState.lastError);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function ssoToken({ force = false } = {}) {
  const cur = loadSso();
  if (!force && cur.token && cur.expiresAt - 2 * 60_000 > Date.now()) return cur.token;
  return refreshSso();
}

async function authHeaders() {
  switch (authMode()) {
    case 'api_key': return { 'X-API-Key': API_KEY };
    case 'refresh': return { Authorization: `Bearer ${await ssoToken()}` };
    case 'bearer':  return { Authorization: `Bearer ${BEARER_TOKEN}` };
    case 'login': {
      const fresh = session && session.expiresAt - 60_000 > Date.now();
      return { Authorization: `Bearer ${fresh ? session.token : await login()}` };
    }
    default:
      throw new Error('ATOM_BASE_URL is set but no credentials: set ATOM_API_KEY, ATOM_REFRESH_TOKEN, ATOM_BEARER_TOKEN, or ATOM_EMAIL + ATOM_PASSWORD');
  }
}

/** Auth status for the UI / sync status (never includes secrets). */
function authInfo() {
  const mode = authMode();
  const info = { mode, last_refresh_at: authState.lastRefreshAt, error: authState.lastError };
  if (mode === 'refresh' && sso?.expiresAt) info.expires_at = new Date(sso.expiresAt).toISOString();
  if (mode === 'login' && session?.expiresAt) info.expires_at = new Date(session.expiresAt).toISOString();
  if (mode === 'bearer') {
    const exp = jwtExpiry(BEARER_TOKEN);
    if (exp) { info.expires_at = new Date(exp).toISOString(); if (exp < Date.now()) info.error = 'ATOM_BEARER_TOKEN has expired — paste a new one or set ATOM_REFRESH_TOKEN'; }
  }
  return info;
}

/** Authenticated request. With login/refresh auth, a 401 forces one renewal and retry. */
async function atomRequest(method, path, { params, data } = {}) {
  const send = async () => client.request({ method, url: path, params, data, headers: await authHeaders() });
  try {
    return await send();
  } catch (err) {
    const mode = authMode();
    if (err.response?.status === 401 && (mode === 'login' || mode === 'refresh')) {
      try {
        if (mode === 'login') session = null;
        else await ssoToken({ force: true });
        return await send();
      } catch (e2) { throw e2.response ? describeError(e2, method, path) : e2; }
    }
    throw describeError(err, method, path);
  }
}
const atomGet = (path, params) => atomRequest('get', path, { params });

function describeError(err, method, path) {
  const status = err.response?.status;
  const body   = err.response?.data;
  const msg    = body?.error || body?.message || err.message;
  const e = new Error(`ATOM ${method.toUpperCase()} ${path} failed${status ? ` (${status})` : ''}: ${msg}`);
  e.status = status;
  return e;
}

// ── Alerts ────────────────────────────────────────────────────────────────────

// Last fetched raw alerts by alert_id, so getIssueDetails() needs no extra request.
const alertCache = new Map();

/**
 * Fetch all matching alerts (all pages).
 * @param {object}   opts
 * @param {function} opts.feedLookup feed_code → atom_feeds row (timezone etc.), optional
 * @returns {{issues: object[], truncated: boolean}}
 */
async function fetchAlerts({ feedLookup } = {}) {
  if (DEMO_MODE) return { issues: [], truncated: false };
  if (!client)   return { issues: mockIssues(ri(26, 38)), truncated: false };

  // Production ATOM only supports the singular `state` / `type` filters (staging also has the
  // plural `states` / `types`). Query one state (× one type, when types are configured) at a
  // time so the same code works on both, then merge.
  const combos = queryPlan();

  const alerts = [];
  const seenIds = new Set();
  let truncated = false;
  for (const params of combos) {
    for (let page = 0, offset = 0; ; page++) {
      const res   = await atomGet('/alerts', { ...params, offset });
      const body  = res.data || {};
      const items = Array.isArray(body) ? body : (body.items || []);
      for (const a of items) {
        const id = a?.alert_id != null ? String(a.alert_id) : null;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        alerts.push(a);
      }
      if (Array.isArray(body) || !body.has_next || items.length === 0) break;
      if (page + 1 >= MAX_PAGES) {
        truncated = true;
        console.warn(`[atom] Stopped after ${MAX_PAGES} pages for state=${params.state}${params.type ? ` type=${params.type}` : ''}; raise ATOM_MAX_PAGES to fetch more`);
        break;
      }
      offset += items.length;
    }
  }

  alertCache.clear();
  const issues = [];
  for (const a of alerts) {
    const iss = normalizeAlert(a, feedLookup);
    if (!iss.id) continue;
    alertCache.set(iss.id, a);
    issues.push(iss);
  }
  return { issues, truncated };
}

/** The GET /alerts queries one sync makes: one per state × type (prod only has singular filters). */
function queryPlan(now = Date.now()) {
  const base = { limit: PAGE_SIZE, sort_by: 'issue_start_time', sort_order: 'desc' };
  if (PRODUCT) base['entity[product]'] = PRODUCT;
  if (LOOKBACK_HOURS > 0) base.issue_start_time = new Date(now - LOOKBACK_HOURS * 3600e3).toISOString();
  const plan = [];
  for (const state of ALERT_STATES) {
    for (const type of (ALERT_TYPES.length ? ALERT_TYPES : [null])) {
      plan.push(type ? { ...base, state, type } : { ...base, state });
    }
  }
  return plan;
}

/** Re-run normalisation for fetched issues once feed catalog info (timezone) is available. */
function applyFeedInfo(issues, feedLookup) {
  return issues.map(iss => {
    const raw = alertCache.get(iss.id);
    return raw ? normalizeAlert(raw, feedLookup) : iss;
  });
}

/** Backward-compatible: issues only. */
async function getIssues(opts) { return (await fetchAlerts(opts)).issues; }

/** Single alert by id (raw ATOM shape), or null if not found / not live. */
async function getAlert(alertId, { history = false } = {}) {
  if (!IS_LIVE) return null;
  try {
    const res = await atomGet(`/alerts/${encodeURIComponent(alertId)}`, history ? { history: true } : undefined);
    return res.data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Occurrences for an issue. In ATOM each alert is one occurrence (start time + duration). */
async function getIssueDetails(issue) {
  if (DEMO_MODE) return [];
  if (!client)   return mockOccs(typeof issue === 'object' ? issue : { id: issue }, ri(1, 6));

  const iss = typeof issue === 'object' ? issue : { id: issue };
  const alert = alertCache.get(iss.id) || await getAlert(iss.id);
  return alert ? [alertToOccurrence(iss, alert)] : [];
}

// ── Playlists ─────────────────────────────────────────────────────────────────

// Some ATOM roles (e.g. prod `operator`) get 403 on playlist endpoints. After a 403, stop calling
// them for a while instead of failing (slowly) on every feed/date in every sync.
const FORBIDDEN_BACKOFF_MS = 6 * 3600e3;
const forbiddenUntil = {}; // endpoint key → epoch ms
function isForbidden(key) { return (forbiddenUntil[key] || 0) > Date.now(); }
function markForbidden(key, err) {
  if (err.status !== 403) return false;
  if (!isForbidden(key)) console.warn(`[atom] ${key}: 403 Forbidden for this ATOM role — skipping it for 6h`);
  forbiddenUntil[key] = Date.now() + FORBIDDEN_BACKOFF_MS;
  return true;
}

/**
 * Published playlist version for a feed + date. ATOM exposes only the current published
 * playlist, so Sentinel builds the version timeline over successive syncs
 * (db.insertPlaylistVersionIfNew de-duplicates).
 */
async function getPlaylistTimeline(feed_code, playlist_date, region, automation_url) {
  if (DEMO_MODE) return [];
  if (!client)   return mockTimeline(feed_code, playlist_date, region);

  automation_url = automation_url || automationUrlByFeed.get(feed_code);
  if (!feed_code || !playlist_date || !automation_url || isForbidden('published_playlist')) return [];
  try {
    const res = await atomGet('/cache/published_playlist', { automation_url, feed_code, playlist_date });
    const pl  = res.data?.playlist;
    if (!pl || pl.id == null) return [];
    return [{
      feed_code, playlist_date,
      playlist_id:  String(pl.id),
      published_at: pl.published_at || pl.created_at || null,
      region:       region || null,
    }];
  } catch (err) {
    if (!markForbidden('published_playlist', err) && err.status !== 404) console.warn(`[atom] ${err.message}`);
    return [];
  }
}

/**
 * Full published playlist (common format) for a feed/date, normalised to
 * { meta, playlist_id, items: [{title, asset_id, type, sub_type, start_time, duration_ms, status}] }.
 * Returns null when no playlist is published. Demo/mock modes return a synthetic playlist.
 */
async function getPlaylist(automation_url, feed_code, playlist_date) {
  if (!IS_LIVE) return mockPlaylist(feed_code, playlist_date);
  if (!automation_url || !feed_code || !playlist_date) return null;
  if (isForbidden('feed_playlist')) {
    const e = new Error('Your ATOM role is not allowed to read playlists (403)'); e.status = 403; throw e;
  }
  try {
    const res = await atomGet(
      `/customers/${encodeURIComponent(automation_url)}/feeds/${encodeURIComponent(feed_code)}/playlist`,
      { playlist_date, format: 'common' });
    const body = res.data || {};
    const pl   = body.playlist || {};
    const items = (pl.items || []).map(it => ({
      title:       it.title ?? null,
      asset_id:    it.asset_id ?? null,
      type:        it.type ?? null,
      sub_type:    it.sub_type ?? null,
      start_time:  it.start_time ?? null,
      duration_ms: it.duration_ms ?? null,
      status:      it.status ?? null,
      status_details: it.status_details ?? null,
    }));
    return { meta: body.meta || {}, playlist_id: pl.id != null ? String(pl.id) : null, items };
  } catch (err) {
    if (err.status === 404) return null;
    if (markForbidden('feed_playlist', err)) { err.message = 'Your ATOM role is not allowed to read playlists (403)'; }
    throw err;
  }
}

// ── Customers / feed catalog ──────────────────────────────────────────────────

/** GET /customers/{automation_url}?detailed=true (raw), or null. */
async function getCustomer(automation_url) {
  if (!IS_LIVE || !automation_url) return null;
  try {
    const res = await atomGet(`/customers/${encodeURIComponent(automation_url)}`, { detailed: true });
    return res.data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ── Write-back (PATCH /alerts) ────────────────────────────────────────────────

/**
 * Send PATCH /alerts. Never throws: returns { ok, skipped?, error?, data? }.
 * Disabled unless ATOM_WRITEBACK=true against a real ATOM.
 */
async function patchAlerts(items) {
  if (!WRITEBACK_ENABLED) return { ok: true, skipped: true };
  for (const it of items) {
    if (it.action === 'resolve') return { ok: false, error: 'Sentinel never resolves ATOM alerts' };
    if ('labels' in it || 'custom_details' in it) return { ok: false, error: 'labels/custom_details must not be patched' };
  }
  try {
    const res = await atomRequest('patch', '/alerts', { data: items });
    return { ok: true, data: res.data };
  } catch (err) {
    console.warn(`[atom] ${err.message}`);
    return { ok: false, error: err.message };
  }
}

const snoozeAlert   = (alert_id, snooze_until) => patchAlerts([{ alert_id: String(alert_id), action: 'snooze', snooze_until }]);
const desnoozeAlert = (alert_id)               => patchAlerts([{ alert_id: String(alert_id), action: 'desnooze' }]);
const commentAlert  = (alert_id, comment)      => patchAlerts([{ alert_id: String(alert_id), comment: String(comment).slice(0, 512) }]);

// ── Normalisation ─────────────────────────────────────────────────────────────

// feed_code → automation_url, learnt from alerts (needed by the playlist endpoint).
const automationUrlByFeed = new Map();

function normalizeAlert(a, feedLookup) {
  const entity  = a.entity || {};
  const custom  = entity.custom || {};
  const details = a.custom_details || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (custom[k] != null && custom[k] !== '')   return custom[k];
      if (details[k] != null && details[k] !== '') return details[k];
    }
    return null;
  };

  const feed_code      = pick('feed_code', 'feedCode');
  const automation_url = pick('automation_url');
  if (feed_code && automation_url) automationUrlByFeed.set(feed_code, automation_url);

  const feed = (feedLookup && feed_code && safe(() => feedLookup(feed_code))) || null;
  const labels = a.labels || {};
  const issueStart = a.issue_start_time || a.created_at || null;
  const durationMs = Number.isFinite(Number(a.duration)) ? Number(a.duration) : null;
  const enumType   = AT.toEnumKey(a.type);

  return {
    id:                  a.alert_id != null ? String(a.alert_id) : null,
    feed_code,
    automation_url,
    region:              TZ.regionFromTimeZone(feed?.time_zone) || inferRegion(feed_code) || regionFromCloud(a.infra?.region),
    // entity.name is the feed's display name (e.g. "E Andes") on playlist/asset alerts, not a host
    host:                pick('headend_code') || '',
    headend_code:        pick('headend_code'),
    feed_name:           labels.feed_name || feed?.feed_name || entity.name || null,
    amg_id:              entity.amgID || null,
    source_url:          pick('playlist_url', 'asset_url', 'url'),
    account:             pick('account_domain') || entity.amgID || '',
    issue_type:          enumType || a.type || null,
    raw_type:            a.type || null,
    consolidated_status: a.state || 'active',
    severity:            a.severity || null,
    alert_name:          a.name || null,
    description:         a.description || null,
    product:             entity.product || null,
    entity_service:      entity.service || null,
    dedup_key:           a.dedup_key || null,
    correlation_id:      a.correlation_id || null,
    duration_ms:         durationMs,
    snoozed_until:       a.state === 'snoozed' ? (a.snoozed_until || null) : null,
    snoozed_by:          a.state === 'snoozed' ? (a.snoozed_by || null) : null,
    resolved_at:         a.state === 'resolved' ? (a.resolved_at || null) : null,
    resolved_by:         a.state === 'resolved' ? (a.resolved_by || null) : null,
    atom_updated_at:     a.updated_at || a.timestamp || null,
    labels:              isEmpty(a.labels) ? null : JSON.stringify(a.labels),
    custom_details:      isEmpty(a.custom_details) ? null : JSON.stringify(a.custom_details),
    playlist_id:         String(pick('playlist_id', 'playlistId') ?? ''),
    playlist_date:       pick('playlist_date', 'playlistDate')
                           || (issueStart ? TZ.broadcastDate(issueStart, feed?.time_zone, feed?.broadcast_start_time) : ''),
    playlist_start_time: pick('playlist_start_time', 'broadcast_start_time'),
    earliest_scheduled:  issueStart,
    asset_id:            pick('asset_id', 'assetId'),
    penalty:             true, // every new alert starts in Sentinel's "penalty" triage state
  };
}

function alertToOccurrence(iss, a) {
  const n = normalizeAlert(a);
  const ms = Number(a.duration);
  return {
    atom_issue_id:      iss.id,
    feed_code:          iss.feed_code || n.feed_code,
    region:             iss.region || n.region,
    playlist_id:        iss.playlist_id ?? n.playlist_id,
    playout_start_time: a.issue_start_time || a.created_at,
    duration:           Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 1000)}s` : 'ongoing',
    asset_id:           n.asset_id,
    playlist_date:      iss.playlist_date || n.playlist_date,
    issue_type:         iss.issue_type || n.issue_type,
    raw_payload:        JSON.stringify(a),
  };
}

function inferRegion(fc) {
  if (!fc) return null;
  const f = String(fc).toUpperCase();
  if (['AMG','STAR','NHK','SONY','BALP','OCA'].some(p => f.startsWith(p))) return 'APAC';
  if (['ESPN','FOX','NBC','CBS','FAIL'].some(p => f.startsWith(p)))         return 'US';
  if (['BRD','SKY','RTL','FRANCE','WSSPY','INSIGHT'].some(p => f.startsWith(p))) return 'EMEA';
  return null;
}

/** Fallback: map a cloud region (infra.region, e.g. us-west-2 / ap-south-1) to a Sentinel region. */
function regionFromCloud(r) {
  if (!r) return null;
  const s = String(r).toLowerCase();
  if (/^(us|ca|sa|northamerica|southamerica)[-_]/.test(s)) return 'US';
  if (/^(eu|me|af|europe)[-_]/.test(s))                    return 'EMEA';
  if (/^(ap|asia|australia)[-_]/.test(s))                  return 'APAC';
  return null;
}

// ── Random mock data (dev fallback when neither DEMO nor real API) ────────────

const REGIONS = ['APAC','US','EMEA'];
const REGION_FEEDS = {
  APAC: ['AMG01579C1','AMG02341B2','STAR_SPORTS_HD'],
  US:   ['ESPN4K001','FOX_NEWS_HD','NBC_EAST'],
  EMEA: ['BRD00123X4','NATGEO_UHD','SKY_UK_HD'],
};
const HOSTS      = ['encoder-01.prod','encoder-02.prod','encoder-03.prod'];
const ACCOUNTS   = ['account_alpha','account_beta'];
const SEVERITIES = ['minor','major','major','critical','blocker'];
const OTHER_TYPES = ['tarang_media_seq_stall_alert','ingest_audio_channel_misconfiguration_alert','medialive_degraded_status_alert'];

function rand(a)  { return a[Math.floor(Math.random()*a.length)]; }
function ri(a,b)  { return Math.floor(Math.random()*(b-a+1))+a; }

function mockIssues(n=28) {
  const now=new Date(), issues=[];
  for (let i=1;i<=n;i++) {
    const region=rand(REGIONS), feed_code=rand(REGION_FEEDS[region]);
    const offset=Math.random()<0.6?ri(0,5):ri(-10,-1);
    const start=new Date(now); start.setDate(start.getDate()+offset); start.setHours(ri(6,22),ri(0,59),0,0);
    const type = Math.random() < 0.8 ? rand(AT.ALERT_KEYS) : rand(OTHER_TYPES);
    issues.push({
      id:`ATOM-ISSUE-${String(i).padStart(5,'0')}`, feed_code, region,
      host:rand(HOSTS), account:rand(ACCOUNTS), issue_type:type, raw_type:type,
      consolidated_status:rand(['active','active','snoozed']),
      severity:rand(SEVERITIES), alert_name:AT.label(type), description:`Mock ${AT.label(type)} on ${feed_code}`,
      playlist_id:String(200000+ri(1000,99999)),
      playlist_date:start.toISOString().split('T')[0],
      playlist_start_time:start.toISOString(),
      earliest_scheduled:start.toISOString(),
      duration_ms: ri(0, 3) ? ri(10, 600) * 1000 : -1,
      asset_id:Math.random()>0.45?`ASSET-${ri(10000,99999)}`:null,
      penalty:Math.random()>0.3,
    });
  }
  return issues;
}

function mockOccs(issue, n) {
  return Array.from({length:n}, () => {
    const t=new Date(issue.playlist_start_time||new Date()); t.setMinutes(t.getMinutes()+ri(5,200));
    return {
      atom_issue_id:issue.id, feed_code:issue.feed_code, region:issue.region,
      playout_start_time:t.toISOString(), duration:`${ri(1,600)}s`,
      asset_id:issue.asset_id||(Math.random()>0.5?`ASSET-${ri(10000,99999)}`:null),
      playlist_id:issue.playlist_id, playlist_date:issue.playlist_date,
      issue_type:issue.issue_type, raw_payload:JSON.stringify({mock:true}),
    };
  });
}

function mockTimeline(feed_code, playlist_date, region) {
  const base=230000+Math.floor(Math.random()*9999), n=ri(1,3);
  const date=new Date(playlist_date+'T06:00:00Z');
  return Array.from({length:n},(_,i)=>{
    const p=new Date(date); p.setHours(6+i*ri(2,4),ri(0,59),ri(0,59));
    return {feed_code,playlist_date,playlist_id:String(base+i*ri(20,80)),published_at:p.toISOString(),region};
  });
}

/** Deterministic synthetic playlist: 30-minute items across the day (demo/mock only). */
function mockPlaylist(feed_code, playlist_date) {
  if (!feed_code || !playlist_date) return null;
  const day = Date.parse(`${playlist_date}T00:00:00Z`);
  if (!Number.isFinite(day)) return null;
  let seed = [...`${feed_code}${playlist_date}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const shows = ['Morning Brief','Live Desk','Feature Hour','Classic Cinema','Sports Tonight','World Report','Kids Block','Late Show'];
  const items = [];
  for (let t = 0; t < 48; t++) {
    const isAd = t % 3 === 2;
    items.push({
      title:       isAd ? 'Commercial Break' : shows[Math.floor(next() * shows.length)],
      asset_id:    `ASSET-${10000 + Math.floor(next() * 89999)}`,
      type:        isAd ? 'ad' : 'program',
      sub_type:    null,
      start_time:  new Date(day + t * 30 * 60000).toISOString(),
      duration_ms: 30 * 60000,
      status:      next() < 0.08 ? 'missing' : 'ready',
      status_details: null,
    });
  }
  return { meta: { feed_code, playlist_date, format: 'common', mock: true }, playlist_id: null, items };
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function csv(s)            { return String(s).split(',').map(x => x.trim()).filter(Boolean); }
function clamp(n, lo, hi)  { return Math.min(hi, Math.max(lo, n)); }
function isEmpty(o)        { return !o || (typeof o === 'object' && Object.keys(o).length === 0); }
function safe(fn)          { try { return fn(); } catch { return null; } }

module.exports = {
  fetchAlerts, applyFeedInfo, getIssues, getAlert, getIssueDetails,
  getPlaylistTimeline, getPlaylist, getCustomer,
  patchAlerts, snoozeAlert, desnoozeAlert, commentAlert,
  isLive: () => IS_LIVE,
  authInfo,
  queryPlan,
  DEFAULT_ALERT_TYPES,
  isWritebackEnabled: () => WRITEBACK_ENABLED,
  // exported for tests
  _internal: { normalizeAlert, alertToOccurrence, regionFromCloud, authMode },
};

// Load backend/.env before any module reads process.env (atomApi, freshdeskApi, auth read it at load).
// Variables already set in the environment (Docker, CI, shell) win. Skipped under tests.
(function loadDotEnv() {
  if (process.env.NODE_ENV === 'test') return;
  const file = require('path').join(__dirname, '.env');
  let text;
  try { text = require('fs').readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    process.env[m[1]] = v;
  }
})();

const express      = require('express');
const session      = require('express-session');
const cors         = require('cors');
const path         = require('path');
const db           = require('./db');
const AT           = require('./alertTypes');
const { passport, requireAuthApi, IS_CONFIGURED } = require('./auth');
const { startSyncScheduler, getSyncStatus, triggerSync } = require('./sync');
const atomApi      = require('./atomApi');
const TZ           = require('./atomTime');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Session store (SQLite-backed so sessions survive restarts) ────────────────
let sessionStore;
try {
  const SQLiteStore = require('connect-sqlite3')(session);
  sessionStore = new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname) });
} catch {
  console.warn('[server] connect-sqlite3 not available — using in-memory session store');
}

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

// ── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'atom-dashboard-dev-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  store:             sessionStore,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
    sameSite: 'lax',
  },
}));

// ── Passport ──────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

const pf = q => ({
  region: q.region||'', feed_code: q.feed_code||'',
  issue_type: q.issue_type||'', playlist_id: q.playlist_id||'',
  playlist_date: q.playlist_date||'', acknowledged: q.acknowledged,
  has_ticket: q.has_ticket, penalty: q.penalty,
  state: q.state||'',
  date_from: q.date_from||'', date_to: q.date_to||'',
  severity: q.severity||'', atom_state: q.atom_state||'', toc_only: q.toc_only||'',
  sort: q.sort||'',
});

const currentUser = req => req.user?.email || (IS_CONFIGURED ? 'unknown' : 'dev@amagi.com');

// ── Auth Routes ──────────────────────────────────────────────────────────────

// Initiate OIDC login
app.get('/auth/login', passport.authenticate('openidconnect'));

// OIDC callback
app.get('/auth/callback',
  passport.authenticate('openidconnect', { failureRedirect: '/auth/error' }),
  (req, res) => {
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    // Redirect to frontend (React app handles routing)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}${returnTo}`);
  }
);

// Logout
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect(process.env.FRONTEND_URL || '/');
    });
  });
});

// Auth error page
app.get('/auth/error', (req, res) => {
  res.status(403).json({
    error:   'Access denied',
    message: `Login failed. Only ${process.env.ALLOWED_EMAIL_DOMAIN || '@amagi.com'} accounts are allowed.`,
  });
});

// Current user info (public — used by frontend to check auth state)
app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated() || !IS_CONFIGURED) {
    const user = req.user || { email: 'dev@amagi.com', name: 'Dev User', _bypass: true };
    res.json({
      authenticated: true,
      email:       user.email,
      name:        user.name,
      given_name:  user.given_name,
      bypass:      !!user._bypass,
      auth_configured: IS_CONFIGURED,
    });
  } else {
    res.json({ authenticated: false, auth_configured: IS_CONFIGURED });
  }
});

// ── Protect all /api/* routes ─────────────────────────────────────────────────
app.use('/api', requireAuthApi);

// ── Meta ──────────────────────────────────────────────────────────────────────
app.get('/api/demo-status', (_, res) => {
  res.json({
    demo_mode:   process.env.DEMO_MODE === 'true',
    freshdesk_mock: !process.env.FRESHDESK_DOMAIN,
    atom_live:      atomApi.isLive(),
    atom_writeback: atomApi.isWritebackEnabled(),
  });
});

app.get('/api/health',      (_, res) => res.json({ status:'ok', ts: new Date().toISOString() }));
app.get('/api/regions',     (_, res) => res.json(db.getDistinctRegions()));
app.get('/api/issue-types', (_, res) => {
  // Returns fixed enum keys — never dynamic DB values
  res.json(AT.ALERT_KEYS);
});

// Non-TOC ATOM alert types currently in the DB ({key, label, count})
app.get('/api/issue-types/other', (_, res) => {
  try { res.json(db.getOtherIssueTypes()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// Full alert type definitions (key + label + subject) for frontend
app.get('/api/alert-types', (_, res) => {
  res.json(AT.ALERT_KEYS.map(key => ({
    key,
    label:   AT.label(key),
    subject: AT.subjectFriendly(key),
  })));
});
app.get('/api/stats', (req, res) => {
  try { res.json({ ...db.getStats(req.query.region||null), sync: getSyncStatus() }); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ── Upcoming dashboard ────────────────────────────────────────────────────────
app.get('/api/issues/upcoming', (req, res) => {
  try { res.json(db.getUpcomingIssues(pf(req.query))); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ── General issues ────────────────────────────────────────────────────────────
app.get('/api/issues', (req, res) => {
  try { res.json(db.getIssues(pf(req.query))); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ── Issue detail by composite key ─────────────────────────────────────────────
app.get('/api/issues/:atomIssueId/playlist/:playlistId', (req, res) => {
  try {
    const r = db.getIssueByCompositeKey(req.params.atomIssueId, req.params.playlistId);
    if (!r) return res.status(404).json({error:'Not found'});
    res.json(r);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// PATCH /api/issues/:atomIssueId/playlist/:playlistId/state
// Explicit state transitions: penalty | ack | ticketed
// Body: { state, snooze_until? }  — with ATOM write-back on, ack + snooze_until snoozes the ATOM
// alert; moving back to penalty de-snoozes it. The local change always applies; an ATOM failure
// is returned as `atom: {ok:false,error}` and stored in atom_writeback_error.
const MAX_SNOOZE_MS = 7 * 24 * 3600 * 1000;

app.patch('/api/issues/:atomIssueId/playlist/:playlistId/state', async (req, res) => {
  try {
    const { state, snooze_until } = req.body;
    const VALID = ['penalty','ack','ticketed'];
    if (!VALID.includes(state)) {
      return res.status(400).json({ error: `Invalid state. Must be one of: ${VALID.join(', ')}` });
    }
    if (snooze_until !== undefined && snooze_until !== null) {
      const ms = Date.parse(snooze_until);
      if (state !== 'ack') return res.status(400).json({ error: 'snooze_until is only valid with state "ack"' });
      if (!Number.isFinite(ms) || ms <= Date.now() || ms - Date.now() > MAX_SNOOZE_MS) {
        return res.status(400).json({ error: 'snooze_until must be a future ISO time within 7 days' });
      }
    }
    const result = db.getIssueByCompositeKey(req.params.atomIssueId, req.params.playlistId);
    if (!result) return res.status(404).json({ error: 'Issue not found' });
    const issue = result.issue;

    // Guard: ticketed state is locked — only set automatically via ticket creation
    if (issue.state === 'ticketed' && state !== 'ticketed') {
      return res.status(409).json({ error: 'State cannot be changed once ticketed' });
    }

    const ackVal = state === 'ack' ? 1 : (state === 'penalty' ? 0 : issue.acknowledged);
    db.updateIssue(issue.id, { state, acknowledged: ackVal });

    // ATOM write-back
    let atom = { ok: true, skipped: true };
    if (state === 'ack' && snooze_until) {
      const until = new Date(snooze_until).toISOString();
      atom = await atomApi.snoozeAlert(issue.atom_issue_id, until);
      if (atom.ok && !atom.skipped) {
        db.updateAtomLifecycle(issue.atom_issue_id, {
          consolidated_status: 'snoozed', snoozed_until: until, snoozed_by: currentUser(req),
        });
      }
    } else if (state === 'penalty' && issue.consolidated_status === 'snoozed') {
      atom = await atomApi.desnoozeAlert(issue.atom_issue_id);
      if (atom.ok && !atom.skipped) {
        db.updateAtomLifecycle(issue.atom_issue_id, { consolidated_status: 'active' });
      }
    }
    if (!atom.skipped) db.updateIssue(issue.id, { atom_writeback_error: atom.ok ? null : atom.error });

    res.json({ ...db.getIssueByCompositeKey(req.params.atomIssueId, req.params.playlistId), atom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Snooze choices for the Ack picker: 1h, 4h, end of the feed's broadcast day
app.get('/api/issues/:atomIssueId/playlist/:playlistId/snooze-options', (req, res) => {
  try {
    const result = db.getIssueByCompositeKey(req.params.atomIssueId, req.params.playlistId);
    if (!result) return res.status(404).json({ error: 'Issue not found' });
    const feed = db.getAtomFeed(result.issue.feed_code);
    const now  = Date.now();
    const eod  = TZ.endOfBroadcastDay(new Date(now).toISOString(), feed?.time_zone, feed?.broadcast_start_time);
    const opts = [
      { key: '1h',  label: '1 hour',  until: new Date(now + 3600e3).toISOString() },
      { key: '4h',  label: '4 hours', until: new Date(now + 4 * 3600e3).toISOString() },
    ];
    if (Date.parse(eod) > now + 60e3) {
      opts.push({ key: 'eod', label: 'End of broadcast day', until: eod,
        detail: feed?.time_zone ? TZ.formatLocal(eod, feed.time_zone) : `${eod.slice(0, 16).replace('T', ' ')} UTC` });
    }
    res.json({ writeback: atomApi.isWritebackEnabled(), options: opts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Playlist context: the playlist items around the alert time (title, asset, start, duration, status)
const playlistCache = new Map(); // key → { at, data }
const PLAYLIST_TTL_MS = 5 * 60 * 1000;

async function cachedPlaylist(automation_url, feed_code, playlist_date) {
  const key = `${automation_url}|${feed_code}|${playlist_date}`;
  const hit = playlistCache.get(key);
  if (hit && Date.now() - hit.at < PLAYLIST_TTL_MS) return hit.data;
  const data = await atomApi.getPlaylist(automation_url, feed_code, playlist_date);
  playlistCache.set(key, { at: Date.now(), data });
  if (playlistCache.size > 200) playlistCache.delete(playlistCache.keys().next().value);
  return data;
}

app.get('/api/issues/:atomIssueId/playlist/:playlistId/context', async (req, res) => {
  try {
    const result = db.getIssueByCompositeKey(req.params.atomIssueId, req.params.playlistId);
    if (!result) return res.status(404).json({ error: 'Issue not found' });
    const { issue, occurrences } = result;
    const feed = db.getAtomFeed(issue.feed_code);
    const automation_url = issue.automation_url || feed?.automation_url || null;
    const alertTime = issue.earliest_scheduled || occurrences[0]?.playout_start_time || issue.playlist_start_time;

    const pl = await cachedPlaylist(automation_url, issue.feed_code, issue.playlist_date);
    if (!pl || !pl.items?.length) return res.json({ available: false, alert_time: alertTime });

    const t = Date.parse(alertTime);
    const items = pl.items.map((it, index) => ({ ...it, index }));
    let cur = -1;
    if (Number.isFinite(t)) {
      for (const it of items) {
        const st = Date.parse(it.start_time);
        if (!Number.isFinite(st)) continue;
        if (st <= t) cur = it.index;                       // last item started before the alert
        if (st <= t && t < st + (Number(it.duration_ms) || 0)) { cur = it.index; break; }
      }
    }
    const wanted = new Set();
    if (cur >= 0) for (let i = Math.max(0, cur - 2); i <= Math.min(items.length - 1, cur + 2); i++) wanted.add(i);
    if (issue.asset_id) items.filter(it => it.asset_id === issue.asset_id).forEach(it => wanted.add(it.index));
    if (!wanted.size) items.slice(0, 5).forEach(it => wanted.add(it.index));

    res.json({
      available: true,
      alert_time: alertTime,
      playlist_id: pl.playlist_id,
      meta: pl.meta,
      total_items: items.length,
      current_index: cur,
      items: [...wanted].sort((a, b) => a - b).map(i => ({
        ...items[i], is_current: i === cur, is_asset_match: !!issue.asset_id && items[i].asset_id === issue.asset_id,
      })),
    });
  } catch (e) { res.status(e.status === 403 ? 403 : 502).json({ error: e.message }); }
});

// ── ATOM passthrough reads ────────────────────────────────────────────────────
app.get('/api/atom/feeds/:feed_code', (req, res) => {
  try {
    const f = db.getAtomFeed(req.params.feed_code);
    if (!f) return res.status(404).json({ error: 'Feed not in ATOM catalog yet' });
    delete f.headends_json;
    res.json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live alert from ATOM (with transition history) — falls back to the stored raw payload
app.get('/api/atom/alerts/:alertId', async (req, res) => {
  try {
    let alert = null, source = 'atom';
    try { alert = await atomApi.getAlert(req.params.alertId, { history: true }); } catch (e) { source = `stored (${e.message})`; }
    if (!alert) {
      const row = db.getDb().prepare(`SELECT raw_payload FROM occurrences WHERE atom_issue_id=? AND raw_payload IS NOT NULL ORDER BY id DESC LIMIT 1`).get(req.params.alertId);
      try { alert = row ? JSON.parse(row.raw_payload) : null; } catch {}
      if (source === 'atom') source = 'stored';
    }
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ source, alert });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy by numeric id
app.get('/api/issues/:id', (req, res) => {
  try {
    const r = db.getIssueById(req.params.id);
    if (!r) return res.status(404).json({error:'Not found'});
    res.json(r);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/issues/:id', (req, res) => {
  try {
    const { ticket_link, ticket_id, acknowledged, status } = req.body;
    const ok = db.updateIssue(req.params.id, {
      ticket_link, ticket_id,
      acknowledged: acknowledged !== undefined ? (acknowledged?1:0) : undefined,
      status,
    });
    if (!ok) return res.status(400).json({error:'No valid fields'});
    res.json(db.getIssueById(req.params.id));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Tickets ───────────────────────────────────────────────────────────────────
// Check for same-day previous ticket (non-destructive, used before create)
app.get('/api/tickets/check', (req, res) => {
  try {
    const { feed_code, issue_type, asset_id, playlist_id, playlist_date } = req.query;
    const prev = db.findSameDayPreviousTicket({ feed_code, issue_type, asset_id, playlist_id, playlist_date });
    res.json({ has_previous: !!prev, previous_ticket: prev || null });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Create ticket (always allowed — warning already shown in UI)
app.post('/api/tickets', (req, res) => {
  try {
    const { atom_issue_id, playlist_id, feed_code, issue_type, asset_id, ticket_number, ticket_link } = req.body;
    if (!atom_issue_id || !playlist_id) return res.status(400).json({error:'atom_issue_id and playlist_id required'});
    const ticket = db.createTicket({ atom_issue_id, playlist_id, feed_code, issue_type, asset_id, ticket_number, ticket_link });
    res.json({ ticket });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history/feeds',     (req, res) => { try { res.json(db.getHistoryFeeds(req.query.region)); } catch(e) { res.status(500).json({error:e.message}); } });
app.get('/api/history/playlists', (req, res) => {
  try {
    const { feed_code, region } = req.query;
    if (!feed_code) return res.status(400).json({error:'feed_code required'});
    res.json(db.getHistoryPlaylists(feed_code, region));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/history/issues', (req, res) => {
  try {
    const { feed_code, playlist_id } = req.query;
    if (!feed_code||!playlist_id) return res.status(400).json({error:'feed_code and playlist_id required'});
    res.json(db.getHistoryIssues(feed_code, playlist_id));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Playlist timeline ─────────────────────────────────────────────────────────
app.get('/api/playlist-timeline', (req, res) => {
  try {
    const { feed_code, playlist_date } = req.query;
    if (!feed_code||!playlist_date) return res.status(400).json({error:'feed_code and playlist_date required'});
    res.json(db.getPlaylistTimeline(feed_code, playlist_date));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  const s = getSyncStatus();
  if (s.isSyncing) return res.json({message:'Already syncing', status:s});
  triggerSync();
  res.json({message:'Sync triggered', status: getSyncStatus()});
});
app.get('/api/sync/status', (_, res) => res.json(getSyncStatus()));

// ══════════════════════════════════════════════════════════════════════════════
// FRESHDESK / CONTACT CONFIGURATION ROUTES
// ══════════════════════════════════════════════════════════════════════════════

const freshdesk = require('./freshdeskApi');

// ── Settings: feed ticket config ──────────────────────────────────────────────

// GET all configs
app.get('/api/settings/contacts', (req, res) => {
  try {
    res.json(db.getAllFeedTicketConfigs());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET config for one feed
app.get('/api/settings/contacts/:feed_code', (req, res) => {
  try {
    const cfg = db.getFeedTicketConfig(req.params.feed_code);
    const overrides = db.getIssueOverridesForFeed(req.params.feed_code);
    res.json({ config: cfg, overrides });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT (upsert) config for one feed
app.put('/api/settings/contacts/:feed_code', (req, res) => {
  try {
    const { customer_name, product_version, contact_email, cc_emails, use_general_for_all, overrides } = req.body;
    const saved = db.upsertFeedTicketConfig({
      feed_code: req.params.feed_code,
      customer_name:       customer_name       || null,
      product_version:     product_version     || null,
      contact_email:       contact_email       || null,
      cc_emails:           cc_emails           || null,
      use_general_for_all: use_general_for_all ? 1 : 0,
    });
    if (Array.isArray(overrides)) {
      db.upsertManyIssueOverrides(req.params.feed_code, overrides);
    }
    const updatedOverrides = db.getIssueOverridesForFeed(req.params.feed_code);
    res.json({ config: saved, overrides: updatedOverrides });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET distinct feed codes (for settings page dropdown)
app.get('/api/settings/feeds', (req, res) => {
  try { res.json(db.getDistinctFeedCodes()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET available issue types (for override rows)
app.get('/api/settings/issue-types', (req, res) => {
  // Returns structured list of {key, label} for the 4 fixed alert types
  res.json(AT.ALERT_KEYS.map(key => ({ key, label: AT.label(key) })));
});

// ── Ticket preview (build payload without creating) ───────────────────────────
app.post('/api/freshdesk/preview', (req, res) => {
  try {
    const { atom_issue_id, playlist_id, ticket_type } = req.body;
    if (!atom_issue_id || !playlist_id) return res.status(400).json({ error: 'atom_issue_id and playlist_id required' });
    const result = db.getIssueByCompositeKey(atom_issue_id, playlist_id);
    if (!result) return res.status(404).json({ error: 'Issue not found' });
    const payload = db.buildFreshdeskPayload(result.issue, ticket_type || 'customer');
    res.json({
      subject:         payload.subject,
      description:     payload.description,
      email:           payload.email,
      cc_emails:       payload.cc_emails,
      customer_name:   payload._meta.contacts.customer_name,
      product_version: payload._meta.contacts.product_version,
      priority:        payload.priority,
      ticket_type,
      is_mock:         freshdesk.isMock(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create Freshdesk ticket ───────────────────────────────────────────────────
app.post('/api/freshdesk/create', async (req, res) => {
  try {
    const { atom_issue_id, playlist_id, ticket_type } = req.body;
    if (!atom_issue_id || !playlist_id) return res.status(400).json({ error: 'atom_issue_id and playlist_id required' });
    if (!ticket_type || !['customer','internal'].includes(ticket_type)) {
      return res.status(400).json({ error: 'ticket_type must be "customer" or "internal"' });
    }

    const result = db.getIssueByCompositeKey(atom_issue_id, playlist_id);
    if (!result) return res.status(404).json({ error: 'Issue not found' });

    const payload = db.buildFreshdeskPayload(result.issue, ticket_type);

    // Call Freshdesk (or mock)
    const fd = await freshdesk.createTicket(payload);

    // Store in DB
    const stored = db.storeFreshdeskTicket({
      atom_issue_id,
      playlist_id,
      feed_code:       result.issue.feed_code,
      issue_type:      result.issue.issue_type,
      asset_id:        result.issue.asset_id,
      freshdesk_id:    fd.freshdesk_id,
      ticket_number:   fd.ticket_number,
      ticket_url:      fd.ticket_url,
      ticket_type,
      subject:         fd.subject,
      requester_email: fd.requester_email,
    });

    // Re-run same-day persistence check now that ticket exists
    db.checkAndMarkPersistence(
      atom_issue_id, playlist_id,
      result.issue.feed_code, result.issue.issue_type,
      result.issue.asset_id, result.issue.playlist_date,
      result.issue.playlist_start_time
    );

    // ATOM write-back: leave a comment with the ticket on the alert (never resolves)
    const ref  = fd.ticket_number || fd.freshdesk_id;
    const atom = await atomApi.commentAlert(atom_issue_id,
      `Sentinel: Freshdesk #${ref} (${ticket_type}) created by ${currentUser(req)}${fd.ticket_url ? ` — ${fd.ticket_url}` : ''}`);
    if (!atom.skipped) {
      db.getDb().prepare(`UPDATE issues SET atom_writeback_error=? WHERE atom_issue_id=? AND playlist_id=?`)
        .run(atom.ok ? null : atom.error, atom_issue_id, playlist_id);
    }

    res.json({
      ticket: stored,
      atom,
      freshdesk_id:  fd.freshdesk_id,
      ticket_number: fd.ticket_number,
      ticket_url:    fd.ticket_url,
      subject:       fd.subject,
      mock:          fd.mock || false,
    });
  } catch (e) {
    console.error('[/api/freshdesk/create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET tickets created for an issue
app.get('/api/freshdesk/tickets/:atomIssueId/:playlistId', (req, res) => {
  try {
    const tickets = db.getFreshdeskTicketsForIssue(req.params.atomIssueId, req.params.playlistId);
    res.json(tickets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH PROBES & OBSERVABILITY METRICS
// ══════════════════════════════════════════════════════════════════════════════

// Liveness probe
app.get('/healthz/live', (_, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Readiness probe (verifies database availability)
app.get('/healthz/ready', (_, res) => {
  try {
    db.getDb().prepare('SELECT 1').get();
    res.status(200).json({ status: 'ok', db: 'connected', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Prometheus metrics endpoint
app.get('/metrics', (_, res) => {
  try {
    const stats = db.getStats();
    const syncStatus = getSyncStatus();
    const uptime = process.uptime();

    const output = [
      '# HELP sentinel_uptime_seconds Application uptime in seconds',
      '# TYPE sentinel_uptime_seconds gauge',
      `sentinel_uptime_seconds ${uptime.toFixed(2)}`,
      '',
      '# HELP sentinel_alerts_total Total count of alerts tracked by Sentinel',
      '# TYPE sentinel_alerts_total gauge',
      `sentinel_alerts_total ${stats.total || 0}`,
      `sentinel_alerts_upcoming ${stats.upcoming || 0}`,
      `sentinel_alerts_penalty ${stats.penalty || 0}`,
      '',
      '# HELP sentinel_alerts_by_state Count of active upcoming alerts by state',
      '# TYPE sentinel_alerts_by_state gauge',
      `sentinel_alerts_by_state{state="penalty"} ${stats.state_penalty || 0}`,
      `sentinel_alerts_by_state{state="ack"} ${stats.state_ack || 0}`,
      `sentinel_alerts_by_state{state="ticketed"} ${stats.state_ticketed || 0}`,
      '',
      '# HELP sentinel_sync_is_syncing Status of the ATOM telemetry sync background task',
      '# TYPE sentinel_sync_is_syncing gauge',
      `sentinel_sync_is_syncing ${syncStatus.isSyncing ? 1 : 0}`,
      '',
      '# HELP sentinel_atom_alerts_by_state Alerts by ATOM lifecycle state',
      '# TYPE sentinel_atom_alerts_by_state gauge',
      `sentinel_atom_alerts_by_state{state="active"} ${stats.atom_active || 0}`,
      `sentinel_atom_alerts_by_state{state="snoozed"} ${stats.atom_snoozed || 0}`,
      `sentinel_atom_alerts_by_state{state="resolved"} ${stats.atom_resolved || 0}`,
      '',
      '# HELP sentinel_atom_writeback_errors Issues whose last ATOM write-back failed',
      '# TYPE sentinel_atom_writeback_errors gauge',
      `sentinel_atom_writeback_errors ${stats.writeback_errors || 0}`,
    ].join('\n') + '\n';

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(output);
  } catch (err) {
    res.status(500).send(`# ERROR: ${err.message}\n`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SERVER BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);

    // Seed deterministic demo data when DEMO_MODE=true
    if (process.env.DEMO_MODE === 'true') {
      try {
        const { seedDemoData } = require('./demoData');
        seedDemoData(db.getDb());
        console.log('[server] Demo data seeded (DEMO_MODE=true)');
      } catch (e) {
        console.error('[server] Demo seed failed:', e.message);
      }
    }

    startSyncScheduler();
  });
}

module.exports = app;

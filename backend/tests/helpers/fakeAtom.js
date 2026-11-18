'use strict';

// Minimal fake ATOM v1 API, shaped like the OpenAPI spec at /v1/api/docs.yaml.
// State lives on the returned object so tests can change alerts between syncs.

const http = require('node:http');

function makeAlert(i, overrides = {}) {
  const { custom, ...rest } = overrides;
  return {
    alert_id: String(1000 + i),
    dedup_key: `b2c3d4e5f67890${String(i).padStart(2, '0')}`,
    correlation_id: `corr-${i}`,
    type: i % 2 ? 'hole_in_playlist' : 'asset_missing_in_cloud',
    name: i % 2 ? 'Hole in playlist' : 'Asset missing in cloud',
    description: `Alert ${i} description`,
    state: 'active',
    severity: 'major',
    issue_start_time: '2026-11-18T10:55:00.000Z',
    created_at: '2026-11-18T11:00:00.000Z',
    updated_at: '2026-11-18T11:00:00.000Z',
    duration: 300000,
    labels: { team: 'toc' },
    custom_details: {},
    entity: {
      amgID: 'amg-789', name: 'server-02', product: 'CP', service: 'asset',
      custom: {
        account_domain: 'acct-001', automation_url: 'customer-abc.amagi.tv',
        feed_code: 'AMG01579C1', headend_code: 'fa_001',
        playlist_id: '230001', playlist_date: '2026-11-18', asset_id: `ASSET-${i}`,
        ...(custom || {}),
      },
    },
    infra: { cloud: 'aws', region: 'ap-south-1' },
    ...rest,
  };
}

function startFakeAtom() {
  const state = {
    alerts: [makeAlert(1), makeAlert(2), makeAlert(3)],
    byId: {},          // extra alerts only reachable via GET /alerts/{id} (e.g. resolved)
    requests: [],
    patches: [],
    loginCount: 0,
    // SSO refresh-token rotation: only `validRefresh` is accepted; each refresh issues a new one
    validRefresh: 'rt-0',
    refreshCount: 0,
    tokenTtlMs: 3600e3,
    revoked: new Set(),     // access tokens that now get 401
    customers: {
      'customer-abc.amagi.tv': {
        name: 'ABC Media', url: 'customer-abc.amagi.tv', days_to_monitor: 3,
        accounts: [{
          amg_id: 'amg-789', domain: 'acct-001', automation_url: 'customer-abc.amagi.tv',
          feeds: [{
            code: 'AMG01579C1', name: 'ABC Movies HD', time_zone: 'Asia/Kolkata',
            broadcast_start_time: '06:00:00', days_to_monitor: 3,
            headends: [{ code: 'fa_001', name: 'Primary', active: true, health: { playback: 'ok', monitoring: 'ok' } }],
          }],
        }],
      },
    },
    playlist: {
      meta: { feed_code: 'AMG01579C1', playlist_date: '2026-11-18', format: 'common' },
      playlist: {
        id: 230001,
        items: [
          { title: 'Show A', asset_id: 'ASSET-0', type: 'program', start_time: '2026-11-18T10:00:00Z', duration_ms: 1800000, status: 'ready' },
          { title: 'Show B', asset_id: 'ASSET-1', type: 'program', start_time: '2026-11-18T10:30:00Z', duration_ms: 1800000, status: 'missing' },
          { title: 'Break',  asset_id: 'ASSET-9', type: 'ad',      start_time: '2026-11-18T11:00:00Z', duration_ms: 300000,  status: 'ready' },
        ],
      },
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
      state.requests.push(entry);
      const send = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const p = url.pathname.replace(/^\/v1\/api/, '');

      if (req.method === 'POST' && p === '/auth/user/login') {
        state.loginCount++;
        return send(200, { token: `jwt-${state.loginCount}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (req.method === 'POST' && p === '/auth/sso/refresh') {
        const { refresh_token } = JSON.parse(body || '{}');
        if (refresh_token !== state.validRefresh) return send(401, { error: 'invalid refresh token' });
        state.refreshCount++;
        state.validRefresh = `rt-${state.refreshCount}`;
        return send(200, { token: `sso-${state.refreshCount}`, refresh_token: state.validRefresh,
          expires_at: new Date(Date.now() + state.tokenTtlMs).toISOString(), auth_type: 'sso' });
      }
      if (!req.headers['x-api-key'] && !req.headers.authorization) return send(401, { error: 'Authorization header is required' });
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (bearer && state.revoked.has(bearer)) return send(401, { error: 'token expired' });

      if (req.method === 'PATCH' && p === '/alerts') {
        const items = JSON.parse(body || '[]');
        state.patches.push(items);
        return send(200, { items: [], has_next: false });
      }
      if (req.method === 'GET' && p === '/alerts') {
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset') || 0);
        // Mimic prod ATOM: only singular state/type filters
        const st = url.searchParams.get('state'), ty = url.searchParams.get('type');
        const pool = state.alerts.filter(a => (!st || a.state === st) && (!ty || a.type === ty));
        const items = pool.slice(offset, offset + limit);
        return send(200, { items, has_next: offset + limit < pool.length, limit, offset });
      }
      const m = p.match(/^\/alerts\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const id = decodeURIComponent(m[1]);
        const a = state.byId[id] || state.alerts.find(x => x.alert_id === id);
        return a ? send(200, a) : send(404, { error: 'not found' });
      }
      if (p === '/cache/published_playlist') {
        return send(200, { feed_code: url.searchParams.get('feed_code'),
          playlist: { id: state.playlist.playlist.id, version: '3', published_at: '2026-11-18T06:10:00Z' } });
      }
      const pm = p.match(/^\/customers\/([^/]+)\/feeds\/([^/]+)\/playlist$/);
      if (pm) return state.playlist ? send(200, state.playlist) : send(404, { error: 'no playlist' });
      const cm = p.match(/^\/customers\/([^/]+)$/);
      if (cm) {
        const c = state.customers[decodeURIComponent(cm[1])];
        return c ? send(200, c) : send(404, { error: 'not found' });
      }
      send(404, { error: 'not found' });
    });
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    state.server = server;
    state.baseUrl = `http://127.0.0.1:${server.address().port}/v1/api`;
    resolve(state);
  }));
}

module.exports = { startFakeAtom, makeAlert };

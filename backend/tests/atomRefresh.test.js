'use strict';

// Tests talk to a local fake ATOM: lift the production rate cap so they run instantly
process.env.ATOM_MAX_REQUESTS_PER_MIN = '100000';
process.env.ATOM_MAX_CONCURRENCY = '8';

// SSO refresh-token auth: renewal, rotation persistence across restarts, single-flight, 401 recovery.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { startFakeAtom } = require('./helpers/fakeAtom');

const SESSION = path.join(__dirname, 'test_atom_session.json');
let fake;

/** Fresh atomApi module = simulated process restart. */
function loadAtom(env) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../atomApi')];
  return require('../atomApi');
}
const authHeaders = () => fake.requests.filter(r => r.path === '/v1/api/alerts').map(r => r.headers.authorization);

describe('ATOM SSO refresh-token auth', () => {
  before(async () => {
    fake = await startFakeAtom();
    if (fs.existsSync(SESSION)) fs.unlinkSync(SESSION);
    for (const k of ['ATOM_API_KEY', 'ATOM_BEARER_TOKEN', 'ATOM_EMAIL', 'ATOM_PASSWORD', 'DEMO_MODE', 'ATOM_WRITEBACK']) delete process.env[k];
    Object.assign(process.env, { ATOM_BASE_URL: fake.baseUrl, ATOM_SESSION_FILE: SESSION, ATOM_ALERT_TYPES: '*', ATOM_ALERT_STATES: 'active' });
  });
  after(() => { fake.server.close(); if (fs.existsSync(SESSION)) fs.unlinkSync(SESSION); });

  it('renews the access token from the refresh token and saves the rotated one (0600)', async () => {
    const atom = loadAtom({ ATOM_REFRESH_TOKEN: 'rt-0' });
    assert.equal(atom.authInfo().mode, 'refresh');
    await atom.fetchAlerts();
    assert.equal(fake.refreshCount, 1);
    assert.equal(authHeaders().at(-1), 'Bearer sso-1');
    const saved = JSON.parse(fs.readFileSync(SESSION, 'utf8'));
    assert.equal(saved.refresh_token, 'rt-1');
    assert.equal(fs.statSync(SESSION).mode & 0o777, 0o600);
    assert.ok(atom.authInfo().expires_at);
    assert.equal(JSON.stringify(atom.authInfo()).includes('rt-1'), false, 'authInfo never leaks tokens');
  });

  it('reuses a still-valid access token without refreshing', async () => {
    const atom = loadAtom({ ATOM_REFRESH_TOKEN: 'rt-0' }); // restart; env token is stale now
    await atom.fetchAlerts();
    assert.equal(fake.refreshCount, 1, 'no extra refresh');
    assert.equal(authHeaders().at(-1), 'Bearer sso-1');
  });

  it('after a restart, continues from the saved (rotated) refresh token — not the stale env one', async () => {
    fake.revoked.add('sso-1'); // access token expired server-side → 401 → refresh with rt-1
    const atom = loadAtom({ ATOM_REFRESH_TOKEN: 'rt-0' });
    await atom.fetchAlerts();
    assert.equal(fake.refreshCount, 2);
    assert.equal(authHeaders().at(-1), 'Bearer sso-2');
    assert.equal(JSON.parse(fs.readFileSync(SESSION, 'utf8')).refresh_token, 'rt-2');
  });

  it('refreshes once even when many requests need a new token at the same time', async () => {
    fake.tokenTtlMs = 60e3; // < 2-minute margin → next call renews
    const atom = loadAtom({ ATOM_REFRESH_TOKEN: 'rt-0' });
    fake.revoked.add('sso-2');
    await atom.getAlert('1001'); // renews → sso-3 with 60s TTL
    const before = fake.refreshCount;
    await Promise.all(['1001', '1002', '1003', '1001', '1002'].map(id => atom.getAlert(id)));
    assert.equal(fake.refreshCount, before + 1, 'concurrent callers share one refresh');
    fake.tokenTtlMs = 3600e3;
  });

  it('a new ATOM_REFRESH_TOKEN in .env takes precedence over the saved session', async () => {
    fake.validRefresh = 'rt-fresh-from-browser';
    const atom = loadAtom({ ATOM_REFRESH_TOKEN: 'rt-fresh-from-browser' });
    fake.revoked.add(`sso-${fake.refreshCount}`);
    await atom.fetchAlerts();
    assert.equal(JSON.parse(fs.readFileSync(SESSION, 'utf8')).refresh_token, fake.validRefresh);
  });

  it('reports a clear error when the refresh token is no longer valid', async () => {
    fake.validRefresh = 'something-else';
    if (fs.existsSync(SESSION)) fs.unlinkSync(SESSION);
    const atom = loadAtom({ ATOM_REFRESH_TOKEN: 'rt-revoked' });
    await assert.rejects(atom.fetchAlerts(), /Token refresh failed \(401\).*ATOM_REFRESH_TOKEN/);
    assert.match(atom.authInfo().error, /Token refresh failed/);
  });
});

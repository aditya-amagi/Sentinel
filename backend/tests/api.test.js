'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Configure isolated test DB before requiring server & db
const TEST_DB = path.join(__dirname, 'test_api_sentinel.db');
process.env.DB_PATH = TEST_DB;
process.env.SESSION_SECRET = 'test_secret_key_12345';
process.env.NODE_ENV = 'test';

const db = require('../db');
const app = require('../server');

describe('API Route Integration Tests', () => {
  let server;
  let baseUrl;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db.getDb(); // trigger schema creation

    // Seed test issue
    db.upsertIssue({
      atom_issue_id: 'TEST-ATOM-1',
      playlist_id: 'PL-101',
      feed_code: 'TEST_FEED_HD',
      region: 'APAC',
      host: 'host-1',
      account: 'test_account',
      issue_type: 'HOLE',
      consolidated_status: 'active',
      playlist_date: '2026-11-04',
      playlist_start_time: '2099-01-01T00:00:00Z', // Far future to ensure it shows in upcoming
      status: 'open',
      penalty: 1,
      asset_id: 'PROMO_001',
      state: 'penalty',
    });

    // Start server on ephemeral port
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      db.getDb().close();
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
      if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
      if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    } catch {}
  });

  it('GET /healthz/live returns 200 with status ok and uptime', async () => {
    const res = await fetch(`${baseUrl}/healthz/live`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(typeof data.uptime, 'number');
  });

  it('GET /healthz/ready returns 200 and confirms DB connection', async () => {
    const res = await fetch(`${baseUrl}/healthz/ready`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.db, 'connected');
  });

  it('GET /metrics returns Prometheus format exposition', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('sentinel_uptime_seconds'));
    assert.ok(text.includes('sentinel_alerts_total'));
    assert.ok(text.includes('sentinel_alerts_by_state{state="penalty"}'));
  });

  it('GET /api/alert-types returns the canonical 4 invariants', async () => {
    const res = await fetch(`${baseUrl}/api/alert-types`);
    assert.equal(res.status, 200);
    const types = await res.json();
    assert.equal(types.length, 4);
    const keys = types.map(t => t.key);
    assert.deepEqual(keys, ['HOLE', 'NO_PLAYLIST', 'DURATION_MISMATCH', 'MISSING_IN_CLOUD']);
  });

  it('GET /api/issues/upcoming returns test issue in penalty state', async () => {
    const res = await fetch(`${baseUrl}/api/issues/upcoming`);
    assert.equal(res.status, 200);
    const issues = await res.json();
    assert.ok(Array.isArray(issues));
    const item = issues.find(i => i.atom_issue_id === 'TEST-ATOM-1');
    assert.ok(item);
    assert.equal(item.state, 'penalty');
  });

  it('PATCH /api/issues/:atomIssueId/playlist/:playlistId/state transitions state to ack and syncs acknowledged', async () => {
    const patchRes = await fetch(`${baseUrl}/api/issues/TEST-ATOM-1/playlist/PL-101/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'ack' }),
    });
    assert.equal(patchRes.status, 200);
    const body = await patchRes.json();
    assert.equal(body.issue.state, 'ack');
    assert.equal(body.issue.acknowledged, 1);
  });

  it('PATCH rejects invalid state transitions', async () => {
    const patchRes = await fetch(`${baseUrl}/api/issues/TEST-ATOM-1/playlist/PL-101/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'invalid_status' }),
    });
    assert.equal(patchRes.status, 400);
  });

  it('GET /api/tickets/check verifies absence of duplicate prior tickets', async () => {
    const res = await fetch(`${baseUrl}/api/tickets/check?feed_code=TEST_FEED_HD&issue_type=HOLE&asset_id=PROMO_001&playlist_id=PL-101&playlist_date=2026-11-04`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.has_previous, false);
    assert.equal(data.previous_ticket, null);
  });
});

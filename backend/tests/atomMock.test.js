'use strict';

// Mock mode (no ATOM_BASE_URL): realistic offline ATOM data through the real ingestion path.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, 'test_mock.db');
const clean = () => { for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); };
let db, sync, atom, calls = 0;

describe('mock mode', () => {
  before(async () => {
    clean();
    for (const k of ['ATOM_BASE_URL', 'ATOM_API_KEY', 'ATOM_REFRESH_TOKEN', 'ATOM_BEARER_TOKEN', 'DEMO_MODE', 'ATOM_VIEWS']) delete process.env[k];
    // Generated data (a local production snapshot, if any, must not leak into tests)
    Object.assign(process.env, { DB_PATH: TEST_DB, NODE_ENV: 'test', ATOM_MOCK_SNAPSHOT: 'off' });
    // Any outbound HTTP in mock mode is a bug
    for (const m of [require('http'), require('https')]) { const o = m.request; m.request = function (...a) { calls++; return o.apply(this, a); }; }
    atom = require('../atomApi');
    db = require('../db');
    sync = require('../sync');
    await sync.triggerSync();
  });
  after(clean);

  it('makes no network requests', () => assert.equal(calls, 0));

  it('ingests view-tagged alerts shaped like prod ATOM', () => {
    const s = sync.getSyncStatus();
    assert.equal(s.lastSyncStatus, 'success', s.lastSyncError);
    assert.equal(s.counts.mode, 'views');
    const rows = db.getDb().prepare('SELECT * FROM issues').all();
    assert.ok(rows.length > 10);
    for (const r of rows) {
      assert.ok(r.view_group, 'every alert has a view group');
      assert.ok(r.raw_type && r.severity && r.amg_id && r.feed_name, `fields on ${r.atom_issue_id}`);
      assert.equal(r.region, r.view_group);
    }
    assert.ok(rows.some(r => r.issue_type === 'HOLE' || r.issue_type === 'MISSING_IN_CLOUD'), 'TOC types present');
    assert.ok(!rows.some(r => r.issue_type === 'player_rescue_detected_alert'), 'Playout Rescue not ingested');
    assert.ok(rows.some(r => JSON.parse(r.atom_view_names || '[]').includes('Service Alerts')), 'Service Alerts present');
  });

  it('builds the feed catalog and view summary offline', () => {
    assert.ok(db.countAtomFeeds() >= 5);
    const groups = db.getViewSummary().map(g => g.group);
    for (const g of ['EMEA', 'APAC', 'America']) assert.ok(groups.includes(g), g);
    assert.ok(!groups.includes('All CP'), 'catch-all view not selected');
  });

  it('is stable across syncs (same alerts, no duplicates)', async () => {
    const before = db.getDb().prepare('SELECT COUNT(*) c FROM issues').get().c;
    await sync.triggerSync();
    const after = db.getDb().prepare('SELECT COUNT(*) c FROM issues').get().c;
    assert.ok(Math.abs(after - before) <= 3, `${before} → ${after}`);
  });
});

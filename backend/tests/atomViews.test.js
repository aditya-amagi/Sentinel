'use strict';

// Tests talk to a local fake ATOM: lift the production rate cap so they run instantly
process.env.ATOM_MAX_REQUESTS_PER_MIN = '100000';
process.env.ATOM_MAX_CONCURRENCY = '8';

// View-based ingestion: Sentinel pulls the alerts present in the selected ATOM saved views.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { startFakeAtom, makeAlert } = require('./helpers/fakeAtom');

const TEST_DB = path.join(__dirname, 'test_views.db');
const clean = () => { for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); };
const recent = h => new Date(Date.now() - h * 3600e3).toISOString();
let fake, db, sync, atom, app, server, base;
const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const has = id => !!db.getDb().prepare('SELECT 1 FROM issues WHERE atom_issue_id=?').get(id);

describe('ATOM saved views', () => {
  before(async () => {
    fake = await startFakeAtom();
    fake.alerts = [
      makeAlert(1, { issue_start_time: recent(1) }),                                  // EMEA Schedule
      makeAlert(2, { issue_start_time: recent(2) }),                                  // EMEA Schedule + APAC Schedule
      makeAlert(3, { issue_start_time: recent(3), type: 'asset_failed' }),            // EMEA Asset
      makeAlert(4, { issue_start_time: recent(1), type: 'player_no_input_stream_alert' }), // Service Alerts
      makeAlert(7, { issue_start_time: recent(1), type: 'player_rescue_detected_alert' }), // Playout Rescue → not selected
      makeAlert(5, { issue_start_time: recent(1) }),                                  // only in "All CP Alerts" → excluded
      makeAlert(6, { issue_start_time: recent(200) }),                                // EMEA Schedule but older than 72h
    ];
    fake.views = [
      { id: 1,  name: 'All CP Alerts' },
      { id: 16, name: 'EMEA Schedule Alerts' },
      { id: 17, name: 'EMEA Asset Alerts' },
      { id: 19, name: 'APAC Schedule Alerts' },
      { id: 37, name: 'Service Alerts' },
      { id: 38, name: 'Playout Rescue' },
      { id: 53, name: 'Bein EMEA Asset' },
      { id: 42, name: 'Live alerts' },
    ];
    fake.viewMembers = { 1: ['1001', '1002', '1003', '1004', '1005', '1006'], 16: ['1001', '1002', '1006'], 17: ['1003'], 19: ['1002'], 37: ['1004'], 38: ['1007'], 53: [], 42: ['1005'] };
    clean();
    Object.assign(process.env, { ATOM_BASE_URL: fake.baseUrl, ATOM_API_KEY: 'k', ATOM_VIEWS: 'auto', ATOM_PAGE_SIZE: '2',
      DB_PATH: TEST_DB, NODE_ENV: 'test', SESSION_SECRET: 'x' });
    for (const k of ['ATOM_WRITEBACK', 'DEMO_MODE', 'ATOM_ALERT_TYPES', 'ATOM_REFRESH_TOKEN', 'ATOM_BEARER_TOKEN']) delete process.env[k];
    atom = require('../atomApi');
    db = require('../db');
    sync = require('../sync');
    app = require('../server');
    await sync.triggerSync();
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fake.server.close(); clean(); });

  it('parses view names into group + family', () => {
    assert.deepEqual(atom.parseViewName('EMEA Schedule Alerts'), { group: 'EMEA', family: 'Schedule' });
    assert.deepEqual(atom.parseViewName('Bein EMEA Asset'), { group: 'Bein EMEA', family: 'Asset' });
    assert.deepEqual(atom.parseViewName('Playout Rescue'), { group: 'Playout Rescue', family: null });
  });

  it('selects region/customer views + Service Alerts, not catch-alls or Playout Rescue', () => {
    const sel = atom.getViewList().filter(v => v.selected).map(v => v.id).sort((a, b) => a - b);
    assert.deepEqual(sel, [16, 17, 19, 37], 'monitored groups + Service Alerts; Bein EMEA not monitored');
  });

  it('queries each view with only the filters ATOM allows (no type/entity)', () => {
    const q = fake.requests.filter(r => r.path === '/v1/api/alerts' && r.query.view_id);
    assert.ok(q.length > 0);
    for (const r of q) {
      assert.equal(r.query.type, undefined);
      assert.equal(r.query['entity[product]'], undefined);
    }
    assert.ok(q.some(r => r.query.view_id === '16' && r.query.offset === '2'), 'pages through a view');
  });

  it('ingests exactly the alerts present in the selected views, within 72h', () => {
    const s = sync.getSyncStatus();
    assert.equal(s.lastSyncStatus, 'success', s.lastSyncError);
    assert.equal(s.counts.mode, 'views');
    assert.equal(has('1001'), true);
    assert.equal(has('1002'), true);
    assert.equal(has('1003'), true);
    assert.equal(has('1004'), true, 'Service Alerts view');
    assert.equal(has('1007'), false, 'Playout Rescue is not ingested');
    assert.equal(has('1005'), false, 'only in catch-all views');
    assert.equal(has('1006'), false, 'older than the 72h window');
  });

  it('tags alerts with their views; the group becomes the region', () => {
    const r = db.getIssueByCompositeKey('1002', '230001').issue;
    assert.equal(r.atom_view_ids, ',16,19,');
    assert.deepEqual(JSON.parse(r.atom_view_names), ['EMEA Schedule Alerts', 'APAC Schedule Alerts']);
    assert.equal(r.view_group, 'EMEA');
    assert.equal(r.region, 'EMEA');
    assert.equal(r.view_family, 'Schedule');
  });

  it('serves the sidebar summary and filters by group, family and view', async () => {
    const v = (await get('/api/views')).body;
    const emea = v.find(g => g.group === 'EMEA');
    assert.deepEqual(emea.views.map(x => x.family).sort(), ['Asset', 'Schedule']);
    assert.equal(emea.views.find(x => x.family === 'Schedule').open, 2);
    assert.equal((await get('/api/issues/upcoming?region=emea&view_family=Asset')).body.map(i => i.atom_issue_id).join(), '1003');
    assert.deepEqual((await get('/api/issues/upcoming?view_id=19')).body.map(i => i.atom_issue_id), ['1002']);
  });

  it('opens alerts without a playlist ("-" in the URL stands for an empty playlist_id)', async () => {
    db.upsertIssue({ atom_issue_id: 'NP-1', playlist_id: '', raw_type: 'no_published_playlist', issue_type: 'NO_PLAYLIST', feed_code: 'NPF' });
    const r = await get('/api/issues/NP-1/playlist/-');
    assert.equal(r.status, 200);
    assert.equal(r.body.issue.atom_issue_id, 'NP-1');
    assert.equal(r.body.issue.playlist_id, '');
    assert.equal((await get('/api/issues/NP-1/playlist/-/snooze-options')).status, 200);
    db.getDb().prepare("DELETE FROM issues WHERE atom_issue_id='NP-1'").run();
  });

  it('counts Asset-view alerts as TOC, other types stay in Other', async () => {
    const ids = q => get(`/api/issues/upcoming?${q}`).then(r => r.body.map(i => i.atom_issue_id).sort());
    const toc = await ids('toc_only=true');
    const other = await ids('toc_only=false');
    assert.ok(toc.includes('1003'), 'asset_failed in EMEA Asset view → TOC');
    assert.ok(toc.includes('1001') && toc.includes('1002'), 'canonical TOC types');
    assert.deepEqual(other, ['1004'], 'Service Alerts type is Other');
    const all = (await get('/api/issues/upcoming')).body;
    assert.equal(all.find(i => i.atom_issue_id === '1003').is_toc, 1);
    assert.equal(all.find(i => i.atom_issue_id === '1004').is_toc, 0);
    const stats = (await get('/api/stats')).body;
    assert.equal(stats.toc_open, 3);
    assert.equal(stats.other_open, 1);
  });

  it('purges untouched alerts that leave every view, keeps triaged ones', async () => {
    db.updateIssue(db.getIssueByCompositeKey('1003', '230001').issue.id, { state: 'ack', acknowledged: 1 });
    fake.viewMembers[16] = ['1002'];   // 1001 now ignored by the view
    fake.viewMembers[17] = [];         // 1003 left its view, but someone acked it
    await sync.triggerSync();
    assert.equal(has('1001'), false);
    assert.equal(has('1003'), true);
  });

  it('a failing view only protects alerts that belong to it', async () => {
    // 1002 belongs to views 16 and 19; view 19 will fail → 1002 must survive even though 16 drops it
    fake.viewMembers[16] = [];
    db.upsertIssue({ atom_issue_id: 'LEGACY-1', playlist_id: '', raw_type: 'hole_in_playlist', issue_type: 'HOLE', feed_code: 'X' });
    const orig = fake.server.listeners('request')[0];
    fake.server.removeAllListeners('request');
    fake.server.on('request', (req, res) => {
      if (req.url.includes('view_id=19')) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
      orig(req, res);
    });
    await sync.triggerSync();
    assert.equal(sync.getSyncStatus().counts.truncated, true);
    assert.equal(has('1002'), true, 'kept: it belongs to the failed view');
    assert.equal(has('LEGACY-1'), false, 'leftover with no view membership is still reconciled');
    fake.server.removeAllListeners('request');
    fake.server.on('request', orig);
  });

  it('syncs lanes separately: an Asset-only run leaves Schedule alerts alone', async () => {
    assert.deepEqual([16, 17, 19, 37, 53].map(id => atom.laneOf(atom.getViewList().find(v => v.id === id))),
      ['schedule', 'asset', 'schedule', 'other', 'asset']);
    // Fresh full sync: 1001 in EMEA Schedule, 1003 in EMEA Asset + EMEA Schedule, 1004 in Service Alerts
    fake.viewMembers = { 1: [], 16: ['1001', '1003'], 17: ['1003'], 19: [], 37: ['1004'], 38: [], 53: [], 42: [] };
    await sync.triggerSync();
    const views = id => db.getDb().prepare('SELECT atom_view_ids FROM issues WHERE atom_issue_id=?').get(id)?.atom_view_ids;
    assert.equal(views('1003'), ',16,17,');

    // Asset lane only; meanwhile 1001 left its Schedule view and 1003 left the Asset view
    fake.viewMembers[16] = ['1003'];
    fake.viewMembers[17] = [];
    fake.requests.length = 0;
    await sync.triggerSync({ lanes: ['asset'] });
    const viewIds = fake.requests.filter(r => r.path === '/v1/api/alerts' && r.query.view_id).map(r => r.query.view_id);
    assert.deepEqual([...new Set(viewIds)].sort(), ['17'], 'only Asset views queried');
    assert.equal(sync.getSyncStatus().lastSyncStatus, 'success');
    assert.equal(has('1001'), true, 'Schedule alert untouched until its lane syncs');
    assert.equal(has('1004'), true, 'Service alert untouched');
    assert.equal(views('1003'), ',16,', 'left the Asset view, still in Schedule');

    // Schedule lane: now 1001 is reconciled
    await sync.triggerSync({ lanes: ['schedule'] });
    assert.equal(has('1001'), false);
    assert.equal(views('1003'), ',16,');
    assert.equal(has('1004'), true);
  });
});

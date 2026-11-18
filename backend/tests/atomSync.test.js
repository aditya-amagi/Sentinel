'use strict';

// Full sync against a fake ATOM: catalog → atom_feeds, contact prefill, full-field storage,
// resolution detection, the truncation guard, filters, playlist context and the ticket body.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { startFakeAtom, makeAlert } = require('./helpers/fakeAtom');

const TEST_DB = path.join(__dirname, 'test_sync.db');
let fake, db, sync, app, server, base;
const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const clean = () => { for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); };

describe('ATOM sync → Sentinel', () => {
  before(async () => {
    fake = await startFakeAtom();
    fake.alerts.push(makeAlert(4, { type: 'tarang_media_seq_stall_alert', severity: 'critical', name: 'Media seq stall' }));
    // Monitoring switch cases
    fake.alerts.push(makeAlert(5, { custom: { feed_code: 'ABC_OFF', headend_code: 'off_001' } }));            // feed monitoring off
    fake.alerts.push(makeAlert(6, { custom: { feed_code: 'ABC_MIXED', headend_code: 'mx_off' } }));           // its headend off
    fake.alerts.push(makeAlert(7, { custom: { feed_code: 'ABC_MIXED', headend_code: 'mx_on' } }));            // its headend on
    fake.alerts.push(makeAlert(8, { custom: { feed_code: 'ABC_MIXED', headend_code: undefined } }));          // no headend, feed has one on
    fake.alerts.push(makeAlert(9, { custom: { automation_url: 'dataonly.amagi.tv', feed_code: 'DO_FEED' } })); // customer data_only
    fake.alerts.push(makeAlert(10, { custom: { automation_url: 'unknown.amagi.tv', feed_code: 'UNKNOWN' } })); // not in catalog
    clean();
    Object.assign(process.env, { ATOM_BASE_URL: fake.baseUrl, ATOM_API_KEY: 'k', ATOM_PAGE_SIZE: '10', ATOM_MAX_PAGES: '5', ATOM_ALERT_TYPES: '*',
      DB_PATH: TEST_DB, NODE_ENV: 'test', SESSION_SECRET: 'x' });
    delete process.env.ATOM_WRITEBACK;
    delete process.env.DEMO_MODE;
    db = require('../db');
    sync = require('../sync');
    app = require('../server');
    await sync.triggerSync();
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fake.server.close(); clean(); });

  it('stores every alert with full ATOM fields', () => {
    const s = sync.getSyncStatus();
    assert.equal(s.lastSyncStatus, 'success', s.lastSyncError);
    assert.equal(s.counts.issues, 7); // 1001–1004 + 1007, 1008 (monitored) + 1010 (unknown feed, fail open)
    assert.equal(s.counts.skipped_unmonitored, 3);
    const r = db.getIssueByCompositeKey('1004', '230001').issue;
    assert.equal(r.issue_type, 'tarang_media_seq_stall_alert');
    assert.equal(r.severity, 'critical');
    assert.equal(r.alert_name, 'Media seq stall');
    assert.equal(r.dedup_key, 'b2c3d4e5f6789004');
    assert.equal(r.duration_ms, 300000);
    assert.equal(r.consolidated_status, 'active');
    assert.equal(r.labels, '{"team":"toc"}');
  });

  it('only keeps alerts on feeds/headends with ATOM monitoring on', () => {
    const has = id => !!db.getDb().prepare('SELECT 1 FROM issues WHERE atom_issue_id=?').get(id);
    assert.equal(has('1005'), false, 'feed with monitoring off');
    assert.equal(has('1006'), false, 'alert on a headend with monitoring off');
    assert.equal(has('1007'), true,  'alert on a monitored headend');
    assert.equal(has('1008'), true,  'no headend, feed has a monitored headend');
    assert.equal(has('1009'), false, 'customer data_only');
    assert.equal(has('1010'), true,  'feed not in catalog → shown (fail open)');
    assert.equal(db.getAtomFeed('ABC_OFF').monitored, 0);
    assert.equal(db.getAtomFeed('DO_FEED').data_only, 1);
  });

  it('purges untouched alerts when a feed is switched off, but keeps triaged ones', async () => {
    db.updateIssue(db.getIssueByCompositeKey('1007', '230001').issue.id, { state: 'ack', acknowledged: 1 });
    fake.customers['customer-abc.amagi.tv'].accounts[0].feeds[2].headends.forEach(h => { h.health.monitoring = false; });
    db.getDb().prepare(`UPDATE atom_feeds SET synced_at = datetime('now','-1 day')`).run(); // force catalog refresh
    await sync.triggerSync();
    const has = id => !!db.getDb().prepare('SELECT 1 FROM issues WHERE atom_issue_id=?').get(id);
    assert.equal(has('1008'), false, 'untriaged alert on now-unmonitored feed removed');
    assert.equal(has('1007'), true, 'acked alert kept for the record');
    fake.customers['customer-abc.amagi.tv'].accounts[0].feeds[2].headends[0].health.monitoring = true;
  });

  it('syncs the feed catalog and pre-fills the customer name', () => {
    const f = db.getAtomFeed('AMG01579C1');
    assert.equal(f.feed_name, 'ABC Movies HD');
    assert.equal(f.time_zone, 'Asia/Kolkata');
    assert.equal(f.headends[0].code, 'fa_001');
    assert.equal(db.getFeedTicketConfig('AMG01579C1').customer_name, 'ABC Media');
  });

  it('never overwrites a manually set customer name', () => {
    db.upsertFeedTicketConfig({ feed_code: 'AMG01579C1', customer_name: 'Manual Name', product_version: null,
      contact_email: null, cc_emails: null, use_general_for_all: 1 });
    assert.equal(db.prefillCustomerName('AMG01579C1', 'ABC Media'), false);
    assert.equal(db.getFeedTicketConfig('AMG01579C1').customer_name, 'Manual Name');
  });

  it('keeps Sentinel triage state across syncs', async () => {
    db.updateIssue(db.getIssueByCompositeKey('1001', '230001').issue.id, { state: 'ack', acknowledged: 1 });
    await sync.triggerSync();
    assert.equal(db.getIssueByCompositeKey('1001', '230001').issue.state, 'ack');
  });

  it('does not mark alerts resolved when the fetch was truncated', async () => {
    const extra = Array.from({ length: 60 }, (_, i) => makeAlert(100 + i));
    const original = fake.alerts;
    fake.alerts = [...extra]; // 1001–1004 disappear, and 60 alerts > 10/page × 5 pages
    fake.byId['1002'] = makeAlert(2, { state: 'resolved', resolved_at: '2026-11-18T12:00:00Z', resolved_by: 'ops' });
    await sync.triggerSync();
    assert.equal(sync.getSyncStatus().counts.truncated, true);
    assert.equal(db.getIssueByCompositeKey('1002', '230001').issue.consolidated_status, 'active');
    fake.alerts = original;
  });

  it('detects alerts resolved in ATOM', async () => {
    fake.alerts = fake.alerts.filter(a => a.alert_id !== '1002');
    await sync.triggerSync();
    const r = db.getIssueByCompositeKey('1002', '230001').issue;
    assert.equal(r.consolidated_status, 'resolved');
    assert.equal(r.resolved_by, 'ops');
    assert.equal(r.status, 'resolved');
    assert.ok(sync.getSyncStatus().counts.resolved >= 1);
  });

  it('filters by TOC split, severity and ATOM state', async () => {
    const toc   = await get('/api/issues/upcoming?toc_only=true&atom_state=open');
    const other = await get('/api/issues/upcoming?toc_only=false');
    const crit  = await get('/api/issues/upcoming?severity=critical');
    const res   = await get('/api/issues/upcoming?atom_state=resolved');
    assert.ok(toc.body.every(i => ['HOLE','NO_PLAYLIST','DURATION_MISMATCH','MISSING_IN_CLOUD'].includes(i.issue_type)));
    assert.ok(!toc.body.some(i => i.atom_issue_id === '1002'), 'resolved hidden from open');
    assert.ok(other.body.some(i => i.atom_issue_id === '1004'));
    assert.ok(crit.body.every(i => i.severity === 'critical'));
    assert.deepEqual(res.body.map(i => i.atom_issue_id), ['1002']);
    const types = await get('/api/issue-types/other');
    assert.deepEqual(types.body, [{ key: 'tarang_media_seq_stall_alert', count: 1, label: 'Tarang Media Seq Stall' }]);
  });

  it('serves playlist context around the alert time', async () => {
    const r = await get('/api/issues/1001/playlist/230001/context');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    const cur = r.body.items.find(i => i.is_current);
    assert.equal(cur.title, 'Show B'); // 10:55 falls in 10:30–11:00
    assert.ok(r.body.items.find(i => i.is_asset_match).asset_id === 'ASSET-1');
  });

  it('serves the ATOM feed card and live alert', async () => {
    assert.equal((await get('/api/atom/feeds/AMG01579C1')).body.customer_name, 'ABC Media');
    assert.equal((await get('/api/atom/feeds/NOPE')).status, 404);
    const a = await get('/api/atom/alerts/1001');
    assert.equal(a.body.source, 'atom');
    assert.equal(a.body.alert.alert_id, '1001');
  });

  it('builds a richer Freshdesk ticket with severity priority', () => {
    const issue = db.getIssueByCompositeKey('1004', '230001').issue;
    const p = db.buildFreshdeskPayload(issue, 'internal');
    assert.equal(p.priority, 4);
    assert.match(p.subject, /Tarang Media Seq Stall - AMG01579C1/);
    for (const s of ['ABC Movies HD', 'Critical', 'Media seq stall', '5m', 'fa_001', 'customer-abc.amagi.tv', '1004', 'Asia/Kolkata'])
      assert.ok(p.description.includes(s), `description should include ${s}`);
  });
});

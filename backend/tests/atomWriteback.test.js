'use strict';

// Tests talk to a local fake ATOM: lift the production rate cap so they run instantly
process.env.ATOM_MAX_REQUESTS_PER_MIN = '100000';
process.env.ATOM_MAX_CONCURRENCY = '8';

// Write-back ON: PATCH /alerts bodies, the never-resolve guard, and the server routes
// (Ack → snooze, back to penalty → desnooze, ticket → comment) end to end.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { startFakeAtom } = require('./helpers/fakeAtom');

const TEST_DB = path.join(__dirname, 'test_writeback.db');
let fake, atom, db, app, server, base;

const api = (p, opts = {}) => fetch(base + p, {
  ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body),
}).then(async r => ({ status: r.status, body: await r.json() }));

describe('ATOM write-back (ATOM_WRITEBACK=true)', () => {
  before(async () => {
    fake = await startFakeAtom();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    Object.assign(process.env, {
      ATOM_BASE_URL: fake.baseUrl, ATOM_API_KEY: 'k', ATOM_WRITEBACK: 'true',
      DB_PATH: TEST_DB, NODE_ENV: 'test', SESSION_SECRET: 'x',
    });
    delete process.env.DEMO_MODE;
    delete process.env.FRESHDESK_DOMAIN;
    delete process.env.FRESHDESK_API_KEY;
    atom = require('../atomApi');
    db = require('../db');
    app = require('../server');
    await require('../sync').triggerSync();
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close(); fake.server.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  it('builds the documented PATCH bodies', async () => {
    fake.patches.length = 0;
    await atom.snoozeAlert('1001', '2026-11-18T13:00:00.000Z');
    await atom.desnoozeAlert('1001');
    await atom.commentAlert('1001', 'x'.repeat(600));
    assert.deepEqual(fake.patches[0], [{ alert_id: '1001', action: 'snooze', snooze_until: '2026-11-18T13:00:00.000Z' }]);
    assert.deepEqual(fake.patches[1], [{ alert_id: '1001', action: 'desnooze' }]);
    assert.equal(fake.patches[2][0].comment.length, 512);
  });

  it('refuses to resolve or to patch labels/custom_details', async () => {
    fake.patches.length = 0;
    assert.equal((await atom.patchAlerts([{ alert_id: '1', action: 'resolve' }])).ok, false);
    assert.equal((await atom.patchAlerts([{ alert_id: '1', labels: {} }])).ok, false);
    assert.equal(fake.patches.length, 0);
  });

  it('exposes snooze options including end of broadcast day', async () => {
    const r = await api('/api/issues/1001/playlist/230001/snooze-options');
    assert.equal(r.status, 200);
    assert.equal(r.body.writeback, true);
    assert.deepEqual(r.body.options.map(o => o.key).slice(0, 2), ['1h', '4h']);
  });

  it('Ack with snooze_until snoozes in ATOM; back to penalty desnoozes', async () => {
    fake.patches.length = 0;
    const until = new Date(Date.now() + 3600e3).toISOString();
    const ack = await api('/api/issues/1001/playlist/230001/state', { method: 'PATCH', body: { state: 'ack', snooze_until: until } });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.atom.ok, true);
    assert.equal(ack.body.issue.state, 'ack');
    assert.equal(ack.body.issue.consolidated_status, 'snoozed');
    assert.equal(ack.body.issue.snoozed_until, until);
    assert.deepEqual(fake.patches[0], [{ alert_id: '1001', action: 'snooze', snooze_until: until }]);

    const back = await api('/api/issues/1001/playlist/230001/state', { method: 'PATCH', body: { state: 'penalty' } });
    assert.equal(back.body.issue.consolidated_status, 'active');
    assert.deepEqual(fake.patches[1], [{ alert_id: '1001', action: 'desnooze' }]);
  });

  it('Ack without snooze_until does not touch ATOM', async () => {
    fake.patches.length = 0;
    const r = await api('/api/issues/1002/playlist/230001/state', { method: 'PATCH', body: { state: 'ack' } });
    assert.equal(r.status, 200);
    assert.equal(fake.patches.length, 0);
  });

  it('rejects invalid snooze_until', async () => {
    const past = await api('/api/issues/1003/playlist/230001/state', { method: 'PATCH', body: { state: 'ack', snooze_until: '2020-01-01T00:00:00Z' } });
    assert.equal(past.status, 400);
    const wrongState = await api('/api/issues/1003/playlist/230001/state', { method: 'PATCH',
      body: { state: 'penalty', snooze_until: new Date(Date.now() + 3600e3).toISOString() } });
    assert.equal(wrongState.status, 400);
  });

  it('creating a Freshdesk ticket comments on the ATOM alert', async () => {
    fake.patches.length = 0;
    const r = await api('/api/freshdesk/create', { method: 'POST', body: { atom_issue_id: '1003', playlist_id: '230001', ticket_type: 'internal' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.atom.ok, true);
    // The ticket covers every open hole on that feed/day (1003 + 1001) → one comment per covered alert
    assert.equal(r.body.covers, fake.patches.length);
    assert.ok(fake.patches.map(p => p[0].alert_id).includes('1003'));
    for (const p of fake.patches) {
      assert.match(p[0].comment, /^Sentinel: Freshdesk #INC-\d+ \(internal\) created by dev@amagi\.com/);
      assert.equal(p[0].action, undefined, 'comment only — never resolves');
    }
    // Every covered alert is now Ticketed (previously creation never set the state)
    assert.equal(db.getIssueByCompositeKey('1003', '230001').issue.state, 'ticketed');
  });

  it('records a write-back failure without blocking the local change', async () => {
    fake.server.close();
    const r = await api('/api/issues/1002/playlist/230001/state', { method: 'PATCH',
      body: { state: 'penalty' } });
    assert.equal(r.status, 200); // 1002 was not snoozed → no ATOM call needed
    const until = new Date(Date.now() + 3600e3).toISOString();
    const r2 = await api('/api/issues/1002/playlist/230001/state', { method: 'PATCH', body: { state: 'ack', snooze_until: until } });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.issue.state, 'ack');
    assert.equal(r2.body.atom.ok, false);
    assert.ok(r2.body.issue.atom_writeback_error);
    assert.ok(db.getStats().writeback_errors >= 1);
  });
});

describe('Follow-ups', () => {
  it('previews a suggested template and sends it as a reply on the original ticket', async () => {
    const pv = await api('/api/freshdesk/followup/preview', { method: 'POST', body: { atom_issue_id: '1003', playlist_id: '230001' } });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.ok(['reminder', 'urgent', 'aired', 'resolved'].includes(pv.body.suggested));
    assert.equal(pv.body.followups_sent, 0);
    assert.match(pv.body.html, /Follow-up #1/);

    fake.patches.length = 0;
    const sent = await api('/api/freshdesk/followup', { method: 'POST',
      body: { atom_issue_id: '1003', playlist_id: '230001', template: 'reminder', message: 'Please confirm the ETA.' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.number, 1);
    // ATOM comment was attempted (the fake ATOM is down after the outage test above);
    // an ATOM failure never blocks the follow-up itself
    assert.ok(sent.body.atom && !sent.body.atom.skipped);
    assert.equal(sent.body.atom.ok, false);

    const pv2 = await api('/api/freshdesk/followup/preview', { method: 'POST', body: { atom_issue_id: '1003', playlist_id: '230001', template: 'custom', message: 'x' } });
    assert.equal(pv2.body.followups_sent, 1);
    assert.match(pv2.body.html, /Follow-up #2/);
  });

  it('rejects unknown templates, empty custom messages, and issues without a ticket', async () => {
    assert.equal((await api('/api/freshdesk/followup', { method: 'POST', body: { atom_issue_id: '1003', playlist_id: '230001', template: 'nope' } })).status, 400);
    assert.equal((await api('/api/freshdesk/followup', { method: 'POST', body: { atom_issue_id: '1003', playlist_id: '230001', template: 'custom', message: ' ' } })).status, 400);
    assert.equal((await api('/api/freshdesk/followup/preview', { method: 'POST', body: { atom_issue_id: '1002', playlist_id: '230001' } })).status, 409);
  });
});

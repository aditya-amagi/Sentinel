'use strict';

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
    assert.equal(fake.patches.length, 1);
    assert.equal(fake.patches[0][0].alert_id, '1003');
    assert.match(fake.patches[0][0].comment, /^Sentinel: Freshdesk #INC-\d+ \(internal\) created by dev@amagi\.com/);
    assert.equal(fake.patches[0][0].action, undefined, 'comment only — never resolves');
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

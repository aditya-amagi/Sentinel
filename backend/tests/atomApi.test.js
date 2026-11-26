'use strict';

// Tests talk to a local fake ATOM: lift the production rate cap so they run instantly
process.env.ATOM_MAX_REQUESTS_PER_MIN = '100000';
process.env.ATOM_MAX_CONCURRENCY = '8';

// atomApi.js against a fake ATOM (read paths; write-back OFF).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFakeAtom, makeAlert } = require('./helpers/fakeAtom');

let fake, atom;

describe('atomApi (ATOM v1, read-only)', () => {
  before(async () => {
    fake = await startFakeAtom();
    process.env.ATOM_BASE_URL = `${fake.baseUrl}/`;
    process.env.ATOM_API_KEY = 'test-key';
    process.env.ATOM_PAGE_SIZE = '2'; // force pagination over 3 alerts
    delete process.env.ATOM_WRITEBACK;
    process.env.ATOM_ALERT_TYPES = '*';
    process.env.ATOM_LOOKBACK_HOURS = '72';
    delete process.env.DEMO_MODE;
    atom = require('../atomApi');
  });
  after(() => fake.server.close());

  it('pages through /alerts with X-API-Key, all types, active+snoozed, product CP', async () => {
    const { issues, truncated } = await atom.fetchAlerts();
    assert.equal(issues.length, 3);
    assert.equal(truncated, false);

    const reqs = fake.requests.filter(r => r.path === '/v1/api/alerts');
    assert.deepEqual(reqs.filter(r => r.query.state === 'active').map(r => r.query.offset), ['0', '2']);
    assert.equal(reqs[0].headers['x-api-key'], 'test-key');
    // Singular filters (prod ATOM has no `states`/`types`): one query per state
    assert.equal(reqs[0].query.state, 'active');
    assert.equal(reqs[0].query.states, undefined);
    assert.equal(reqs[0].query.type, undefined, 'no type filter = all types');
    assert.ok(fake.requests.some(r => r.path === '/v1/api/alerts' && r.query.state === 'snoozed'));
    assert.equal(reqs[0].query['entity[product]'], 'CP');
  });

  it('limits the fetch to the lookback window (issue_start_time >= now - 72h)', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const plan = atom.queryPlan(now);
    assert.deepEqual(plan.map(p => p.state), ['active', 'snoozed']);
    assert.ok(plan.every(p => p.issue_start_time === '2026-11-15T12:00:00.000Z'));
    assert.ok(plan.every(p => p.type === undefined), 'ATOM_ALERT_TYPES=* → no type filter');
  });

  it('default type list covers the 4 TOC types and skips pipeline-progress states', () => {
    const AT = require('../alertTypes');
    const d = atom.DEFAULT_ALERT_TYPES;
    assert.deepEqual(d.slice(0, 4).map(t => AT.toEnumKey(t)).sort(), ['DURATION_MISMATCH', 'HOLE', 'MISSING_IN_CLOUD', 'NO_PLAYLIST']);
    for (const t of ['asset_download_waiting', 'asset_submitted', 'asset_queued']) assert.ok(!d.includes(t));
  });

  it('maps every ATOM alert field onto a Sentinel issue', async () => {
    const [iss] = await atom.getIssues();
    assert.deepEqual({ ...iss }, {
      id: '1001', feed_code: 'AMG01579C1', automation_url: 'customer-abc.amagi.tv',
      region: 'APAC', host: 'fa_001', headend_code: 'fa_001', account: 'acct-001',
      issue_type: 'HOLE', raw_type: 'hole_in_playlist', consolidated_status: 'active',
      severity: 'major', alert_name: 'Hole in playlist', description: 'Alert 1 description',
      product: 'CP', entity_service: 'asset', dedup_key: 'b2c3d4e5f6789001', correlation_id: 'corr-1',
      feed_name: 'server-02', amg_id: 'amg-789', source_url: null,
      duration_ms: 300000, snoozed_until: null, snoozed_by: null, resolved_at: null, resolved_by: null,
      atom_updated_at: '2026-11-18T11:00:00.000Z', labels: '{"team":"toc"}', custom_details: null,
      playlist_id: '230001', playlist_date: '2026-11-18', playlist_start_time: null,
      earliest_scheduled: '2026-11-18T10:55:00.000Z', asset_id: 'ASSET-1', penalty: true,
    });
  });

  it('keeps non-TOC ATOM types raw and derives broadcast date from the feed timezone', () => {
    const { normalizeAlert } = atom._internal;
    const a = makeAlert(5, { type: 'tarang_media_seq_stall_alert', issue_start_time: '2026-11-18T00:10:00Z',
      custom: { playlist_date: undefined } });
    delete a.entity.custom.playlist_date;
    // 00:10Z = 05:40 IST, before the 06:00 broadcast start → previous broadcast day
    const n = normalizeAlert(a, () => ({ time_zone: 'Asia/Kolkata', broadcast_start_time: '06:00:00' }));
    assert.equal(n.issue_type, 'tarang_media_seq_stall_alert');
    assert.equal(n.raw_type, 'tarang_media_seq_stall_alert');
    assert.equal(n.playlist_date, '2026-11-17');
    assert.equal(n.region, 'APAC');
  });

  it('tracks snooze fields only while snoozed', () => {
    const { normalizeAlert } = atom._internal;
    const s = normalizeAlert(makeAlert(6, { state: 'snoozed', snoozed_until: '2026-11-18T13:00:00Z', snoozed_by: 'ops' }));
    assert.equal(s.snoozed_until, '2026-11-18T13:00:00Z');
    const a = normalizeAlert(makeAlert(6, { state: 'active', snoozed_until: '2026-11-18T13:00:00Z' }));
    assert.equal(a.snoozed_until, null);
  });

  it('derives one occurrence per alert without an extra request', async () => {
    const issues = await atom.getIssues();
    const n = fake.requests.length;
    const occs = await atom.getIssueDetails(issues[1]);
    assert.equal(fake.requests.length, n);
    assert.equal(occs.length, 1);
    assert.equal(occs[0].duration, '300s');
    assert.equal(occs[0].issue_type, 'MISSING_IN_CLOUD');
    assert.equal(JSON.parse(occs[0].raw_payload).alert_id, '1002');
  });

  it('reads the published playlist version and the full playlist', async () => {
    const vers = await atom.getPlaylistTimeline('AMG01579C1', '2026-11-18', 'APAC', 'customer-abc.amagi.tv');
    assert.deepEqual(vers.map(v => v.playlist_id), ['230001']);
    const pl = await atom.getPlaylist('customer-abc.amagi.tv', 'AMG01579C1', '2026-11-18');
    assert.equal(pl.playlist_id, '230001');
    assert.equal(pl.items.length, 3);
    assert.equal(fake.requests.at(-1).query.format, 'common');
  });

  it('getAlert returns null on 404 and the alert otherwise', async () => {
    assert.equal(await atom.getAlert('nope'), null);
    assert.equal((await atom.getAlert('1001', { history: true })).alert_id, '1001');
    assert.equal(fake.requests.at(-1).query.history, 'true');
  });

  it('write-back is a no-op (no PATCH sent) when ATOM_WRITEBACK is off', async () => {
    assert.equal(atom.isWritebackEnabled(), false);
    const r = await atom.snoozeAlert('1001', '2026-11-18T13:00:00Z');
    assert.deepEqual(r, { ok: true, skipped: true });
    assert.equal(fake.patches.length, 0);
  });

  it('maps a real-shaped ATOM staging alert (no_published_playlist, atom_syncer)', () => {
    const { normalizeAlert } = atom._internal;
    // Shape captured from am-staging (Nov 2026); customer identifiers anonymised
    const n = normalizeAlert({
      alert_id: '824066768', dedup_key: 'a809f5a28b0e08aa', correlation_id: 'c0ffee',
      name: 'no published playlist', type: 'no_published_playlist',
      description: 'playlists exist but none are published for feed FEED1 on 2026-11-22',
      severity: 'critical', timestamp: '2026-11-18T11:27:41.432Z',
      issue_start_time: '2026-11-22T11:00:00Z', duration: 86400000, source_id: 'atom_syncer', version: 'v1.0.2',
      custom_details: { feed_code: 'FEED1', playlist_date: '2026-11-22', playlist_url: 'https://customer.cloudport.amagi.tv/nexus/plec/#/FEED1/playlists/2026-11-22/' },
      labels: { feed_name: 'Feed One', feed_time_zone: 'COT' },
      entity: { id: '9fcde37c81af588d', name: 'Feed One', service: 'playlist', amgID: 'AMG00001', product: 'CP',
        custom: { automation_url: 'customer.cloudport.amagi.tv', account_domain: 'customer', feed_code: 'FEED1', playlist_date: '2026-11-22', asset_title: '' } },
      state: 'active', created_at: '2026-11-18T11:27:41Z', updated_at: '2026-11-18T11:27:41Z', transitions: [],
    });
    assert.equal(n.issue_type, 'NO_PLAYLIST');
    assert.equal(n.raw_type, 'no_published_playlist');
    assert.equal(n.feed_code, 'FEED1');
    assert.equal(n.feed_name, 'Feed One');
    assert.equal(n.host, '', 'entity.name is the feed name, not a host');
    assert.equal(n.amg_id, 'AMG00001');
    assert.equal(n.account, 'customer');
    assert.equal(n.automation_url, 'customer.cloudport.amagi.tv');
    assert.equal(n.playlist_date, '2026-11-22');
    assert.equal(n.playlist_id, '');
    assert.equal(n.severity, 'critical');
    assert.equal(n.duration_ms, 86400000);
    assert.match(n.source_url, /^https:\/\/customer\.cloudport/);
  });

  it('never renews or fetches a token by itself unless ATOM_ALLOW_TOKEN_RENEWAL=true', () => {
    // This file runs with ATOM_API_KEY; the mode check is what matters
    assert.equal(atom.authInfo().renewal, false);
  });

  it('falls back sensibly on sparse alerts', () => {
    const { normalizeAlert, alertToOccurrence, regionFromCloud } = atom._internal;
    const n = normalizeAlert({ alert_id: 7, type: 'hole_in_the_playlist', created_at: '2026-11-17T23:00:00Z',
      entity: { name: 'x', custom: {} }, infra: { region: 'us-east-1' }, custom_details: { asset_id: 'A1' } });
    assert.equal(n.id, '7');
    assert.equal(n.issue_type, 'HOLE');
    assert.equal(n.region, 'US');
    assert.equal(n.playlist_date, '2026-11-17');
    assert.equal(n.asset_id, 'A1');
    assert.equal(n.playlist_id, '');
    assert.equal(alertToOccurrence(n, { duration: -1, created_at: 'T' }).duration, 'ongoing');
    assert.equal(regionFromCloud('eu-west-1'), 'EMEA');
    assert.equal(regionFromCloud('weird'), null);
  });
});

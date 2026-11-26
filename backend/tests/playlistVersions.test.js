'use strict';

// Playlist versions derived from alerts, and the "same problem in another version" logic that
// prevents duplicate tickets when a playlist is republished.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, 'test_versions.db');
const clean = () => { for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); };
let db;

const alert = (id, pid, extra = {}) => ({
  atom_issue_id: id, playlist_id: pid, feed_code: 'FEED1', playlist_date: '2026-11-18', issue_type: 'MISSING_IN_CLOUD',
  raw_type: 'asset_missing_in_cloud', consolidated_status: 'active', earliest_scheduled: '2026-11-18T20:00:00Z',
  created_at: '2026-11-18T10:00:00Z', atom_sync: true, ...extra,
});

describe('playlist versions from alerts', () => {
  before(() => {
    clean();
    Object.assign(process.env, { DB_PATH: TEST_DB, NODE_ENV: 'test' });
    db = require('../db');
    // v1 (#500) and v2 (#502) both carry the same missing asset; #501 is a different asset
    const rows = [
      alert('A-v1', '500', { asset_id: 'ASSET-1', created_at: '2026-11-18T08:00:00Z' }),
      alert('A-v2', '502', { asset_id: 'ASSET-1', created_at: '2026-11-18T11:00:00Z' }),
      alert('B-v1', '501', { asset_id: 'ASSET-9', created_at: '2026-11-18T09:00:00Z' }),
      alert('H-v1', '500', { issue_type: 'HOLE', raw_type: 'hole_in_playlist', earliest_scheduled: '2026-11-18T21:00:00Z' }),
      alert('H-v2', '502', { issue_type: 'HOLE', raw_type: 'hole_in_playlist', earliest_scheduled: '2026-11-18T21:02:00Z' }),
      alert('H-far', '502', { issue_type: 'HOLE', raw_type: 'hole_in_playlist', earliest_scheduled: '2026-11-18T23:00:00Z' }),
      alert('Z', '0', { asset_id: 'ASSET-1' }),   // ATOM sometimes sends playlist id 0 → ignored
    ];
    for (const r of rows) db.upsertIssue(r);
    db.recordVersionsFromAlerts(rows.map(r => ({ ...r, id: r.atom_issue_id })));
  });
  after(clean);

  it('records each distinct playlist id per feed/day as a version, ordered numerically', () => {
    const tl = db.getPlaylistTimeline('FEED1', '2026-11-18');
    assert.deepEqual(tl.map(v => v.playlist_id), ['500', '501', '502']);
    assert.equal(tl[0].published_at, '2026-11-18T08:00:00Z', 'first time an alert carried that id');
  });

  it('matches the same asset across versions and labels previous/later', () => {
    const m = db.findAcrossVersions(db.getIssueByCompositeKey('A-v2', '502').issue);
    assert.deepEqual(m.map(x => [x.atom_issue_id, x.relation]), [['A-v1', 'previous']]);
    const back = db.findAcrossVersions(db.getIssueByCompositeKey('A-v1', '500').issue);
    assert.deepEqual(back.map(x => [x.atom_issue_id, x.relation]), [['A-v2', 'later']]);
  });

  it('matches holes by start time (±5 min), not other holes on the same feed', () => {
    const m = db.findAcrossVersions(db.getIssueByCompositeKey('H-v2', '502').issue);
    assert.deepEqual(m.map(x => x.atom_issue_id), ['H-v1']);
  });

  it('a ticket on the previous version flags the same problem in the later one', () => {
    db.storeFreshdeskTicket({ atom_issue_id: 'A-v1', playlist_id: '500', feed_code: 'FEED1', issue_type: 'MISSING_IN_CLOUD',
      asset_id: 'ASSET-1', freshdesk_id: 77, ticket_number: 'INC-77', ticket_url: 'https://fd/77', ticket_type: 'customer' });
    const v2 = db.getIssueByCompositeKey('A-v2', '502').issue;
    assert.equal(v2.has_previous_ticket_same_day, 1);
    assert.equal(v2.previous_ticket_id, 'INC-77');
    assert.equal(v2.previous_playlist_id, '500');
    assert.equal(db.getIssueByCompositeKey('B-v1', '501').issue.has_previous_ticket_same_day, 0, 'different asset untouched');
  });

  it('a version that arrives after the ticket is flagged on sync', () => {
    const late = alert('A-v3', '503', { asset_id: 'ASSET-1' });
    db.upsertIssue(late);
    db.checkAndMarkPersistence('A-v3', '503');
    assert.equal(db.getIssueByCompositeKey('A-v3', '503').issue.previous_ticket_id, 'INC-77');
    const d = db.getIssueByCompositeKey('A-v3', '503');
    assert.equal(d.previousTicketDetail.ticket_number, 'INC-77');
    assert.ok(d.versions.some(v => v.atom_issue_id === 'A-v1' && v.ticket_id === 'INC-77'));
  });
});

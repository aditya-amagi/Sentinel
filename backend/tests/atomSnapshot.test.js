'use strict';

// Mock mode replaying a captured production snapshot (fixture, not real data).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const SNAP = path.join(__dirname, 'test_snapshot.json');
const CAPTURED = Date.parse('2026-11-18T14:44:10Z');
const alert = (id, start, date) => ({
  alert_id: id, type: 'hole_in_playlist', name: 'hole in playlist', severity: 'major', state: 'active',
  issue_start_time: start, created_at: start, duration: 60000,
  custom_details: { feed_code: 'F1', playlist_date: date, playlist_url: `https://x.cloudport.amagi.tv/nexus/#/F1/playlists/${date}/` },
  labels: { feed_name: 'Feed One' },
  entity: { name: 'Feed One', service: 'playlist', amgID: 'AMG1', product: 'CP', custom: { feed_code: 'F1', automation_url: 'x.cloudport.amagi.tv', playlist_date: date } },
});

describe('mock mode: production snapshot replay', () => {
  let MOCK;
  before(() => {
    fs.writeFileSync(SNAP, JSON.stringify({
      captured_at: new Date(CAPTURED).toISOString(),
      views: [{ id: 1, name: 'All CP Alerts', selected: false }, { id: 16, name: 'EMEA Schedule Alerts', selected: true }],
      alerts: [alert('A1', '2026-11-18T20:00:00Z', '2026-11-18')],
      membership: { A1: [1, 16] },
      customers: { 'x.cloudport.amagi.tv': { name: 'X', url: 'x.cloudport.amagi.tv', accounts: [] } },
    }));
    process.env.ATOM_MOCK_SNAPSHOT = SNAP;
    MOCK = require('../atomMock');
  });
  after(() => { fs.unlinkSync(SNAP); });

  it('replays the snapshot unchanged on the capture day', () => {
    const { alerts, membership } = MOCK.generate(CAPTURED + 3600e3);
    assert.equal(alerts[0].issue_start_time, '2026-11-18T20:00:00Z');
    assert.deepEqual(membership.get('A1'), [1, 16]);
    assert.deepEqual(MOCK.views().map(v => v.name), ['All CP Alerts', 'EMEA Schedule Alerts']);
    assert.equal(MOCK.customer('x.cloudport.amagi.tv').name, 'X');
    assert.equal(MOCK.isReplay(), true);
  });

  it('moves times, broadcast dates and links forward in whole days', () => {
    const { alerts } = MOCK.generate(CAPTURED + 2 * 864e5 + 3600e3);
    const a = alerts[0];
    assert.equal(a.issue_start_time, '2026-11-20T20:00:00Z');
    assert.equal(a.custom_details.playlist_date, '2026-11-20');
    assert.equal(a.entity.custom.playlist_date, '2026-11-20');
    assert.match(a.custom_details.playlist_url, /playlists\/2026-11-20\//);
  });
});

'use strict';

// Customer-facing ticket and follow-up wording (pure functions, no DB).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const TT = require('../ticketText');

const NOW = Date.parse('2026-11-17T07:00:00Z');
const feed = { feed_name: 'CazeTV 3', time_zone: 'Asia/Kolkata', customer_name: 'livemode', automation_url: 'livemode.cloudport.amagi.tv' };
const hole = (id, start, ms) => ({
  atom_issue_id: id, playlist_id: '51478', feed_code: 'CAZE3', issue_type: 'HOLE', severity: 'major',
  playlist_date: '2026-11-16', earliest_scheduled: start, duration_ms: ms, consolidated_status: 'active',
  automation_url: 'livemode.cloudport.amagi.tv', source_url: 'https://livemode.cloudport.amagi.tv/nexus/#/CAZE3/playlists/2026-11-16/',
});

describe('ticketText', () => {
  it('formats durations and times like operators expect', () => {
    const { hms, fmtUtc, fmtZone } = TT._internal;
    assert.equal(hms(809000), '00:13:29');
    assert.equal(hms(-1), 'Ongoing');
    assert.equal(fmtUtc('2026-11-17T08:46:30Z'), '2026-11-17 08:46:30 UTC');
    assert.match(fmtZone('2026-11-17T08:46:30Z', 'Asia/Kolkata'), /^2026-11-17 14:16:30 /);
  });

  it('a hole ticket says what, impact, when (UTC + local + time left), what to do, and links', () => {
    const t = TT.buildTicket({ issue: hole('A1', '2026-11-17T08:46:30Z', 809000), feed, contacts: { customer_name: 'livemode' }, now: NOW });
    for (const s of ['Dear livemode Team,', 'CazeTV 3 (CAZE3)', 'rescue content will go on-air', 'Airs at 2026-11-17 08:46:30 UTC',
      '1 h 47 min from now', 'What we need from you', 'Fill the gap', 'Republish the playlist', '00:13:29',
      'href="https://livemode.cloudport.amagi.tv/"', 'Open in CloudPort', 'Amagi TOC Team'])
      assert.ok(t.html.includes(s), `missing: ${s}`);
    assert.equal(t.priority, 4, 'airs within 2 hours → Urgent');
    assert.equal(t.subject, 'TOC Alert [AM3] : Schedule Gap Detected - CazeTV 3 (CAZE3) - 2026-11-16');
  });

  it('several holes → one ticket with every timing and the total duration', () => {
    const t = TT.buildTicket({ issue: hole('A1', '2026-11-17T08:46:30Z', 809000), related: [hole('A2', '2026-11-17T12:00:00Z', 60000)], feed, now: NOW });
    assert.ok(t.html.includes('covers <b>2</b> affected items'));
    assert.ok(t.html.includes('Total hole duration (hh:mm:ss)'));
    assert.ok(t.html.includes('00:14:29'));
    assert.equal(t.items.length, 2);
  });

  it('escapes HTML from ATOM fields', () => {
    const t = TT.buildTicket({ issue: { ...hole('A1', '2026-11-17T08:46:30Z', 1000), description: '<script>x</script>' }, feed, now: NOW });
    assert.ok(!t.html.includes('<script>'));
  });

  it('suggests the follow-up that fits the live state', () => {
    assert.equal(TT.suggestFollowup(hole('A', '2026-11-17T08:00:00Z', 600000), [], NOW), 'urgent');      // within 2h
    assert.equal(TT.suggestFollowup(hole('A', '2026-11-18T08:00:00Z', 600000), [], NOW), 'reminder');    // later
    assert.equal(TT.suggestFollowup(hole('A', '2026-11-16T08:00:00Z', 600000), [], NOW), 'aired');       // passed, still open
    assert.equal(TT.suggestFollowup({ ...hole('A', '2026-11-16T08:00:00Z', 1), consolidated_status: 'resolved' }, [], NOW), 'resolved');
  });

  it('follow-up text names the ticket, numbers itself and includes the operator note', () => {
    const { html } = TT.buildFollowup({ issue: hole('A1', '2026-11-17T08:46:30Z', 809000), feed, contacts: {},
      ticket: { ticket_number: 'INC-123', created_at: '2026-11-17 05:00:00' }, template: 'urgent', note: 'Call us <now>', number: 2, now: NOW });
    for (const s of ['INC-123', 'Urgent:', 'rescue content will air', 'Follow-up #2', 'Call us &lt;now&gt;', 'Status in our monitoring'])
      assert.ok(html.includes(s), `missing: ${s}`);
  });
});

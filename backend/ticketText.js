// ticketText.js — customer-facing wording for Freshdesk tickets and follow-ups.
//
// Every ticket tells the customer, in order: what is wrong, what happens on air if nothing is
// done, when it airs (UTC + channel-local time, time remaining), exactly what to do, and where
// to click. Customer tickets carry no internal jargon; internal tickets add a technical section.
// Follow-ups are templated from the alert's live state (still open, airing soon, aired, resolved).
//
// Pure module: callers pass the issue, related alerts, feed catalog row and contacts.

'use strict';

const AT = require('./alertTypes');

// ── Formatting helpers ──────────────────────────────────────────────────────

const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ms  = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const pad = n => String(n).padStart(2, '0');

function validTz(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** "2026-11-17 08:46:30 UTC" */
function fmtUtc(iso) {
  const t = ms(iso);
  if (t == null) return null;
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$|Z$/, '') + ' UTC';
}

/** "2026-11-17 14:16:30 IST" (zone abbreviation when the platform has one, else GMT offset + zone name) */
function fmtZone(iso, tz) {
  const t = ms(iso);
  if (t == null || !validTz(tz)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const zone = /^GMT|^UTC/.test(parts.timeZoneName || '') ? `${parts.timeZoneName} (${tz})` : parts.timeZoneName;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${zone}`;
}

/** Duration in ms → "00:13:29"; -1 → "Ongoing" */
function hms(durationMs) {
  const n = Number(durationMs);
  if (durationMs == null || durationMs === '' || !Number.isFinite(n)) return null;
  if (n < 0) return 'Ongoing';
  const s = Math.round(n / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 8100000 → "2 h 15 min" */
function span(msAbs) {
  const m = Math.round(Math.abs(msAbs) / 60000);
  if (m < 1) return 'less than a minute';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d} d`, h && `${h} h`, mm && `${mm} min`].filter(Boolean).join(' ');
}

const startOf = i => i.earliest_scheduled || i.playlist_start_time || null;
const endOf = i => {
  const s = ms(startOf(i)), d = Number(i.duration_ms);
  if (s == null || !Number.isFinite(d) || d < 0) return null;
  return s + d;
};

/** Where an alert sits relative to now: upcoming | on_air | aired | unknown */
function airPhase(i, now = Date.now()) {
  const s = ms(startOf(i));
  if (s == null) return 'unknown';
  if (s > now) return 'upcoming';
  const e = endOf(i);
  if (e == null) return Number(i.duration_ms) < 0 ? 'on_air' : 'aired';
  return e > now ? 'on_air' : 'aired';
}

// ── Per-type wording ────────────────────────────────────────────────────────

const COPY = {
  HOLE: {
    what:    c => `There is an unfilled gap (hole) in the published playlist for <b>${c.channel}</b>.`,
    impact:  'If the gap is not filled, <b>rescue content will go on-air</b> for its full duration.',
    actions: [
      'Fill the gap with programme, promo or filler content.',
      'Republish the playlist in CloudPort.',
    ],
    timeLabel: 'Hole timing',
  },
  NO_PLAYLIST: {
    what:    c => `No playlist is published for <b>${c.channel}</b> for the broadcast day <b>${c.date}</b>.`,
    impact:  'If no playlist is published before the broadcast day starts, <b>the channel will air rescue content</b>.',
    actions: [
      c => `Publish the playlist for ${c.date} in CloudPort. If a draft already exists, it only needs to be published.`,
    ],
    timeLabel: 'Broadcast day starts',
  },
  DURATION_MISMATCH: {
    what:    c => `An event in the playlist for <b>${c.channel}</b> is scheduled for a different duration than its media actually runs.`,
    impact:  'The programme may be cut short or leave a gap, and <b>rescue content may air</b> in the gap.',
    actions: [
      'Correct the event duration in the playlist, or replace the media with the correct version.',
      'Republish the playlist in CloudPort.',
    ],
    timeLabel: 'Event time',
  },
  MISSING_IN_CLOUD: {
    what:    c => `Media scheduled in the playlist for <b>${c.channel}</b> is not available in cloud storage.`,
    impact:  'If the media is still missing at air time, <b>rescue content will play in its place</b>.',
    actions: [
      'Deliver the media for the asset(s) listed below, or replace those events with available content.',
      'If you change the playlist, republish it in CloudPort.',
    ],
    timeLabel: 'Scheduled at',
  },
};

function copyFor(issue) {
  const key = AT.isValid(issue.issue_type) ? issue.issue_type : null;
  if (key) return COPY[key];
  const name = issue.alert_name || AT.label(issue.issue_type);
  return {
    what:    c => `Our monitoring raised <b>${esc(name)}</b> on <b>${c.channel}</b>.`,
    impact:  issue.description ? esc(issue.description) : 'This may affect what goes on-air.',
    actions: ['Please review the details below and take corrective action.'],
    timeLabel: 'Detected at',
  };
}

// ── Building blocks (inline styles only — email clients drop <style>) ──────

const S = {
  p:     'margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;',
  h:     'margin:18px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#222;',
  table: 'border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;margin:0 0 14px;',
  th:    'background:#f1f3f6;border:1px solid #c9ced6;padding:7px 10px;text-align:left;font-weight:bold;vertical-align:top;white-space:nowrap;',
  td:    'border:1px solid #c9ced6;padding:7px 10px;vertical-align:top;',
  urgent:'margin:0 0 14px;padding:10px 12px;border-left:4px solid #d9534f;background:#fdf1f0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;',
  note:  'margin:0 0 14px;padding:10px 12px;border-left:4px solid #e8a33d;background:#fdf7ec;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;',
  ok:    'margin:0 0 14px;padding:10px 12px;border-left:4px solid #5b9b4a;background:#f1f8ee;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;',
  small: 'margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#777;',
};

const link = (url, text) => /^https?:\/\//i.test(url || '') ? `<a href="${esc(url)}">${esc(text || url)}</a>` : esc(text || url || '');

/** Two-column field table; rows with empty values are dropped. Values are trusted HTML. */
function fieldTable(rows) {
  const r = rows.filter(([, v]) => v != null && v !== '');
  if (!r.length) return '';
  return `<table border="1" cellpadding="0" cellspacing="0" style="${S.table}">`
    + r.map(([k, v]) => `<tr><th style="${S.th}">${esc(k)}</th><td style="${S.td}">${v}</td></tr>`).join('')
    + '</table>';
}

function gridTable(head, rows) {
  return `<table border="1" cellpadding="0" cellspacing="0" style="${S.table}"><tr>`
    + head.map(h => `<th style="${S.th}">${esc(h)}</th>`).join('') + '</tr>'
    + rows.map(r => '<tr>' + r.map(c => `<td style="${S.td}">${c ?? ''}</td>`).join('') + '</tr>').join('')
    + '</table>';
}

const lines = arr => arr.filter(Boolean).map(esc).join('<br/>');

/** Channel context shared by tickets and follow-ups. */
function context(issue, feed, contacts) {
  const name = feed?.feed_name || issue.feed_name || null;
  const code = issue.feed_code || '';
  return {
    channel: esc(name && name !== code ? `${name} (${code})` : code || 'the channel'),
    channelPlain: name && name !== code ? `${name} (${code})` : code,
    date: esc(issue.playlist_date || ''),
    tz: feed?.time_zone || null,
    customer: contacts?.customer_name || feed?.customer_name || null,
  };
}

/** "Airs at …, 2 h 15 min from now" / "On-air now" / "Aired …" */
function timingSentence(items, tz, now) {
  const first = items.map(startOf).filter(Boolean).sort()[0];
  if (!first) return null;
  const phase = airPhase(items.find(i => startOf(i) === first) || items[0], now);
  const when = [fmtUtc(first), fmtZone(first, tz)].filter(Boolean).join(' / ');
  const delta = ms(first) - now;
  if (phase === 'upcoming') return { phase, html: `<b>Airs at ${esc(when)}</b>, ${esc(span(delta))} from now.` };
  if (phase === 'on_air')   return { phase, html: `<b>This is affecting air right now</b> (started ${esc(when)}).` };
  return { phase, html: `The affected time was ${esc(when)}.` };
}

// ── Ticket ──────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {object} p.issue        the alert the operator opened
 * @param {object[]} [p.related]  other open alerts of the same type, feed and broadcast date
 * @param {object} [p.feed]       atom_feeds row
 * @param {object} p.contacts     resolveContacts() result
 * @param {'customer'|'internal'} p.ticketType
 * @returns {{subject, html, priority, items}}
 */
function buildTicket({ issue, related = [], feed = null, contacts = {}, ticketType = 'customer', now = Date.now() }) {
  const items = [issue, ...related].sort((a, b) => String(startOf(a) || '').localeCompare(String(startOf(b) || '')));
  const c = context(issue, feed, contacts);
  const copy = copyFor(issue);
  const timing = timingSentence(items, c.tz, now);
  const multi = items.length > 1;

  const greet = ticketType === 'internal'
    ? 'Hi team,'
    : (c.customer ? `Dear ${esc(c.customer)} Team,` : 'Dear Customer,');

  const actions = copy.actions.map(a => (typeof a === 'function' ? a(c) : a));
  actions.push('Reply to this ticket once it is done, so we can confirm the alert has cleared.');

  const totalMs = items.reduce((n, i) => n + (Number(i.duration_ms) > 0 ? Number(i.duration_ms) : 0), 0);
  const playlistIds = [...new Set(items.map(i => i.playlist_id).filter(Boolean))];
  const assets = [...new Set(items.map(i => i.asset_id).filter(Boolean))];
  const sourceUrl = items.map(i => i.source_url).find(u => /^https:\/\//i.test(u || ''));
  const automation = issue.automation_url || feed?.automation_url;

  // Summary
  const summary = fieldTable([
    ['Channel', c.channel],
    ['Customer', c.customer && esc(c.customer)],
    ['Broadcast date', c.date],
    [playlistIds.length > 1 ? 'Playlist IDs' : 'Playlist ID', lines(playlistIds)],
    ...(multi ? [] : [
      [copy.timeLabel, lines([fmtUtc(startOf(issue)), fmtZone(startOf(issue), c.tz)])],
      ['Duration (hh:mm:ss)', esc(hms(issue.duration_ms))],
      [assets.length ? 'Asset ID' : null, lines(assets)],
    ]),
    ...(multi && issue.issue_type === 'HOLE' && totalMs ? [['Total hole duration (hh:mm:ss)', esc(hms(totalMs))]] : []),
    ['Automation URL', automation && link(`https://${String(automation).replace(/^https?:\/\//, '').replace(/\/$/, '')}/`)],
    ['Playlist', sourceUrl && link(sourceUrl, 'Open in CloudPort')],
    ['Details', !AT.isValid(issue.issue_type) ? null : (issue.description && esc(issue.description))],
  ].filter(([k]) => k));

  // Affected items (when the ticket covers several alerts)
  const affected = multi ? gridTable(
    ['#', `${copy.timeLabel} (UTC)`, c.tz ? 'Channel local time' : null, 'Duration', assets.length ? 'Asset' : null].filter(Boolean),
    items.map((i, n) => [
      String(n + 1),
      esc(fmtUtc(startOf(i)) || '—'),
      ...(c.tz ? [esc(fmtZone(startOf(i), c.tz) || '—')] : []),
      esc(hms(i.duration_ms) || '—'),
      ...(assets.length ? [esc(i.asset_id || '—')] : []),
    ]),
  ) : '';

  const technical = ticketType === 'internal' ? `<p style="${S.h}">Technical details</p>` + fieldTable([
    ['Severity', esc(issue.severity && issue.severity.charAt(0).toUpperCase() + issue.severity.slice(1))],
    ['ATOM alert', esc(issue.alert_name)],
    ['ATOM type', esc(issue.raw_type || issue.issue_type)],
    ['ATOM alert ID(s)', lines(items.map(i => i.atom_issue_id))],
    ['ATOM state', esc(issue.consolidated_status)],
    ['AMG ID', esc(issue.amg_id || feed?.amg_id)],
    ['Headend', esc(issue.headend_code)],
    ['Product / service', esc([issue.product, issue.entity_service].filter(Boolean).join(' / '))],
    ['Dedup key', esc(issue.dedup_key)],
  ]) : '';

  const html = [
    `<p style="${S.p}">${greet}</p>`,
    ticketType === 'internal'
      ? `<p style="${S.p}">Raising this internally for investigation. ${copy.what(c)} ${copy.impact}</p>`
      : `<p style="${S.p}">We are raising this ticket on your behalf. ${copy.what(c)} ${copy.impact}</p>`,
    timing ? `<p style="${timing.phase === 'aired' ? S.note : S.urgent}">${timing.html}${multi ? ` This ticket covers <b>${items.length}</b> affected ${items.length === 1 ? 'item' : 'items'}, listed below.` : ''}</p>` : '',
    `<p style="${S.h}">What we need from you</p>`,
    `<ol style="${S.p}">${actions.map(a => `<li>${esc(a)}</li>`).join('')}</ol>`,
    `<p style="${S.h}">Details</p>`,
    summary,
    affected,
    technical,
    `<p style="${S.p}">We keep monitoring this channel. As soon as the fix is published our alert clears automatically and we will confirm it on this ticket.</p>`,
    `<p style="${S.p}">Regards,<br/>Amagi TOC Team<br/><span style="color:#777;">24×7 Broadcast Operations</span></p>`,
    `<p style="${S.small}">Reference: ${esc(items.map(i => i.atom_issue_id).join(', '))} · raised via Sentinel</p>`,
  ].join('\n');

  // Priority: severity, raised to Urgent when it is on-air now or airs within 2 hours
  const sevPriority = { blocker: 4, critical: 4, major: 3, minor: 2, dev: 1 }[issue.severity] || 2;
  const soon = timing && (timing.phase === 'on_air' || (timing.phase === 'upcoming' && ms(items.map(startOf).filter(Boolean).sort()[0]) - now <= 2 * 3600e3));
  const priority = soon ? 4 : sevPriority;
  const sevName = issue.severity ? issue.severity.charAt(0).toUpperCase() + issue.severity.slice(1) : null;
  const priorityReason = soon
    ? (timing.phase === 'on_air' ? 'affecting air now' : 'airs within 2 hours')
    : (sevName ? `${sevName} severity` : 'default');

  const key = AT.isValid(issue.issue_type) ? issue.issue_type : (AT.toEnumKey(issue.issue_type) || issue.issue_type);
  const subject = AT.buildSubject(key, c.channelPlain || issue.feed_code, issue.playlist_date);

  return { subject, html, priority, priorityReason, items };
}

// ── Follow-ups ──────────────────────────────────────────────────────────────

const FOLLOWUP_TEMPLATES = [
  { key: 'reminder', label: 'Reminder',            desc: 'No reply yet, and the issue is still open' },
  { key: 'urgent',   label: 'Airing soon',         desc: 'Still open and on-air now or within 2 hours' },
  { key: 'aired',    label: 'Aired with the issue', desc: 'The affected time has passed while it was still open' },
  { key: 'resolved', label: 'Resolved',            desc: 'Our monitoring shows it has cleared; propose closing' },
  { key: 'custom',   label: 'Custom message',      desc: 'Only your own text, plus the current status' },
];

/** Pick the template that fits the alert's live state. */
function suggestFollowup(issue, related = [], now = Date.now()) {
  const items = [issue, ...related];
  if (items.every(i => i.consolidated_status === 'resolved')) return 'resolved';
  const open = items.filter(i => i.consolidated_status !== 'resolved');
  const phases = open.map(i => airPhase(i, now));
  const nextStart = open.map(startOf).filter(s => ms(s) > now).sort()[0];
  if (phases.includes('on_air') || (nextStart && ms(nextStart) - now <= 2 * 3600e3)) return 'urgent';
  if (phases.length && phases.every(p => p === 'aired')) return 'aired';
  return 'reminder';
}

/**
 * @param {object} p
 * @param {object} p.issue, p.related, p.feed, p.contacts
 * @param {object} p.ticket       parent ticket row ({ticket_number, created_at})
 * @param {string} p.template     one of FOLLOWUP_TEMPLATES keys
 * @param {string} [p.note]       operator's own text (required for 'custom')
 * @param {number} p.number       this follow-up's number (1, 2, …)
 */
function buildFollowup({ issue, related = [], feed = null, contacts = {}, ticket = {}, template, note = '', number = 1, now = Date.now() }) {
  const items = [issue, ...related];
  const c = context(issue, feed, contacts);
  const label = esc(AT.label(AT.isValid(issue.issue_type) ? issue.issue_type : issue.issue_type));
  const ref = esc(ticket.ticket_number || (ticket.freshdesk_id ? `#${ticket.freshdesk_id}` : 'this ticket'));
  const raised = ms(ticket.created_at && `${String(ticket.created_at).replace(' ', 'T')}${/Z$|[+-]\d\d:?\d\d$/.test(ticket.created_at) ? '' : 'Z'}`);
  const since = raised != null ? ` ${esc(span(now - raised))} ago` : '';
  const timing = timingSentence(items.filter(i => i.consolidated_status !== 'resolved').length ? items.filter(i => i.consolidated_status !== 'resolved') : items, c.tz, now);
  const greet = c.customer ? `Dear ${esc(c.customer)} Team,` : 'Dear Customer,';
  const resolvedAt = items.map(i => i.resolved_at).filter(Boolean).sort().at(-1);

  const status = fieldTable([
    ['Channel', c.channel],
    ['Broadcast date', c.date],
    ['Status in our monitoring', esc(items.every(i => i.consolidated_status === 'resolved') ? 'Resolved'
      : items.some(i => i.consolidated_status === 'snoozed') && !items.some(i => i.consolidated_status === 'active') ? 'Open (acknowledged)' : 'Open')],
    ['Next affected time', timing && timing.phase !== 'aired' ? lines([fmtUtc(items.map(startOf).filter(Boolean).sort()[0]), fmtZone(items.map(startOf).filter(Boolean).sort()[0], c.tz)]) : null],
    ['Cleared at', resolvedAt && lines([fmtUtc(resolvedAt), fmtZone(resolvedAt, c.tz)])],
    ['Playlist', items.map(i => i.source_url).find(u => /^https:\/\//i.test(u || '')) && link(items.map(i => i.source_url).find(u => /^https:\/\//i.test(u || '')), 'Open in CloudPort')],
  ]);

  const body = {
    reminder: [
      `Following up on ${ref}, raised${since}, about <b>${label}</b> on <b>${c.channel}</b>. Our monitoring still shows the issue as <b>open</b>.`,
      timing && `<p style="${timing.phase === 'aired' ? S.note : S.urgent}">${timing.html}</p>`,
      'Could you share an update, or an expected time for the fix?',
    ],
    urgent: [
      `<b>Urgent:</b> <b>${label}</b> on <b>${c.channel}</b> (${ref}) is still not fixed.`,
      timing && `<p style="${S.urgent}">${timing.html} Unless it is fixed before then, <b>rescue content will air</b>.</p>`,
      'Please action this now and reply here as soon as it is done.',
    ],
    aired: [
      `Following up on ${ref}: the affected time for <b>${label}</b> on <b>${c.channel}</b> has passed, and the issue was still open when it aired.`,
      timing && `<p style="${S.note}">${timing.html}</p>`,
      'Please let us know the cause, and whether anything is needed to prevent it on future playlists.',
    ],
    resolved: [
      `Good news on ${ref}: our monitoring shows <b>${label}</b> on <b>${c.channel}</b> has cleared.`,
      `<p style="${S.ok}">No further action is needed from you. Unless you tell us otherwise, we will close this ticket.</p>`,
      'Thank you for the quick fix.',
    ],
    custom: [],
  }[template] || [];

  const html = [
    `<p style="${S.p}">${greet}</p>`,
    ...body.filter(Boolean).map(b => (b.startsWith('<p') ? b : `<p style="${S.p}">${b}</p>`)),
    note ? `<p style="${S.p}">${esc(note).replace(/\n/g, '<br/>')}</p>` : '',
    status,
    `<p style="${S.p}">Regards,<br/>Amagi TOC Team<br/><span style="color:#777;">24×7 Broadcast Operations</span></p>`,
    `<p style="${S.small}">Follow-up #${Number(number) || 1} · Reference: ${esc(items.map(i => i.atom_issue_id).join(', '))}</p>`,
  ].filter(Boolean).join('\n');

  return { html };
}

module.exports = {
  buildTicket, buildFollowup, suggestFollowup, FOLLOWUP_TEMPLATES,
  // helpers (tests)
  _internal: { fmtUtc, fmtZone, hms, span, airPhase },
};

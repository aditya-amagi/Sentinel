// Shared alert metadata + formatters (mirrors backend/alertTypes.js). Single import for the UI.

export const TOC_TYPES = ['HOLE', 'NO_PLAYLIST', 'DURATION_MISMATCH', 'MISSING_IN_CLOUD'];

const TOC_LABELS = {
  HOLE:              'Hole in Playlist',
  NO_PLAYLIST:       'No Playlist',
  DURATION_MISMATCH: 'Asset Duration Mismatch',
  MISSING_IN_CLOUD:  'Missing in Cloud',
};

export const isToc = t => TOC_TYPES.includes(t);

export function humanize(raw) {
  if (!raw) return '';
  return String(raw).replace(/[_\-\s]+alert$/i, '').split(/[_\-\s]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export function alertLabel(type) {
  return TOC_LABELS[type] || humanize(type) || '—';
}

export const SEVERITIES = ['blocker', 'critical', 'major', 'minor', 'dev'];
export const SEVERITY_LABEL = { blocker: 'Blocker', critical: 'Critical', major: 'Major', minor: 'Minor', dev: 'Dev' };
export const severityRank = s => { const i = SEVERITIES.indexOf(s); return i < 0 ? SEVERITIES.length : i; };

export const TRIAGE = {
  penalty:  { label: 'Penalty',  desc: 'Needs attention' },
  ack:      { label: 'Ack',      desc: 'Seen, no ticket' },
  ticketed: { label: 'Ticketed', desc: 'Freshdesk ticket filed' },
};
export const triageOf = issue => {
  const s = issue?.state || 'penalty';
  return s === 'not_ticketed' ? 'ack' : (TRIAGE[s] ? s : 'penalty');
};

// ── Formatters ──────────────────────────────────────────────────────────────

const valid = ts => ts && Number.isFinite(new Date(ts).getTime());

export const fmtShort = ts => valid(ts)
  ? new Date(ts).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  : '—';
export const fmtLong = ts => valid(ts)
  ? new Date(ts).toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  : '—';
export const fmtClock = ts => valid(ts) ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

export function fmtInZone(ts, tz) {
  if (!valid(ts) || !tz) return null;
  try {
    return new Date(ts).toLocaleString('en-GB', { timeZone: tz, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return null; }
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 'Ongoing';
  const s = Math.round(n / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h && `${h}h`, m && `${m}m`, (r || (!h && !m)) && `${r}s`].filter(Boolean).join(' ');
}

export function relTime(ts) {
  if (!valid(ts)) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const future = diff < 0, a = Math.abs(diff), m = Math.floor(a / 60000);
  const t = m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
  return t === 'now' ? 'just now' : future ? `in ${t}` : `${t} ago`;
}

export const issueKey = i => `${i.atom_issue_id}::${i.playlist_id}`;

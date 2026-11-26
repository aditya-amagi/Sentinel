// Small fetch wrapper: JSON in/out, cookies, SRE terminal traffic logging, readable errors.
import { SREBus } from '../components/SRETerminal';

export async function api(path, { method = 'GET', body, log = true } = {}) {
  const t0 = performance.now();
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ms = Math.round(performance.now() - t0);
  if (log) SREBus.logTraffic({ method, url: path.split('?')[0], status: res.status, ms });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Alerts without a playlist (No Playlist, live/ingest faults) have playlist_id '' — an empty URL
// segment would not match the route, so it travels as "-" (server.js maps it back).
export const playlistSeg = id => (id === null || id === undefined || id === '' ? '-' : encodeURIComponent(id));

export const issuePath = (issue, suffix = '') =>
  `/api/issues/${encodeURIComponent(issue.atom_issue_id)}/playlist/${playlistSeg(issue.playlist_id)}${suffix}`;

/** Change triage state; optional snooze_until mirrors an Ack into ATOM as a snooze. */
export async function setTriageState(issue, state, snooze_until) {
  const body = { state };
  if (snooze_until) body.snooze_until = snooze_until;
  const data = await api(issuePath(issue, '/state'), { method: 'PATCH', body });
  SREBus.logState({ feed: issue.feed_code, from: issue.state || 'penalty', to: state });
  return data; // { issue, occurrences, ..., atom: {ok, skipped?, error?} }
}

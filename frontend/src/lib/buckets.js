// ATOM buckets: ATOM groups repeated alerts for the same problem (same feed, type, playlist —
// e.g. one asset missing at 31 timings) under one correlation_id. Sentinel shows each bucket as one
// expandable row; triage, ack and tickets stay per alert (a ticket covers the whole bucket).

import { severityRank, triageOf } from './alerts';

export const bucketKey = i => (i.correlation_id ? `c:${i.correlation_id}` : `a:${i.atom_issue_id}:${i.playlist_id}`);
export const rowKey = i => `${i.atom_issue_id}-${i.playlist_id}`;

/**
 * Group already-sorted rows into buckets, keeping order: a bucket sits where its first (highest
 * priority) alert would. → [{key, items, lead, size}]
 */
export function toBuckets(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = bucketKey(r);
    if (!map.has(k)) map.set(k, { key: k, items: [] });
    map.get(k).items.push(r);
  }
  return [...map.values()].map(b => ({ ...b, lead: b.items[0], size: b.items.length }));
}

/** Header facts for a multi-alert bucket. */
export function bucketSummary(items) {
  const triage = { penalty: 0, ack: 0, ticketed: 0 };
  let severity = null, first = null, last = null;
  const assets = new Set(), tickets = new Map();
  for (const i of items) {
    triage[triageOf(i)]++;
    if (!severity || severityRank(i.severity) < severityRank(severity)) severity = i.severity;
    const t = Date.parse(i.earliest_scheduled || i.playlist_start_time);
    if (Number.isFinite(t)) { if (first == null || t < first) first = t; if (last == null || t > last) last = t; }
    if (i.asset_id) assets.add(i.asset_id);
    if (i.ticket_link?.trim()) tickets.set(i.ticket_id || i.ticket_link, i.ticket_link);
  }
  const worst = triage.penalty ? 'penalty' : triage.ack ? 'ack' : 'ticketed';
  return {
    triage, worst, severity,
    first: first != null ? new Date(first).toISOString() : null,
    last:  last  != null ? new Date(last).toISOString()  : null,
    assets: [...assets],
    tickets: [...tickets.entries()].map(([id, link]) => ({ id, link })),
  };
}

import React, { useMemo, useState } from 'react';
import AckButton from './AckButton';
import { SeverityPill, AtomStatePill, TypeLabel } from './Pills';
import { TRIAGE, triageOf, fmtShort, relTime } from '../lib/alerts';
import { rowKey } from '../lib/buckets';
import './AlertGroups.css';

const COLUMNS = ['penalty', 'ack', 'ticketed'];

/**
 * Board view: one column per triage state. Buckets arrive already sorted by the dashboard; within a
 * column, the alerts of one ATOM bucket share a card that expands to list them.
 */
export default function AlertGroups({ buckets, selectedKey, onSelect, onStateChange }) {
  const [open, setOpen] = useState(() => new Set());
  const grouped = useMemo(() => {
    const m = { penalty: [], ack: [], ticketed: [] };
    for (const b of buckets) {
      const byCol = { penalty: [], ack: [], ticketed: [] };
      for (const i of b.items) byCol[triageOf(i)].push(i);
      for (const col of COLUMNS) if (byCol[col].length) m[col].push({ key: `${b.key}|${col}`, items: byCol[col] });
    }
    return m;
  }, [buckets]);
  const count = col => grouped[col].reduce((n, g) => n + g.items.length, 0);
  const isSel = i => selectedKey && i.atom_issue_id === selectedKey.atomIssueId && i.playlist_id === selectedKey.playlistId;

  return (
    <div className="board">
      {COLUMNS.map(col => (
        <div key={col} className={`board-col col-${col}`}>
          <div className="board-col-head">
            <span className="board-col-dot" />
            <span className="board-col-title">{TRIAGE[col].label}</span>
            <span className="board-col-count">{count(col)}</span>
            <span className="board-col-desc">{TRIAGE[col].desc}</span>
          </div>
          <div className="board-col-body">
            {grouped[col].length === 0 && <div className="board-empty">No alerts</div>}
            {grouped[col].map(g => {
              const issue = g.items[0];
              const multi = g.items.length > 1;
              const sel = g.items.some(isSel);
              const expanded = multi && (open.has(g.key) || g.items.slice(1).some(isSel));
              const toggle = e => { e.stopPropagation(); setOpen(s => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; }); };
              const start = issue.earliest_scheduled || issue.playlist_start_time;
              const select = () => onSelect(isSel(issue) ? null : { atomIssueId: issue.atom_issue_id, playlistId: issue.playlist_id });
              return (
                <article key={g.key}
                  className={`card ${sel ? 'selected' : ''} ${issue.consolidated_status === 'resolved' ? 'is-resolved' : ''}`}
                  onClick={select} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') select(); }}>
                  <div className="card-top">
                    <SeverityPill severity={issue.severity} />
                    <AtomStatePill issue={issue} />
                  </div>
                  <div className="card-title">
                    <TypeLabel type={issue.issue_type} rawType={issue.raw_type} toc={issue.is_toc != null ? Boolean(issue.is_toc) : undefined} />
                    {multi && (
                      <button type="button" className={`card-bucket ${expanded ? 'open' : ''}`} onClick={toggle} aria-expanded={expanded}
                        title="Alerts in this ATOM bucket">
                        {g.items.length} alerts <span className="card-bucket-chev" aria-hidden>›</span>
                      </button>
                    )}
                  </div>
                  {issue.description && <div className="card-desc">{issue.description}</div>}
                  <div className="card-meta">
                    <span className="mono card-feed">{issue.feed_code}</span>
                    {issue.region && <span>{issue.region}</span>}
                    <span title={fmtShort(start)}>{relTime(start) || fmtShort(start)}</span>
                  </div>
                  <div className="card-foot">
                    {issue.ticket_link?.trim()
                      ? <a className="card-ticket mono" href={issue.ticket_link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{issue.ticket_id || 'Ticket'} ↗</a>
                      : <span className="mono card-asset">{issue.asset_id || ''}</span>}
                    {issue.has_previous_ticket_same_day ? <span className="badge-warn" title="A previous playlist version was ticketed today">Earlier ticket</span> : null}
                    <span className="card-action"><AckButton issue={issue} onChange={onStateChange} /></span>
                  </div>
                  {expanded && (
                    <ul className="card-members">
                      {g.items.map(m => {
                        const t = m.earliest_scheduled || m.playlist_start_time;
                        const pick = e => { e.stopPropagation(); onSelect(isSel(m) ? null : { atomIssueId: m.atom_issue_id, playlistId: m.playlist_id }); };
                        return (
                          <li key={rowKey(m)} className={`card-member ${isSel(m) ? 'selected' : ''}`} onClick={pick}>
                            <span className="mono">{fmtShort(t)}</span>
                            <span className="mono card-member-asset">{m.asset_id || m.atom_issue_id}</span>
                            <span className="card-member-ack" onClick={e => e.stopPropagation()}><AckButton issue={m} onChange={onStateChange} /></span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

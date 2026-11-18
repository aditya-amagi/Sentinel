import React, { useMemo } from 'react';
import AckButton from './AckButton';
import { SeverityPill, AtomStatePill, TypeLabel } from './Pills';
import { TRIAGE, triageOf, fmtShort, relTime } from '../lib/alerts';
import './AlertGroups.css';

const COLUMNS = ['penalty', 'ack', 'ticketed'];

/** Board view: one column per triage state. Rows arrive already sorted by the dashboard. */
export default function AlertGroups({ issues, selectedKey, onSelect, onStateChange }) {
  const grouped = useMemo(() => {
    const m = { penalty: [], ack: [], ticketed: [] };
    for (const i of issues) m[triageOf(i)].push(i);
    return m;
  }, [issues]);

  return (
    <div className="board">
      {COLUMNS.map(col => (
        <div key={col} className={`board-col col-${col}`}>
          <div className="board-col-head">
            <span className="board-col-dot" />
            <span className="board-col-title">{TRIAGE[col].label}</span>
            <span className="board-col-count">{grouped[col].length}</span>
            <span className="board-col-desc">{TRIAGE[col].desc}</span>
          </div>
          <div className="board-col-body">
            {grouped[col].length === 0 && <div className="board-empty">No alerts</div>}
            {grouped[col].map(issue => {
              const sel = selectedKey && issue.atom_issue_id === selectedKey.atomIssueId && issue.playlist_id === selectedKey.playlistId;
              const start = issue.earliest_scheduled || issue.playlist_start_time;
              const select = () => onSelect(sel ? null : { atomIssueId: issue.atom_issue_id, playlistId: issue.playlist_id });
              return (
                <article key={`${issue.atom_issue_id}-${issue.playlist_id}`}
                  className={`card ${sel ? 'selected' : ''} ${issue.consolidated_status === 'resolved' ? 'is-resolved' : ''}`}
                  onClick={select} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') select(); }}>
                  <div className="card-top">
                    <SeverityPill severity={issue.severity} />
                    <AtomStatePill issue={issue} />
                  </div>
                  <div className="card-title"><TypeLabel type={issue.issue_type} rawType={issue.raw_type} /></div>
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
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

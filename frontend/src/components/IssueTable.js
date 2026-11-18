import React from 'react';
import AckButton from './AckButton';
import { SeverityPill, AtomStatePill, TriagePill, TypeLabel } from './Pills';
import { triageOf, fmtShort, relTime, fmtDuration } from '../lib/alerts';
import './IssueTable.css';

const NEW_MS = 30 * 60 * 1000;
const isNew  = ts => ts && (Date.now() - new Date(ts).getTime() < NEW_MS);

export default function IssueTable({ issues, selectedKey, onSelect, onStateChange }) {
  const isSelected = row => selectedKey && row.atom_issue_id === selectedKey.atomIssueId && row.playlist_id === selectedKey.playlistId;

  return (
    <div className="issue-table-wrap">
      <table className="issue-table">
        <thead>
          <tr>
            <th className="c-triage">Triage</th>
            <th className="c-sev">Severity</th>
            <th className="c-feed">Feed</th>
            <th className="c-alert">Alert</th>
            <th className="c-atom">ATOM</th>
            <th className="c-start">Starts</th>
            <th className="c-pl">Playlist · Asset</th>
            <th className="c-ticket">Ticket</th>
          </tr>
        </thead>
        <tbody>
          {issues.map(issue => {
            const sel    = isSelected(issue);
            const state  = triageOf(issue);
            const start  = issue.earliest_scheduled || issue.playlist_start_time;
            const fresh  = isNew(issue.created_at && issue.created_at.replace(' ', 'T') + (issue.created_at.endsWith('Z') ? '' : 'Z'));
            const dur    = fmtDuration(issue.duration_ms);
            const select = () => onSelect(sel ? null : { atomIssueId: issue.atom_issue_id, playlistId: issue.playlist_id });
            return (
              <tr key={`${issue.atom_issue_id}-${issue.playlist_id}`}
                className={`issue-row t-${state} ${sel ? 'selected' : ''} ${issue.consolidated_status === 'resolved' ? 'is-resolved' : ''}`}
                onClick={select} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') select(); }}
                aria-selected={sel}>
                <td className="c-triage">
                  <div className="triage-cell">
                    <TriagePill state={state} />
                    <AckButton issue={issue} onChange={onStateChange} />
                  </div>
                </td>
                <td className="c-sev"><SeverityPill severity={issue.severity} /></td>
                <td className="c-feed">
                  <div className="feed-cell">
                    <span className="feed-code mono">{issue.feed_code || '—'}</span>
                    <span className="feed-sub truncate" title={issue.feed_name || undefined}>{[issue.feed_name, issue.region].filter(Boolean).join(' · ') || '—'}</span>
                  </div>
                </td>
                <td className="c-alert">
                  <div className="alert-cell">
                    <span className="alert-line">
                      <TypeLabel type={issue.issue_type} rawType={issue.raw_type} />
                      {fresh && <span className="badge-new">New</span>}
                      {issue.has_previous_ticket_same_day ? <span className="badge-warn" title="A previous playlist version was already ticketed today">Ticketed earlier today</span> : null}
                      {issue.atom_writeback_error && <span className="badge-err" title={issue.atom_writeback_error}>ATOM sync failed</span>}
                    </span>
                    {(issue.description || issue.alert_name) && (
                      <span className="alert-desc truncate" title={issue.description || issue.alert_name}>
                        {issue.description || issue.alert_name}
                      </span>
                    )}
                  </div>
                </td>
                <td className="c-atom"><AtomStatePill issue={issue} /></td>
                <td className="c-start">
                  <div className="start-cell">
                    <span className="mono">{fmtShort(start)}</span>
                    <span className="start-sub">{[relTime(start), dur].filter(Boolean).join(' · ')}</span>
                  </div>
                </td>
                <td className="c-pl">
                  <div className="pl-cell">
                    <span className="mono text-code">{issue.playlist_id || '—'}</span>
                    <span className="mono pl-asset truncate">{issue.asset_id || '—'}</span>
                  </div>
                </td>
                <td className="c-ticket">
                  {issue.ticket_link?.trim()
                    ? <a href={issue.ticket_link} target="_blank" rel="noopener noreferrer" className="ticket-link mono" onClick={e => e.stopPropagation()}>
                        {issue.ticket_id || 'Open'} ↗
                      </a>
                    : <span className="text-faint">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

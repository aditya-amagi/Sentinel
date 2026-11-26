import React, { useState } from 'react';
import AckButton from './AckButton';
import { SeverityPill, AtomStatePill, TriagePill, TypeLabel } from './Pills';
import { TRIAGE, triageOf, fmtShort, fmtClock, relTime, fmtDuration } from '../lib/alerts';
import { bucketSummary, rowKey } from '../lib/buckets';
import './IssueTable.css';

const NEW_MS = 30 * 60 * 1000;
const isNew  = ts => ts && (Date.now() - new Date(ts).getTime() < NEW_MS);
const tocProp = i => (i.is_toc != null ? Boolean(i.is_toc) : undefined);

/** buckets: [{key, items, lead, size}] (lib/buckets.toBuckets). Single-alert buckets render as plain rows. */
export default function IssueTable({ buckets, selectedKey, onSelect, onStateChange }) {
  const [open, setOpen] = useState(() => new Set());
  const isSelected = row => selectedKey && row.atom_issue_id === selectedKey.atomIssueId && row.playlist_id === selectedKey.playlistId;
  const toggle = key => setOpen(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

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
          {buckets.map(b => {
            const row = (issue, child) => (
              <AlertRow key={rowKey(issue)} issue={issue} child={child} selected={isSelected(issue)}
                onSelect={onSelect} onStateChange={onStateChange} />
            );
            if (b.size === 1) return row(b.lead, false);
            // Keep the bucket open while one of its alerts is selected in the drawer
            const expanded = open.has(b.key) || b.items.some(isSelected);
            return (
              <React.Fragment key={b.key}>
                <BucketRow bucket={b} expanded={expanded} onToggle={() => toggle(b.key)} />
                {expanded && b.items.map(i => row(i, true))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BucketRow({ bucket, expanded, onToggle }) {
  const { lead, items, size } = bucket;
  const s = bucketSummary(items);
  // First time on top; the last one underneath (clock only when on the same day)
  const sameDay = s.first && s.last && fmtShort(s.first).slice(0, 6) === fmtShort(s.last).slice(0, 6);
  const until = s.first && s.last && s.first !== s.last ? `to ${sameDay ? fmtClock(s.last) : fmtShort(s.last)}` : null;
  return (
    <tr className={`issue-row bucket-row t-${s.worst} ${expanded ? 'expanded' : ''}`}
      onClick={onToggle} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onToggle(); }}
      aria-expanded={expanded} title={`ATOM bucket · ${size} alerts — ${expanded ? 'collapse' : 'expand'}`}>
      <td className="c-triage">
        <div className="triage-cell bucket-triage">
          <span className={`bucket-chevron ${expanded ? 'open' : ''}`} aria-hidden>›</span>
          {['penalty', 'ack', 'ticketed'].filter(k => s.triage[k]).map(k => (
            <span key={k} className={`bucket-tri tri-${k}`} title={`${s.triage[k]} ${TRIAGE[k].label}`}>{s.triage[k]} {TRIAGE[k].label}</span>
          ))}
        </div>
      </td>
      <td className="c-sev"><SeverityPill severity={s.severity} /></td>
      <td className="c-feed">
        <div className="feed-cell">
          <span className="feed-code mono">{lead.feed_code || '—'}</span>
          <span className="feed-sub truncate" title={lead.feed_name || undefined}>{[lead.feed_name, lead.region].filter(Boolean).join(' · ') || '—'}</span>
        </div>
      </td>
      <td className="c-alert">
        <div className="alert-cell">
          <span className="alert-line">
            <TypeLabel type={lead.issue_type} rawType={lead.raw_type} toc={tocProp(lead)} />
            <span className="badge-bucket">{size} alerts</span>
          </span>
          {(lead.description || lead.alert_name) && (
            <span className="alert-desc truncate" title={lead.description || lead.alert_name}>{lead.description || lead.alert_name}</span>
          )}
        </div>
      </td>
      <td className="c-atom"><AtomStatePill issue={lead} /></td>
      <td className="c-start">
        <div className="start-cell">
          <span className="mono">{fmtShort(s.first)}</span>
          <span className="start-sub">{[until, relTime(s.first)].filter(Boolean).join(' · ')}</span>
        </div>
      </td>
      <td className="c-pl">
        <div className="pl-cell">
          <span className="mono text-code">{lead.playlist_id || '—'}</span>
          <span className="mono pl-asset truncate" title={s.assets.join(', ') || undefined}>
            {s.assets.length > 1 ? `${s.assets.length} assets` : s.assets[0] || '—'}
          </span>
        </div>
      </td>
      <td className="c-ticket">
        {s.tickets.length
          ? s.tickets.slice(0, 2).map(t => (
              <a key={t.id} href={t.link} target="_blank" rel="noopener noreferrer" className="ticket-link mono" onClick={e => e.stopPropagation()}>{t.id} ↗</a>
            ))
          : <span className="text-faint">—</span>}
      </td>
    </tr>
  );
}

function AlertRow({ issue, child, selected: sel, onSelect, onStateChange }) {
  const state  = triageOf(issue);
  const start  = issue.earliest_scheduled || issue.playlist_start_time;
  const fresh  = isNew(issue.created_at && issue.created_at.replace(' ', 'T') + (issue.created_at.endsWith('Z') ? '' : 'Z'));
  const dur    = fmtDuration(issue.duration_ms);
  const select = () => onSelect(sel ? null : { atomIssueId: issue.atom_issue_id, playlistId: issue.playlist_id });
  return (
    <tr className={`issue-row t-${state} ${child ? 'bucket-child' : ''} ${sel ? 'selected' : ''} ${issue.consolidated_status === 'resolved' ? 'is-resolved' : ''}`}
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
            <TypeLabel type={issue.issue_type} rawType={issue.raw_type} toc={tocProp(issue)} />
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
}

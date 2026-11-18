import React, { useEffect, useState } from 'react';
import { TOC_TYPES, alertLabel, SEVERITIES, SEVERITY_LABEL } from '../lib/alerts';
import './FilterBar.css';

export const DEFAULT_FILTERS = {
  feed_code: '', issue_type: '', date_from: '', date_to: '',
  penalty: '', acknowledged: '', has_ticket: '', state: '',
  severity: '', atom_state: 'open', toc_only: '', sort: 'priority',
};

const TRIAGE_OPTS = [['', 'All'], ['penalty', 'Penalty'], ['ack', 'Ack'], ['ticketed', 'Ticketed']];
const ATOM_OPTS   = [['open', 'Open'], ['active', 'Active'], ['snoozed', 'Snoozed'], ['resolved', 'Resolved'], ['', 'All']];
const SCOPE_OPTS  = [['', 'All alerts'], ['true', 'TOC only'], ['false', 'Other only']];

export default function FilterBar({ filters, onChange, viewMode, onViewMode }) {
  const set = (key, val) => onChange(prev => ({ ...prev, [key]: val }));
  const [otherTypes, setOtherTypes] = useState([]);

  useEffect(() => {
    fetch('/api/issue-types/other', { credentials: 'include' })
      .then(r => r.json()).then(d => setOtherTypes(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const activeCount = Object.keys(DEFAULT_FILTERS)
    .filter(k => k !== 'sort' && (filters[k] ?? '') !== DEFAULT_FILTERS[k]).length;

  const toggleSeverity = s => {
    const cur = new Set((filters.severity || '').split(',').filter(Boolean));
    cur.has(s) ? cur.delete(s) : cur.add(s);
    set('severity', SEVERITIES.filter(x => cur.has(x)).join(','));
  };
  const sevOn = s => (filters.severity || '').split(',').includes(s);

  return (
    <div className="filterbar" role="search">
      <div className="fb-row">
        <label className="fb-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input placeholder="Search feed code…" value={filters.feed_code} onChange={e => set('feed_code', e.target.value)} aria-label="Feed code" />
        </label>

        <select className="fb-select" value={filters.issue_type} onChange={e => set('issue_type', e.target.value)} aria-label="Alert type">
          <option value="">All alert types</option>
          <optgroup label="TOC alerts">
            {TOC_TYPES.map(t => <option key={t} value={t}>{alertLabel(t)}</option>)}
          </optgroup>
          {otherTypes.length > 0 && (
            <optgroup label="Other ATOM alerts">
              {otherTypes.map(t => <option key={t.key} value={t.key}>{t.label} ({t.count})</option>)}
            </optgroup>
          )}
        </select>

        <Segmented label="Show" options={SCOPE_OPTS} value={filters.toc_only} onChange={v => set('toc_only', v)} />
        <Segmented label="Triage" options={TRIAGE_OPTS} value={filters.state} onChange={v => set('state', v)} />

        <div className="fb-spacer" />

        <div className="fb-view" role="group" aria-label="View">
          <button className={viewMode === 'table' ? 'active' : ''} onClick={() => onViewMode('table')} title="Table">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <button className={viewMode === 'groups' ? 'active' : ''} onClick={() => onViewMode('groups')} title="Board">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/></svg>
          </button>
        </div>
      </div>

      <div className="fb-row secondary">
        <div className="fb-group">
          <span className="fb-label">Severity</span>
          {SEVERITIES.filter(s => s !== 'dev').map(s => (
            <button key={s} className={`fb-chip sev-${s} ${sevOn(s) ? 'on' : ''}`} onClick={() => toggleSeverity(s)} aria-pressed={sevOn(s)}>
              {SEVERITY_LABEL[s]}
            </button>
          ))}
        </div>

        <Segmented label="ATOM state" options={ATOM_OPTS} value={filters.atom_state} onChange={v => set('atom_state', v)} />

        <div className="fb-group">
          <span className="fb-label">Broadcast date</span>
          <input type="date" className="fb-date" value={filters.date_from} onChange={e => set('date_from', e.target.value)} aria-label="From" />
          <span className="fb-to">→</span>
          <input type="date" className="fb-date" value={filters.date_to} onChange={e => set('date_to', e.target.value)} aria-label="To" />
        </div>

        <div className="fb-group">
          <span className="fb-label">Sort</span>
          <select className="fb-select small" value={filters.sort} onChange={e => set('sort', e.target.value)} aria-label="Sort">
            <option value="priority">Priority</option>
            <option value="severity">Severity</option>
            <option value="time">Start time</option>
          </select>
        </div>

        {activeCount > 0 && (
          <button className="btn ghost sm fb-clear" onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })}>
            Clear {activeCount} filter{activeCount > 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="fb-group">
      <span className="fb-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v || 'all'} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

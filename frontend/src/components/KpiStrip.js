import React from 'react';
import { SEVERITIES, SEVERITY_LABEL } from '../lib/alerts';
import './KpiStrip.css';

/** Headline numbers; each card doubles as a quick filter. */
export default function KpiStrip({ stats, filters, onFilter }) {
  const s = stats || {};
  const sev = s.by_severity || {};
  const sevTotal = SEVERITIES.reduce((n, k) => n + (sev[k] || 0), 0);

  // Clicking an active card clears it back to its default value
  const toggle = (key, value, off = '') => onFilter({ [key]: filters[key] === value ? off : value });

  return (
    <div className="kpi-strip">
      <Kpi tone="penalty"  label="Needs action" value={s.state_penalty}  sub="Penalty — not yet triaged"
        active={filters.state === 'penalty'}  onClick={() => toggle('state', 'penalty')} />
      <Kpi tone="ack"      label="Acknowledged" value={s.state_ack}      sub="Seen, no ticket needed"
        active={filters.state === 'ack'}      onClick={() => toggle('state', 'ack')} />
      <Kpi tone="ticketed" label="Ticketed"     value={s.state_ticketed} sub="Freshdesk ticket filed"
        active={filters.state === 'ticketed'} onClick={() => toggle('state', 'ticketed')} />

      <div className="kpi kpi-wide">
        <div className="kpi-label">Open by severity</div>
        <div className="sev-bar" role="img" aria-label="Open alerts by severity">
          {sevTotal === 0 && <span className="sev-bar-empty" />}
          {SEVERITIES.filter(k => sev[k]).map(k => (
            <button key={k} className={`sev-seg seg-${k} ${filters.severity === k ? 'active' : ''}`}
              style={{ flexGrow: sev[k] }} title={`${SEVERITY_LABEL[k]}: ${sev[k]}`}
              onClick={() => toggle('severity', k)} />
          ))}
        </div>
        <div className="sev-legend">
          {SEVERITIES.filter(k => k !== 'dev').map(k => (
            <button key={k} className={`sev-leg ${filters.severity === k ? 'active' : ''}`} onClick={() => toggle('severity', k)}>
              <span className={`sev-swatch seg-${k}`} />{SEVERITY_LABEL[k]} <b>{sev[k] || 0}</b>
            </button>
          ))}
        </div>
      </div>

      <div className="kpi kpi-atom">
        <div className="kpi-label">In ATOM</div>
        <div className="atom-split">
          <button className={`atom-stat ${filters.atom_state === 'active' ? 'active' : ''}`} onClick={() => toggle('atom_state', 'active', 'open')}>
            <span className="atom-num c-active">{s.atom_active ?? '—'}</span><span>active</span>
          </button>
          <button className={`atom-stat ${filters.atom_state === 'snoozed' ? 'active' : ''}`} onClick={() => toggle('atom_state', 'snoozed', 'open')}>
            <span className="atom-num c-snoozed">{s.atom_snoozed ?? '—'}</span><span>snoozed</span>
          </button>
          <button className={`atom-stat ${filters.toc_only === 'false' ? 'active' : ''}`} onClick={() => toggle('toc_only', 'false')}>
            <span className="atom-num c-other">{s.other_open ?? '—'}</span><span>other types</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Kpi({ tone, label, value, sub, active, onClick }) {
  return (
    <button className={`kpi kpi-${tone} ${active ? 'active' : ''}`} onClick={onClick} aria-pressed={active}>
      <div className="kpi-label"><span className="kpi-dot" />{label}</div>
      <div className="kpi-value">{value ?? '—'}</div>
      <div className="kpi-sub">{sub}</div>
    </button>
  );
}

import React from 'react';
import { alertLabel, isToc, SEVERITY_LABEL, TRIAGE, fmtClock } from '../lib/alerts';
import './Pills.css';

export function SeverityPill({ severity, compact }) {
  if (!severity) return <span className="pill sev sev-none">—</span>;
  return (
    <span className={`pill sev sev-${severity}`} title={`Severity: ${SEVERITY_LABEL[severity] || severity}`}>
      <span className="sev-bars" aria-hidden="true"><i /><i /><i /></span>
      {!compact && (SEVERITY_LABEL[severity] || severity)}
    </span>
  );
}

export function AtomStatePill({ issue }) {
  const s = issue?.consolidated_status;
  if (!s) return null;
  if (s === 'snoozed') {
    return (
      <span className="pill atom atom-snoozed" title={issue.snoozed_by ? `Snoozed by ${issue.snoozed_by}` : 'Snoozed in ATOM'}>
        <span className="atom-dot" /> Snoozed{issue.snoozed_until ? ` → ${fmtClock(issue.snoozed_until)}` : ''}
      </span>
    );
  }
  if (s === 'resolved') {
    return <span className="pill atom atom-resolved" title={issue.resolved_by ? `Resolved by ${issue.resolved_by}` : 'Resolved in ATOM'}><span className="atom-dot" /> Resolved</span>;
  }
  return <span className="pill atom atom-active" title="Active in ATOM"><span className="atom-dot pulse" /> Active</span>;
}

export function TriagePill({ state }) {
  const m = TRIAGE[state] || TRIAGE.penalty;
  return <span className={`pill triage triage-${state}`} title={m.desc}>{m.label}</span>;
}

export function TypeLabel({ type, rawType, toc }) {
  return (
    <span className={`type-label ${(toc ?? isToc(type)) ? 'toc' : 'other'}`} title={rawType && rawType !== type ? rawType : undefined}>
      {alertLabel(type)}
    </span>
  );
}

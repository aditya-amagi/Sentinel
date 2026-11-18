import React, { useEffect, useRef, useState } from 'react';
import { api, issuePath, setTriageState } from '../lib/api';
import { useAppConfig } from '../hooks/useAppConfig';
import { triageOf, fmtShort } from '../lib/alerts';
import { SREBus } from './SRETerminal';
import './AckButton.css';

/**
 * Triage action for an issue: Ack (penalty → ack) or Reopen (ack → penalty).
 * With ATOM write-back enabled, Ack opens a snooze picker: 1h / 4h / end of broadcast day /
 * ack only. Reopen de-snoozes in ATOM (handled server-side).
 * onChange(updatedIssue, atomResult) is called after a successful transition.
 */
export default function AckButton({ issue, onChange, size = 'sm', full = false }) {
  const { atom_writeback } = useAppConfig();
  const [busy, setBusy]       = useState(false);
  const [open, setOpen]       = useState(false);
  const [options, setOptions] = useState(null);
  const [error, setError]     = useState('');
  const [pos, setPos]         = useState(null);
  const wrapRef = useRef(null);
  const state = triageOf(issue);

  useEffect(() => {
    if (!open) return;
    const close = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = e => { if (!e.target.closest?.('.snooze-menu')) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  if (state === 'ticketed') return null;

  const run = async (next, snooze_until) => {
    setBusy(true); setError(''); setOpen(false);
    try {
      const data = await setTriageState(issue, next, snooze_until);
      if (data.atom && data.atom.ok === false) {
        setError('ATOM not updated');
        SREBus.logError({ message: `ATOM write-back failed: ${data.atom.error}` });
      }
      onChange && onChange({ ...(data.issue || data), _prevState: state }, data.atom);
    } catch (e) {
      setError(e.message);
      SREBus.logError({ message: `State change failed: ${e.message}` });
    } finally { setBusy(false); }
  };

  const onAckClick = async e => {
    e.stopPropagation();
    if (!atom_writeback) return run('ack');
    // Fixed positioning so scroll containers (tables, drawers) never clip the menu
    const r = e.currentTarget.getBoundingClientRect();
    const menuH = 230, menuW = 270;
    const up = r.bottom + menuH > window.innerHeight - 8;
    setPos({
      top:  up ? Math.max(8, r.top - menuH - 6) : r.bottom + 6,
      left: Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8)),
    });
    setOpen(o => !o);
    if (!options) {
      try { setOptions((await api(issuePath(issue, '/snooze-options'), { log: false })).options); }
      catch { setOptions([]); }
    }
  };

  const cls = `btn ${size === 'sm' ? 'sm' : ''} ${full ? 'full' : ''}`;

  if (state === 'ack') {
    return (
      <span className="ack-wrap" onClick={e => e.stopPropagation()}>
        <button className={`${cls} reopen`} disabled={busy} onClick={() => run('penalty')}
          title={issue.consolidated_status === 'snoozed' && atom_writeback ? 'Back to Penalty and un-snooze in ATOM' : 'Back to Penalty'}>
          {busy ? '…' : 'Reopen'}
        </button>
        {error && <span className="ack-error" title={error}>!</span>}
      </span>
    );
  }

  return (
    <span className="ack-wrap" ref={wrapRef} onClick={e => e.stopPropagation()}>
      <button className={`${cls} ack`} disabled={busy} onClick={onAckClick} aria-haspopup={atom_writeback ? 'menu' : undefined}
        aria-expanded={open} title={atom_writeback ? 'Acknowledge and snooze in ATOM' : 'Mark as seen — no ticket needed'}>
        {busy ? '…' : <>Ack{atom_writeback && <span className="ack-caret">▾</span>}</>}
      </button>
      {error && <span className="ack-error" title={error}>!</span>}
      {open && (
        <div className="snooze-menu" role="menu" style={pos || undefined}>
          <div className="snooze-title">Snooze in ATOM for</div>
          {!options && <div className="snooze-loading">Loading…</div>}
          {options?.map(o => (
            <button key={o.key} role="menuitem" className="snooze-item" onClick={() => run('ack', o.until)}>
              <span>{o.label}</span>
              <span className="snooze-when mono">{o.detail || fmtShort(o.until)}</span>
            </button>
          ))}
          <div className="snooze-sep" />
          <button role="menuitem" className="snooze-item muted" onClick={() => run('ack')}>
            <span>Ack only</span><span className="snooze-when">don't snooze ATOM</span>
          </button>
        </div>
      )}
    </span>
  );
}

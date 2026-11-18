import React, { useEffect, useState } from 'react';
import './RegionNav.css';
import { useAppConfig } from '../hooks/useAppConfig';

const BASE_REGIONS = ['APAC', 'US', 'EMEA'];

const PAGES = [
  { key: 'dashboard', label: 'Live alerts',      icon: 'M4 13h4l2-6 4 12 2-6h4' },
  { key: 'history',   label: 'History',          icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-3-6.7M21 4v4h-4' },
  { key: 'settings',  label: 'Contacts & feeds', icon: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 8v6M22 11h-6' },
];

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export default function RegionNav({ regions, active, activeFamily, page, onSelect, onPageChange, stats }) {
  const cfg = useAppConfig();
  const allRegions = [...new Set([...BASE_REGIONS, ...(regions || [])])];
  const [counts, setCounts] = useState({});
  const [viewGroups, setViewGroups] = useState(null);   // null = not loaded, [] = type mode
  const [expanded, setExpanded] = useState({});

  // ATOM view groups (views mode). Refreshes with global stats.
  useEffect(() => {
    let off = false;
    fetch('/api/views', { credentials: 'include' }).then(r => r.json())
      .then(d => { if (!off) setViewGroups(Array.isArray(d) ? d : []); })
      .catch(() => { if (!off) setViewGroups([]); });
    return () => { off = true; };
  }, [stats?.total, stats?.state_penalty]);
  useEffect(() => { if (active) setExpanded(e => ({ ...e, [String(active).toLowerCase()]: true })); }, [active]);
  const usingViews = viewGroups && viewGroups.length > 0;

  // Open-alert counts per region (type mode only; refreshes whenever global stats change)
  useEffect(() => {
    if (usingViews) return undefined;
    let cancelled = false;
    Promise.all(allRegions.map(r =>
      fetch(`/api/stats?region=${encodeURIComponent(r)}`, { credentials: 'include' })
        .then(x => x.json()).then(s => [r, s.state_penalty ?? null]).catch(() => [r, null])
    )).then(rows => { if (!cancelled) setCounts(Object.fromEntries(rows)); });
    return () => { cancelled = true; };
  }, [stats?.total, stats?.state_penalty, allRegions.join(), usingViews]); // eslint-disable-line

  // Badges count alerts that still need action (Penalty), matching the dashboard's KPI
  const totalOpen = stats ? stats.state_penalty ?? null : null;
  const atomMode = cfg.demo_mode ? 'Demo' : cfg.atom_live ? 'Live' : 'Mock';

  return (
    <nav className="sidenav" aria-label="Main">
      <div className="sn-section">
        <div className="sn-heading">Workspace</div>
        {PAGES.map(p => (
          <button key={p.key} className={`sn-item ${page === p.key ? 'active' : ''}`} onClick={() => onPageChange(p.key)}
            aria-current={page === p.key ? 'page' : undefined}>
            <Icon d={p.icon} />
            <span className="sn-label">{p.label}</span>
            {p.key === 'dashboard' && totalOpen > 0 && <span className="sn-count" title="Alerts needing action">{totalOpen}</span>}
          </button>
        ))}
      </div>

      {page !== 'settings' && usingViews && (
        <div className="sn-section">
          <div className="sn-heading">ATOM views</div>
          <button className={`sn-item ${!active ? 'active' : ''}`} onClick={() => onSelect(null)}>
            <span className="sn-region-dot all" />
            <span className="sn-label">All views</span>
          </button>
          {viewGroups.map(g => {
            const isActive = same(active, g.group);
            const open = expanded[String(g.group).toLowerCase()];
            const families = g.views.filter(v => v.family);
            return (
              <div key={g.group} className="sn-group">
                <div className={`sn-item sn-group-row ${isActive && !activeFamily ? 'active' : ''}`}>
                  {families.length > 0
                    ? <button className={`sn-caret ${open ? 'open' : ''}`} aria-label={open ? `Collapse ${g.group}` : `Expand ${g.group}`} aria-expanded={!!open}
                        onClick={() => setExpanded(e => ({ ...e, [String(g.group).toLowerCase()]: !open }))}>›</button>
                    : <span className="sn-caret-spacer" />}
                  <button className="sn-group-btn" onClick={() => onSelect(g.group)} title={g.views.map(v => v.name).join('\n')}>
                    <span className="sn-label">{g.group}</span>
                    {g.penalty > 0 ? <span className="sn-count subtle" title="Alerts needing action">{g.penalty}</span>
                      : <span className="sn-zero" title="Open alerts">{g.open || ''}</span>}
                  </button>
                </div>
                {open && families.map(v => (
                  <button key={v.id} className={`sn-item sn-sub ${isActive && same(activeFamily, v.family) ? 'active' : ''}`}
                    onClick={() => onSelect(g.group, v.family)} title={v.name}>
                    <span className="sn-label">{v.family}</span>
                    {v.penalty > 0 ? <span className="sn-count subtle">{v.penalty}</span> : <span className="sn-zero">{v.open || ''}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {page !== 'settings' && !usingViews && (
        <div className="sn-section">
          <div className="sn-heading">Regions</div>
          <button className={`sn-item ${!active ? 'active' : ''}`} onClick={() => onSelect(null)}>
            <span className="sn-region-dot all" />
            <span className="sn-label">All regions</span>
          </button>
          {allRegions.map(r => (
            <button key={r} className={`sn-item ${active === r ? 'active' : ''}`} onClick={() => onSelect(r)}>
              <span className={`sn-region-dot r-${r.toLowerCase()}`} />
              <span className="sn-label">{r}</span>
              {counts[r] > 0 && <span className="sn-count subtle" title="Alerts needing action">{counts[r]}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="sn-footer">
        <div className="sn-atom">
          <span className={`sn-atom-dot ${atomMode.toLowerCase()}`} />
          <div className="sn-atom-text">
            <span className="sn-atom-title">ATOM · {atomMode}</span>
            <span className="sn-atom-sub">
              {cfg.atom_writeback ? 'Write-back on (snooze, comments)' : 'Read-only'}
              {stats?.sync?.atom_auth?.mode === 'refresh' && !stats.sync.atom_auth.error && ' · token auto-renews'}
            </span>
          </div>
        </div>
        {stats?.sync?.atom_rate?.paused_until && (
          <div className="sn-warn" title={stats.sync.atom_rate.pause_reason || ''}>
            ATOM calls paused until {new Date(stats.sync.atom_rate.paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ATOM is struggling
          </div>
        )}
        {stats?.sync?.atom_auth?.error && (
          <div className="sn-warn" title={stats.sync.atom_auth.error}>ATOM sign-in expired — update the token</div>
        )}
        {stats?.writeback_errors > 0 && (
          <div className="sn-warn">{stats.writeback_errors} ATOM write-back error{stats.writeback_errors > 1 ? 's' : ''}</div>
        )}
      </div>
    </nav>
  );
}

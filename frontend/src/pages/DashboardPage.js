import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import IssueTable  from '../components/IssueTable';
import AlertGroups from '../components/AlertGroups';
import IssueDetail from '../components/IssueDetail';
import FilterBar, { DEFAULT_FILTERS } from '../components/FilterBar';
import KpiStrip    from '../components/KpiStrip';
import { setSREContext, SREBus } from '../components/SRETerminal';
import { isToc, severityRank, triageOf, SEVERITIES } from '../lib/alerts';
import './DashboardPage.css';

const TRIAGE_ORDER = { penalty: 0, ack: 1, ticketed: 2 };
const PAGE = 200; // rows rendered per section before "Show more" (prod has thousands of alerts)
const startOf = i => i.earliest_scheduled || i.playlist_start_time || i.playlist_date || '';

const SORTERS = {
  priority: (a, b) =>
    TRIAGE_ORDER[triageOf(a)] - TRIAGE_ORDER[triageOf(b)] ||
    severityRank(a.severity) - severityRank(b.severity) ||
    startOf(a).localeCompare(startOf(b)),
  severity: (a, b) => severityRank(a.severity) - severityRank(b.severity) || startOf(a).localeCompare(startOf(b)),
  time:     (a, b) => startOf(a).localeCompare(startOf(b)),
};

export default function DashboardPage({ region, onStatsChange, stats }) {
  const [issues,      setIssues]      = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [viewMode,    setViewMode]    = useState(() => { try { return localStorage.getItem('sentinel.view') || 'table'; } catch { return 'table'; } });
  const [filters,     setFilters]     = useState(DEFAULT_FILTERS);
  const [collapsed,   setCollapsed]   = useState({ toc: false, other: false });
  const [shown,       setShown]       = useState({ toc: PAGE, other: PAGE }); // rows rendered per section
  const pollRef = useRef(null);

  useEffect(() => { try { localStorage.setItem('sentinel.view', viewMode); } catch {} }, [viewMode]);

  const fetchIssues = useCallback(async (spinner = false) => {
    if (spinner) setLoading(true);
    try {
      const p = new URLSearchParams();
      if (region) p.set('region', region);
      Object.entries(filters).forEach(([k, v]) => { if (v !== '' && k !== 'sort') p.set(k, v); });
      const t0 = performance.now();
      const res = await fetch(`/api/issues/upcoming?${p}`, { credentials: 'include' });
      SREBus.logTraffic({ method: 'GET', url: '/api/issues/upcoming', status: res.status, ms: Math.round(performance.now() - t0) });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [];
      setIssues(arr);
      setSREContext({ issues: arr, lastFetch: new Date().toISOString(), filters });
    } catch {}
    finally { if (spinner) setLoading(false); }
  }, [filters, region]);

  useEffect(() => { fetchIssues(true); setSelectedKey(null); setShown({ toc: PAGE, other: PAGE }); }, [filters, region]); // eslint-disable-line
  useEffect(() => { setSREContext({ selectedKey, filters }); }, [selectedKey, filters]); // eslint-disable-line
  useEffect(() => {
    pollRef.current = setInterval(() => { fetchIssues(); onStatsChange(); }, 30000);
    return () => clearInterval(pollRef.current);
  }, [fetchIssues, onStatsChange]);

  const mergeIssue = useCallback(updated => {
    const iss = updated?.issue || updated;
    if (!iss?.atom_issue_id) return;
    setIssues(prev => {
      const next = prev.map(i => i.atom_issue_id === iss.atom_issue_id && i.playlist_id === iss.playlist_id ? { ...i, ...iss } : i);
      setSREContext({ issues: next });
      return next;
    });
    onStatsChange();
  }, [onStatsChange]);

  const { toc, other } = useMemo(() => {
    const sorter = SORTERS[filters.sort] || SORTERS.priority;
    const t = [], o = [];
    for (const i of issues) (isToc(i.issue_type) ? t : o).push(i);
    return { toc: t.sort(sorter), other: o.sort(sorter) };
  }, [issues, filters.sort]);

  const scope = filters.toc_only; // '' both | 'true' TOC only | 'false' other only
  const sections = [
    scope !== 'false' && { key: 'toc',   title: 'TOC alerts',        hint: 'Hole · No playlist · Duration mismatch · Missing in cloud', rows: toc },
    scope !== 'true'  && { key: 'other', title: 'Other ATOM alerts', hint: 'Every other ATOM alert type on these feeds',                rows: other },
  ].filter(Boolean);

  const view = rows => viewMode === 'table'
    ? <IssueTable issues={rows} loading={false} selectedKey={selectedKey} onSelect={setSelectedKey} onStateChange={mergeIssue} />
    : <AlertGroups issues={rows} selectedKey={selectedKey} onSelect={setSelectedKey} onStateChange={mergeIssue} />;

  return (
    <div className="dashboard-page">
      <div className={`dashboard-main ${selectedKey ? 'with-drawer' : ''}`}>
        <div className="dashboard-scroll">
          <KpiStrip stats={stats} filters={filters} onFilter={patch => setFilters(f => ({ ...f, ...patch }))} />

          <FilterBar filters={filters} onChange={setFilters} viewMode={viewMode} onViewMode={setViewMode} />

          {loading ? (
            <div className="empty-state"><div className="loading-spinner" /><span>Loading alerts…</span></div>
          ) : sections.map(sec => (
            <section key={sec.key} className={`alert-section sec-${sec.key}`}>
              <button className="section-head" onClick={() => setCollapsed(c => ({ ...c, [sec.key]: !c[sec.key] }))}
                aria-expanded={!collapsed[sec.key]}>
                <span className={`section-chevron ${collapsed[sec.key] ? '' : 'open'}`}>›</span>
                <span className="section-title">{sec.title}</span>
                <span className="section-count">{sec.rows.length}</span>
                <SeverityMini rows={sec.rows} />
                <span className="section-hint">{sec.hint}</span>
              </button>
              {!collapsed[sec.key] && (
                sec.rows.length
                  ? <div className="section-body">
                      {view(sec.rows.slice(0, shown[sec.key]))}
                      {sec.rows.length > shown[sec.key] && (
                        <div className="section-more">
                          <span>Showing {shown[sec.key]} of {sec.rows.length}</span>
                          <button className="btn sm" onClick={() => setShown(s => ({ ...s, [sec.key]: s[sec.key] + PAGE }))}>
                            Show {Math.min(PAGE, sec.rows.length - shown[sec.key])} more
                          </button>
                          <button className="btn ghost sm" onClick={() => setShown(s => ({ ...s, [sec.key]: sec.rows.length }))}>Show all</button>
                        </div>
                      )}
                    </div>
                  : <div className="empty-state compact">
                      <span className="empty-title">Nothing here</span>
                      <span>No {sec.key === 'toc' ? 'TOC' : 'other ATOM'} alerts match the current filters.</span>
                    </div>
              )}
            </section>
          ))}
        </div>
      </div>

      {selectedKey && (
        <aside className="drawer" aria-label="Alert details">
          <IssueDetail
            atomIssueId={selectedKey.atomIssueId}
            playlistId={selectedKey.playlistId}
            onClose={() => setSelectedKey(null)}
            onUpdate={mergeIssue}
          />
        </aside>
      )}
    </div>
  );
}

function SeverityMini({ rows }) {
  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) if (r.severity) c[r.severity] = (c[r.severity] || 0) + 1;
    return c;
  }, [rows]);
  const shown = SEVERITIES.filter(s => counts[s] && s !== 'dev');
  if (!shown.length) return null;
  return (
    <span className="sev-mini" onClick={e => e.stopPropagation()}>
      {shown.map(s => <span key={s} className={`sev-mini-item sm-${s}`}>{counts[s]} {s}</span>)}
    </span>
  );
}

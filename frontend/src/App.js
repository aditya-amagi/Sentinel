import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRegionRoute } from './hooks/useRegionRoute';
import { useAuth }        from './hooks/useAuth';
import Header             from './components/Header';
import RegionNav          from './components/RegionNav';
import LoadingScreen      from './components/LoadingScreen';
import LoginPage          from './pages/LoginPage';
import DashboardPage      from './pages/DashboardPage';
import HistoryPage        from './pages/HistoryPage';
import ContactsPage       from './pages/ContactsPage';
import SRETerminal, { setSREContext } from './components/SRETerminal';
import './App.css';

export default function App() {
  const { page, region, family, navigate }      = useRegionRoute();
  const { user, loading: authLoading, authenticated, auth_configured, logout } = useAuth();

  const [appLoading, setAppLoading] = useState(true);
  const [stats,      setStats]      = useState(null);
  const [regions,    setRegions]    = useState([]);
  const [syncing,    setSyncing]    = useState(false);
  const initialDone = useRef(false);

  const fetchStats = useCallback(async () => {
    try {
      const p = region ? `?region=${encodeURIComponent(region)}` : '';
      setStats(await (await fetch(`/api/stats${p}`, { credentials: 'include' })).json());
    } catch {}
  }, [region]);

  const fetchMeta = useCallback(async () => {
    try {
      setRegions(await (await fetch('/api/regions', { credentials: 'include' })).json());
    } catch {}
  }, []);

  useEffect(() => {
    // Wait for auth check to complete first
    if (authLoading) return;
    if (!authenticated) { setAppLoading(false); return; }

    if (initialDone.current) return;
    initialDone.current = true;
    Promise.all([new Promise(r => setTimeout(r, 1800)), fetchStats(), fetchMeta()])
      .then(() => setAppLoading(false));
  }, [authLoading, authenticated]); // eslint-disable-line

  useEffect(() => {
    if (!appLoading && authenticated) fetchStats();
  }, [region]); // eslint-disable-line

  const handleSync = async () => {
    setSyncing(true);
    await fetch('/api/sync', { method: 'POST', credentials: 'include' });
    setTimeout(() => { fetchStats(); setSyncing(false); }, 3500);
  };

  // ── Auth loading ─────────────────────────────────────────────────────────────
  if (authLoading) {
    return <LoadingScreen appName="SENTINEL" subtitle="Checking authentication…" />;
  }

  // ── Not authenticated → show login page ──────────────────────────────────────
  if (!authenticated) {
    return <LoginPage authConfigured={auth_configured} />;
  }

  // ── App loading (data fetch) ──────────────────────────────────────────────────
  if (appLoading) {
    return <LoadingScreen appName="SENTINEL" subtitle="TOC Alert Monitoring & Ticket Automation" />;
  }

  return (
    <div className="app-layout">
      <Header
        stats={stats}
        onSync={handleSync}
        syncing={syncing}
        region={region}
        family={family}
        page={page}
        user={user}
        onLogout={logout}
      />
      <div className="app-mid">
        <RegionNav
          regions={regions}
          active={region}
          activeFamily={family}
          page={page}
          stats={stats}
          onSelect={(r, f) => navigate(page, r, f)}
          onPageChange={(p) => navigate(p, region)}
        />
        <div className="app-right">
          {page === 'settings'  && <ContactsPage />}
          {page === 'dashboard' && <DashboardPage region={region} family={family} onStatsChange={fetchStats} stats={stats} />}
          {page === 'history'   && <HistoryPage   region={region} />}
        </div>
      </div>
      <SRETerminal
        issues={[]}
        selectedKey={null}
        filters={{}}
        stats={stats}
        region={region}
      />
    </div>
  );
}

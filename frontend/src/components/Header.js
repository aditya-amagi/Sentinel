import React from 'react';
import './Header.css';
import UserBadge from './UserBadge';
import { useAppConfig } from '../hooks/useAppConfig';
import { relTime } from '../lib/alerts';

const PAGE_TITLES = {
  dashboard: 'Live alerts',
  history:   'History',
  settings:  'Contacts & feeds',
};

export default function Header({ stats, onSync, syncing, region, page, user, onLogout }) {
  const { demo_mode } = useAppConfig();
  const s    = stats || {};
  const sync = s.sync || {};
  const busy = syncing || sync.isSyncing;

  return (
    <header className="topbar">
      <div className="tb-brand">
        <span className="tb-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2 3 6v6c0 5 3.8 9.4 9 10 5.2-.6 9-5 9-10V6l-9-4Z" fill="currentColor" opacity=".9"/><path d="M12 7v6m0 3v.01" stroke="var(--on-accent)" strokeWidth="2.2" strokeLinecap="round"/></svg>
        </span>
        <span className="tb-name">Sentinel</span>
        <span className="tb-divider" />
        <span className="tb-crumb">{PAGE_TITLES[page] || 'Sentinel'}</span>
        {region && page !== 'settings' && <span className="tb-region">{region}</span>}
        {demo_mode && <span className="tb-demo">Demo data</span>}
      </div>

      <div className="tb-actions">
        <div className={`tb-sync-status ${sync.lastSyncStatus === 'error' ? 'error' : ''}`}
          title={sync.lastSyncError || (sync.lastSyncTime ? new Date(sync.lastSyncTime).toLocaleString() : 'Never synced')}>
          <span className={`tb-sync-dot ${busy ? 'busy' : sync.lastSyncStatus === 'error' ? 'error' : 'ok'}`} />
          {busy ? 'Syncing with ATOM…'
            : sync.lastSyncStatus === 'error' ? 'Sync failed'
            : sync.lastSyncTime ? `Synced ${relTime(sync.lastSyncTime)}` : 'Not synced yet'}
        </div>
        <button className="btn sm" onClick={onSync} disabled={busy}>
          <span className={`tb-sync-icon ${busy ? 'spinning' : ''}`}>↻</span> Sync
        </button>
        <UserBadge user={user} onLogout={onLogout} />
      </div>
    </header>
  );
}

import React, { useState } from 'react';
import './UserBadge.css';

export default function UserBadge({ user, onLogout }) {
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const initials = user.name
    ? user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase();

  return (
    <div className="user-badge-wrap">
      <button
        className={`user-badge ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title={user.email}
      >
        <span className="user-avatar">{initials}</span>
        <span className="user-name">{user.given_name || user.name || user.email.split('@')[0]}</span>
        <span className="user-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <>
          <div className="user-dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="user-dropdown">
            <div className="ud-header">
              <span className="ud-name">{user.name || user.email}</span>
              <span className="ud-email">{user.email}</span>
              {user.bypass && (
                <span className="ud-bypass-badge">DEV BYPASS</span>
              )}
            </div>
            <div className="ud-divider" />
            <button className="ud-logout" onClick={() => { setOpen(false); onLogout(); }}>
              <span className="ud-logout-icon">⎋</span>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

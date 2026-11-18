import React, { useState } from 'react';
import './LoginPage.css';

export default function LoginPage({ authConfigured }) {
  const [loading, setLoading] = useState(false);

  const handleLogin = () => {
    setLoading(true);
    window.location.href = '/auth/login';
  };

  return (
    <div className="login-page">
      <div className="login-card">

        {/* Logo / brand */}
        <div className="login-brand">
          <div className="login-logo">⬡</div>
          <div className="login-brand-text">
            <span className="login-title">SENTINEL</span>
            <span className="login-subtitle">TOC Alert Monitoring & Ticket Automation</span>
          </div>
        </div>

        <div className="login-divider" />

        {/* Sign in block */}
        <div className="login-body">
          <p className="login-desc">
            Sign in with your Amagi OneLogin account to access the alert dashboard.
          </p>

          {!authConfigured && (
            <div className="login-bypass-notice">
              <span className="bypass-dot" />
              Dev mode — OIDC not configured. Click Sign In to continue as dev@amagi.com.
            </div>
          )}

          <button
            className={`login-btn ${loading ? 'loading' : ''}`}
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="login-spinner" />
                Redirecting…
              </>
            ) : (
              <>
                <OneLoginIcon />
                Sign in with OneLogin
              </>
            )}
          </button>

          <p className="login-domain-note">
            Access restricted to <code>@amagi.com</code> accounts
          </p>
        </div>

        <div className="login-footer">
          Amagi TOC · Internal Tool
        </div>
      </div>
    </div>
  );
}

function OneLoginIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

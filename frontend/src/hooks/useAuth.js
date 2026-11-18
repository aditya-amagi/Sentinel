// useAuth.js — fetches current auth state from /auth/me
// Returns { user, loading, authenticated }
// Used by App.js to gate the entire UI

import { useState, useEffect } from 'react';

export function useAuth() {
  const [state, setState] = useState({ user: null, loading: true, authenticated: false });

  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        setState({
          user:          data.authenticated ? data : null,
          loading:       false,
          authenticated: !!data.authenticated,
          auth_configured: !!data.auth_configured,
        });
      })
      .catch(() => {
        setState({ user: null, loading: false, authenticated: false });
      });
  }, []);

  const logout = () => {
    window.location.href = '/auth/logout';
  };

  return { ...state, logout };
}

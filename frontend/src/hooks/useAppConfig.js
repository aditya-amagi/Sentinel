import { useEffect, useState } from 'react';

// Runtime flags from /api/demo-status, fetched once and shared by every component.
let cache = null;
let inflight = null;
const listeners = new Set();

function load() {
  if (!inflight) {
    inflight = fetch('/api/demo-status', { credentials: 'include' })
      .then(r => r.json())
      .catch(() => ({}))
      .then(d => {
        cache = { demo_mode: !!d.demo_mode, freshdesk_mock: !!d.freshdesk_mock,
          atom_live: !!d.atom_live, atom_writeback: !!d.atom_writeback };
        listeners.forEach(fn => fn(cache));
        return cache;
      });
  }
  return inflight;
}

export function useAppConfig() {
  const [cfg, setCfg] = useState(cache || { demo_mode: false, freshdesk_mock: false, atom_live: false, atom_writeback: false });
  useEffect(() => {
    listeners.add(setCfg);
    if (cache) setCfg(cache); else load();
    return () => listeners.delete(setCfg);
  }, []);
  return cfg;
}

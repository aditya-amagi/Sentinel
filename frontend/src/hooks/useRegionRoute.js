import { useState, useEffect } from 'react';

/**
 * Hash-based router:
 *   #/                       → { page:'dashboard', region:null }
 *   #/dashboard/apac         → { page:'dashboard', region:'APAC' }
 *   #/history                → { page:'history',   region:null }
 *   #/history/emea           → { page:'history',   region:'EMEA' }
 *   #/settings/contacts      → { page:'settings',  region:null }
 */
export function useRegionRoute() {
  const parse = () => {
    const hash  = window.location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);

    if (parts[0] === 'settings') return { page: 'settings', region: null, subpage: parts[1] || 'contacts' };
    if (parts[0] === 'history')  return { page: 'history',  region: parts[1]?.toUpperCase() || null };
    if (parts[0] === 'dashboard') return { page: 'dashboard', region: parts[1]?.toUpperCase() || null };
    return { page: 'dashboard', region: parts[0] ? parts[0].toUpperCase() : null };
  };

  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const h = () => setRoute(parse());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const navigate = (page, region, subpage) => {
    if (page === 'settings') {
      window.location.hash = `#/settings/${subpage || 'contacts'}`;
    } else if (page === 'history') {
      window.location.hash = region ? `#/history/${region.toLowerCase()}` : '#/history';
    } else {
      window.location.hash = region ? `#/dashboard/${region.toLowerCase()}` : '#/';
    }
  };

  return { ...route, navigate };
}

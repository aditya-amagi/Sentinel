import { useState, useEffect } from 'react';

/**
 * Hash-based router. `region` is an ATOM view group (EMEA, APAC, America, Enterprise Customer, …)
 * or a legacy region; matching is case-insensitive on the server. `family` narrows a view group to
 * Schedule / Asset / Live.
 *   #/                                → { page:'dashboard', region:null, family:null }
 *   #/dashboard/emea                  → { page:'dashboard', region:'emea' }
 *   #/dashboard/enterprise%20customer/schedule → { region:'enterprise customer', family:'schedule' }
 *   #/history/apac                    → { page:'history',   region:'apac' }
 *   #/settings/contacts               → { page:'settings' }
 */
const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };

export function useRegionRoute() {
  const parse = () => {
    const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(dec);
    if (parts[0] === 'settings') return { page: 'settings', region: null, family: null, subpage: parts[1] || 'contacts' };
    if (parts[0] === 'history')  return { page: 'history',  region: parts[1] || null, family: null };
    if (parts[0] === 'dashboard') return { page: 'dashboard', region: parts[1] || null, family: parts[2] || null };
    return { page: 'dashboard', region: parts[0] || null, family: null };
  };

  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const h = () => setRoute(parse());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const seg = s => encodeURIComponent(String(s).toLowerCase());
  const navigate = (page, region, family) => {
    if (page === 'settings') {
      window.location.hash = '#/settings/contacts';
    } else if (page === 'history') {
      window.location.hash = region ? `#/history/${seg(region)}` : '#/history';
    } else {
      window.location.hash = region ? `#/dashboard/${seg(region)}${family ? `/${seg(family)}` : ''}` : '#/';
    }
  };

  return { ...route, navigate };
}

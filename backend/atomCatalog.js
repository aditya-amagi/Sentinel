// atomCatalog.js — ATOM customer/feed catalog → atom_feeds.
// For each automation_url seen on alerts, GET /customers/{automation_url}?detailed=true and
// store every feed (name, timezone, broadcast start, headends + health). Only automations whose
// catalog is missing or older than ATOM_CATALOG_REFRESH_HOURS are fetched, so requests stay bounded.

'use strict';

const atomApi = require('./atomApi');
const db      = require('./db');

const REFRESH_HOURS = Number(process.env.ATOM_CATALOG_REFRESH_HOURS) || 6;
const MAX_PER_RUN   = Number(process.env.ATOM_CATALOG_MAX_PER_SYNC) || 300;
const CONCURRENCY   = 6;

/** Flatten a detailed customer record into atom_feeds rows. */
function feedsFromCustomer(customer, automation_url) {
  const rows = [];
  const dataOnly = customer?.data_only === true;
  for (const acct of customer?.accounts || []) {
    for (const f of acct.feeds || []) {
      if (!f.code) continue;
      const heads = f.headends || [];
      // Monitored = customer not data_only AND some headend has monitoring on.
      // No headend data at all → treat as monitored (fail open).
      const monitored = !dataOnly && (heads.length === 0 || heads.some(h => h.health?.monitoring === true));
      rows.push({
        data_only:            dataOnly ? 1 : 0,
        monitored:            monitored ? 1 : 0,
        feed_code:            f.code,
        feed_name:            f.name || null,
        automation_url:       acct.automation_url || customer.url || automation_url,
        customer_name:        customer.name || null,
        amg_id:               f.amg_id || acct.amg_id || null,
        account_domain:       acct.domain || null,
        time_zone:            f.time_zone || null,
        broadcast_start_time: f.broadcast_start_time || null,
        days_to_monitor:      f.days_to_monitor ?? customer.days_to_monitor ?? null,
        headends: (f.headends || []).map(h => ({
          code: h.code, name: h.name || null, active: h.active ?? null,
          time_zone: h.time_zone || null, health: h.health || null,
        })),
      });
    }
  }
  return rows;
}

/**
 * Refresh stale catalog entries. Never throws; returns { fetched, feeds, prefilled, errors }.
 * @param {string[]} [urls] explicit automation_urls (default: stale ones from the DB)
 */
async function syncCatalog(urls) {
  const out = { fetched: 0, feeds: 0, prefilled: 0, errors: [] };
  if (!atomApi.isLive()) return out;
  const candidates = urls
    ? [...new Set(urls.filter(Boolean))].filter(u => !db.automationSyncedWithin(u, REFRESH_HOURS))
    : db.getStaleAutomationUrls(REFRESH_HOURS);
  const queue = candidates.slice(0, MAX_PER_RUN);
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      try {
        const customer = await atomApi.getCustomer(url);
        out.fetched++;
        if (!customer) continue;
        for (const row of feedsFromCustomer(customer, url)) {
          db.upsertAtomFeed(row);
          out.feeds++;
          if (db.prefillCustomerName(row.feed_code, row.customer_name)) out.prefilled++;
        }
      } catch (err) {
        out.errors.push(`${url}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (out.errors.length) console.warn(`[catalog] ${out.errors.length} error(s): ${out.errors[0]}`);
  return out;
}

module.exports = { syncCatalog, feedsFromCustomer };

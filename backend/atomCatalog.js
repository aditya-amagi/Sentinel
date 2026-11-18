// atomCatalog.js — ATOM customer/feed catalog → atom_feeds.
// For each automation_url seen on alerts, GET /customers/{automation_url}?detailed=true and
// store every feed (name, timezone, broadcast start, headends + health). Only automations whose
// catalog is missing or older than ATOM_CATALOG_REFRESH_HOURS are fetched, so requests stay bounded.

'use strict';

const atomApi = require('./atomApi');
const db      = require('./db');

const REFRESH_HOURS = Number(process.env.ATOM_CATALOG_REFRESH_HOURS) || 6;
const MAX_PER_RUN   = 25;

/** Flatten a detailed customer record into atom_feeds rows. */
function feedsFromCustomer(customer, automation_url) {
  const rows = [];
  for (const acct of customer?.accounts || []) {
    for (const f of acct.feeds || []) {
      if (!f.code) continue;
      rows.push({
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
  const targets = candidates.slice(0, MAX_PER_RUN);
  for (const url of targets) {
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
  if (out.errors.length) console.warn(`[catalog] ${out.errors.length} error(s): ${out.errors[0]}`);
  return out;
}

module.exports = { syncCatalog, feedsFromCustomer };

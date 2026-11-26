#!/usr/bin/env node
// Capture a production ATOM snapshot from a Sentinel database for mock mode to replay.
//
//   node scripts/atomSnapshot.js [--from atom_dashboard.db] [--out data/atom_snapshot.json]
//
// Reads (read-only) the last view-based sync: every ATOM view, the alerts in the selected views
// (full raw payloads) with their view membership, and the feed catalog. Makes no network calls.
// The output contains real customer/feed data — it lives in backend/data/, which is git-ignored.

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const from = path.resolve(__dirname, '..', arg('--from', 'atom_dashboard.db'));
const out  = path.resolve(__dirname, '..', arg('--out', 'data/atom_snapshot.json'));

const db = new Database(from, { readonly: true, fileMustExist: true });

const views = db.prepare(`SELECT id, name, selected FROM atom_views ORDER BY id`).all()
  .map(v => ({ id: v.id, name: v.name, selected: !!v.selected }));
if (!views.length) { console.error('No ATOM views in this database — run a view-based sync against ATOM first.'); process.exit(1); }

const rows = db.prepare(`
  SELECT i.atom_issue_id AS id, i.atom_view_ids AS views, i.updated_at,
         (SELECT o.raw_payload FROM occurrences o WHERE o.atom_issue_id = i.atom_issue_id
            AND o.raw_payload LIKE '{%' ORDER BY o.id DESC LIMIT 1) AS raw
  FROM issues i WHERE i.atom_view_ids IS NOT NULL AND i.raw_type IS NOT NULL
  GROUP BY i.atom_issue_id`).all();

const alerts = [], membership = {};
let capturedAt = 0;
for (const r of rows) {
  let a; try { a = JSON.parse(r.raw); } catch { continue; }
  if (!a || a.alert_id == null) continue;
  alerts.push(a);
  membership[String(a.alert_id)] = String(r.views).split(',').filter(Boolean).map(Number);
  const t = Date.parse(String(r.updated_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(t) && t > capturedAt) capturedAt = t;
}

// Feed catalog → detailed customer records, as GET /customers/{url}?detailed=true returns them
const customers = {};
for (const f of db.prepare(`SELECT * FROM atom_feeds WHERE automation_url IS NOT NULL`).all()) {
  const c = customers[f.automation_url] ||= { name: f.customer_name, url: f.automation_url, data_only: !!f.data_only, accounts: {} };
  const acct = c.accounts[f.amg_id || f.account_domain || 'default'] ||= { amg_id: f.amg_id, domain: f.account_domain, automation_url: f.automation_url, feeds: [] };
  let headends = []; try { headends = JSON.parse(f.headends_json || '[]'); } catch {}
  acct.feeds.push({ code: f.feed_code, name: f.feed_name, time_zone: f.time_zone, broadcast_start_time: f.broadcast_start_time,
    days_to_monitor: f.days_to_monitor, headends });
}
for (const c of Object.values(customers)) c.accounts = Object.values(c.accounts);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ captured_at: new Date(capturedAt || Date.now()).toISOString(), views, alerts, membership, customers }), { mode: 0o600 });
console.log(`snapshot → ${out}`);
console.log(`  captured_at ${new Date(capturedAt).toISOString()} · ${views.length} views (${views.filter(v => v.selected).length} selected) · ${alerts.length} alerts · ${Object.keys(customers).length} automations`);

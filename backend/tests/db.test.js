'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Configure isolated test DB before requiring db.js
const TEST_DB = path.join(__dirname, 'test_sentinel.db');
process.env.DB_PATH = TEST_DB;

const db = require('../db');
const AT = require('../alertTypes');

describe('db module', () => {
  before(() => {
    // Ensure clean state
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db.getDb(); // trigger schema init
  });

  after(() => {
    // Clean up test DB
    try {
      db.getDb().close();
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
      if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
      if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    } catch {}
  });

  it('initializes schema and tables successfully', () => {
    const tables = db.getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    assert.ok(tables.includes('issues'));
    assert.ok(tables.includes('occurrences'));
    assert.ok(tables.includes('tickets'));
    assert.ok(tables.includes('playlist_timeline'));
    assert.ok(tables.includes('feed_ticket_config'));
    assert.ok(tables.includes('issue_contact_override'));
    assert.ok(tables.includes('freshdesk_tickets'));
    assert.ok(tables.includes('_schema_migrations'));

    const applied = db.getDb().prepare(`SELECT name FROM _schema_migrations`).all().map(r => r.name);
    assert.ok(applied.includes('001_initial_schema.sql'));
    assert.ok(applied.includes('002_contacts_and_freshdesk.sql'));
    assert.ok(applied.includes('003_state_and_persistence.sql'));
  });

  it('upserts issues with composite key (atom_issue_id, playlist_id)', () => {
    db.upsertIssue({
      atom_issue_id: 'ATOM-1001',
      playlist_id: '22262007',
      feed_code: 'BALP_APAC_HD',
      region: 'APAC',
      host: 'encoder-01.prod',
      account: 'amagi_apac',
      issue_type: AT.ALERT_ENUM.HOLE,
      consolidated_status: 'active',
      playlist_date: '2026-04-13',
      playlist_start_time: '2026-04-13T08:00:00Z',
      earliest_scheduled: '2026-04-13T08:00:00Z',
      status: 'open',
      penalty: 1,
      asset_id: 'FC_LovePetsPromo',
      state: 'penalty',
    });

    const res = db.getIssueByCompositeKey('ATOM-1001', '22262007');
    assert.ok(res);
    assert.equal(res.issue.feed_code, 'BALP_APAC_HD');
    assert.equal(res.issue.state, 'penalty');
    assert.equal(res.issue.issue_type, 'HOLE');

    // Updating same composite key preserves or updates fields
    db.upsertIssue({
      atom_issue_id: 'ATOM-1001',
      playlist_id: '22262007',
      feed_code: 'BALP_APAC_HD',
      region: 'APAC',
      host: 'encoder-01.prod',
      account: 'amagi_apac',
      issue_type: AT.ALERT_ENUM.HOLE,
      consolidated_status: 'resolved',
      playlist_date: '2026-04-13',
      playlist_start_time: '2026-04-13T08:00:00Z',
      earliest_scheduled: '2026-04-13T08:00:00Z',
      status: 'closed',
      penalty: 1,
      asset_id: 'FC_LovePetsPromo',
      state: 'penalty',
    });

    const updated = db.getIssueByCompositeKey('ATOM-1001', '22262007');
    assert.equal(updated.issue.consolidated_status, 'resolved');
  });

  it('inserts scoped occurrences and updates occurrence counts', () => {
    db.insertOccurrenceIfNotExists({
      atom_issue_id: 'ATOM-1001',
      playlist_id: '22262007',
      playlist_start_time: '2026-04-13T08:00:00Z',
      playout_start_time: '2026-04-13T08:15:00Z',
      duration: '30s',
      asset_id: 'FC_LovePetsPromo',
      feed_code: 'BALP_APAC_HD',
      region: 'APAC',
      playlist_date: '2026-04-13',
      issue_type: 'HOLE',
      raw_payload: JSON.stringify({ event: 1 }),
    });

    db.insertOccurrenceIfNotExists({
      atom_issue_id: 'ATOM-1001',
      playlist_id: '22262007',
      playlist_start_time: '2026-04-13T08:00:00Z',
      playout_start_time: '2026-04-13T08:45:00Z',
      duration: '60s',
      asset_id: 'FC_LovePetsPromo',
      feed_code: 'BALP_APAC_HD',
      region: 'APAC',
      playlist_date: '2026-04-13',
      issue_type: 'HOLE',
      raw_payload: JSON.stringify({ event: 2 }),
    });

    db.updateOccurrenceCount('ATOM-1001', '22262007');
    const res = db.getIssueByCompositeKey('ATOM-1001', '22262007');
    assert.equal(res.occurrences.length, 2);
    assert.equal(res.issue.occurrence_count, 2);
  });

  it('resolves contacts correctly across general, override, and internal settings', () => {
    // 1. Configure feed ticket settings for BALP_APAC_HD
    db.upsertFeedTicketConfig({
      feed_code: 'BALP_APAC_HD',
      customer_name: 'Blue Ant Media',
      product_version: '3.31',
      contact_email: 'ops@blueant.com',
      cc_emails: 'alerts@blueant.com, noc@blueant.com',
      use_general_for_all: 1,
    });

    // When use_general_for_all = 1
    const general = db.resolveContacts('BALP_APAC_HD', 'HOLE', 'customer');
    assert.equal(general.contact_email, 'ops@blueant.com');
    assert.equal(general.customer_name, 'Blue Ant Media');
    assert.deepEqual(general.cc_emails, ['alerts@blueant.com', 'noc@blueant.com']);

    // 2. Add override and enable it with use_general_for_all = 0
    db.upsertFeedTicketConfig({
      feed_code: 'BALP_APAC_HD',
      customer_name: 'Blue Ant Media',
      product_version: '3.31',
      contact_email: 'ops@blueant.com',
      cc_emails: 'alerts@blueant.com',
      use_general_for_all: 0,
    });

    db.upsertIssueOverride({
      feed_code: 'BALP_APAC_HD',
      issue_type: 'MISSING_IN_CLOUD',
      contact_email: 'playout-cloud@blueant.com',
      cc_emails: 'storage@blueant.com',
      enabled: 1,
    });

    const overridden = db.resolveContacts('BALP_APAC_HD', 'MISSING_IN_CLOUD', 'customer');
    assert.equal(overridden.contact_email, 'playout-cloud@blueant.com');
    assert.deepEqual(overridden.cc_emails, ['storage@blueant.com']);

    // An alert type without an override still falls back to general
    const fallback = db.resolveContacts('BALP_APAC_HD', 'HOLE', 'customer');
    assert.equal(fallback.contact_email, 'ops@blueant.com');

    // 3. Internal tickets ALWAYS route to internal address
    const internal = db.resolveContacts('BALP_APAC_HD', 'MISSING_IN_CLOUD', 'internal');
    assert.equal(internal.contact_email, 'amagisupportcontact@amagi.com');
    assert.equal(internal.customer_name, 'Internal - Amagi');
    assert.deepEqual(internal.cc_emails, []);
  });

  it('detects same-day previous tickets and flags persistence', () => {
    // Initial version 22262007 already created above
    // Create a ticket for it
    db.createTicket({
      atom_issue_id: 'ATOM-1001',
      playlist_id: '22262007',
      feed_code: 'BALP_APAC_HD',
      issue_type: 'HOLE',
      asset_id: 'FC_LovePetsPromo',
      ticket_number: 'INC-10001',
      ticket_link: 'https://freshdesk.test/ticket/10001',
    });

    // Now a newer playlist version 22262012 is published later on same day
    db.upsertIssue({
      atom_issue_id: 'ATOM-1002',
      playlist_id: '22262012',
      feed_code: 'BALP_APAC_HD',
      region: 'APAC',
      issue_type: 'HOLE',
      playlist_date: '2026-04-13',
      playlist_start_time: '2026-04-13T10:15:00Z',
      asset_id: 'FC_LovePetsPromo',
      state: 'penalty',
    });

    // Check persistence
    db.checkAndMarkPersistence(
      'ATOM-1002',
      '22262012',
      'BALP_APAC_HD',
      'HOLE',
      'FC_LovePetsPromo',
      '2026-04-13',
      '2026-04-13T10:15:00Z'
    );

    const check = db.getIssueByCompositeKey('ATOM-1002', '22262012');
    assert.equal(check.issue.has_previous_ticket_same_day, 1);
    assert.equal(check.issue.previous_ticket_id, 'INC-10001');
    assert.equal(check.issue.previous_playlist_id, '22262007');
  });

  it('builds formatted Freshdesk payload with HTML table', () => {
    const issue = {
      feed_code: 'BALP_APAC_HD',
      issue_type: 'HOLE',
      asset_id: 'FC_LovePetsPromo',
      playlist_id: '22262007',
      playlist_date: '2026-04-13',
      playlist_start_time: '2026-04-13T08:00:00Z',
    };

    const payload = db.buildFreshdeskPayload(issue, 'customer');
    assert.equal(payload.subject, 'TOC Alert [AM3] : Schedule Gap Detected - BALP_APAC_HD - 2026-04-13');
    assert.ok(payload.description.includes('Dear Blue Ant Media Team,'));
    assert.ok(payload.description.includes('<table border="1"'));
    assert.ok(payload.description.includes('FC_LovePetsPromo'));
    assert.ok(payload.description.includes('Amagi TOC Team'));
  });
});

// alertTypes.js — Single source of truth for the 4 fixed alert types.
// Used by backend (db.js, demoData.js, server.js) and served to frontend.
// Never import from different places — always import from here.

'use strict';

// ── Enum keys (stored in DB, used in API, used in overrides table) ────────────
const ALERT_ENUM = {
  HOLE:             'HOLE',
  NO_PLAYLIST:      'NO_PLAYLIST',
  DURATION_MISMATCH:'DURATION_MISMATCH',
  MISSING_IN_CLOUD: 'MISSING_IN_CLOUD',
};

// ── Display labels (shown in UI, ticket description) ─────────────────────────
const ALERT_LABEL = {
  HOLE:             'Hole in Playlist',
  NO_PLAYLIST:      'No Playlist',
  DURATION_MISMATCH:'Asset Duration Mismatch',
  MISSING_IN_CLOUD: 'Missing in Cloud (Production)',
};

// ── Subject-friendly strings (used in Freshdesk subject line) ────────────────
const ALERT_SUBJECT = {
  HOLE:             'Schedule Gap Detected',
  NO_PLAYLIST:      'No Playlist Published',
  DURATION_MISMATCH:'Asset Duration Mismatch',
  MISSING_IN_CLOUD: 'Asset Missing in Cloud',
};

// ── Ordered list for UI rendering (always same order) ────────────────────────
const ALERT_KEYS = [
  ALERT_ENUM.HOLE,
  ALERT_ENUM.NO_PLAYLIST,
  ALERT_ENUM.DURATION_MISMATCH,
  ALERT_ENUM.MISSING_IN_CLOUD,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Given a raw string from ATOM API or DB, return the canonical enum key. */
function toEnumKey(raw) {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[\s\-]+/g, '_');
  // Direct match
  if (ALERT_ENUM[s]) return s;
  // Fuzzy match map (ATOM may send different strings)
  const FUZZY = {
    'HOLE_IN_PLAYLIST':           ALERT_ENUM.HOLE,
    'PLAYLIST_HOLE':              ALERT_ENUM.HOLE,          // example type in prod ATOM docs
    'HOLE_IN_THE_PLAYLIST':       ALERT_ENUM.HOLE,
    'HOLE':                       ALERT_ENUM.HOLE,
    'SCHEDULE_GAP':               ALERT_ENUM.HOLE,
    'NO_PLAYLIST':                ALERT_ENUM.NO_PLAYLIST,
    'NO_PLAYLIST_PUBLISHED':      ALERT_ENUM.NO_PLAYLIST,
    'NO_PUBLISHED_PLAYLIST':      ALERT_ENUM.NO_PLAYLIST,   // real ATOM type (atom_syncer)
    'MISSING_PLAYLIST':           ALERT_ENUM.NO_PLAYLIST,
    'ASSET_DURATION_MISMATCH':    ALERT_ENUM.DURATION_MISMATCH,
    'DURATION_MISMATCH':          ALERT_ENUM.DURATION_MISMATCH,
    'MISSING_IN_CLOUD':           ALERT_ENUM.MISSING_IN_CLOUD,
    'MISSING_IN_CLOUD_(PRODUCTION)': ALERT_ENUM.MISSING_IN_CLOUD,
    'ASSET_MISSING':              ALERT_ENUM.MISSING_IN_CLOUD,
    'ASSET_MISSING_IN_CLOUD':     ALERT_ENUM.MISSING_IN_CLOUD,
  };
  return FUZZY[s] || null;
}

/** Humanise a raw ATOM type: "tarang_media_seq_stall_alert" → "Tarang Media Seq Stall". */
function humanize(raw) {
  if (!raw) return '';
  const words = String(raw).replace(/[_\-\s]+alert$/i, '').split(/[_\-\s]+/).filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Label for display (UI, description table). Non-TOC ATOM types are humanised. */
function label(enumKey) {
  return ALERT_LABEL[enumKey] || humanize(enumKey) || 'Unknown Issue';
}

/** Subject-friendly string for Freshdesk subject line. */
function subjectFriendly(enumKey) {
  return ALERT_SUBJECT[enumKey] || label(enumKey);
}

/** Build Freshdesk subject line. */
function buildSubject(enumKey, feed_code, playlist_date) {
  const friendly = subjectFriendly(enumKey);
  const date     = playlist_date || new Date().toISOString().split('T')[0];
  const feed     = feed_code || 'Unknown Feed';
  return `TOC Alert [AM3] : ${friendly} - ${feed} - ${date}`;
}

/** Validate that a value is a known enum key. */
function isValid(enumKey) {
  return Object.values(ALERT_ENUM).includes(enumKey);
}

module.exports = {
  ALERT_ENUM,
  ALERT_LABEL,
  ALERT_SUBJECT,
  ALERT_KEYS,
  toEnumKey,
  label,
  subjectFriendly,
  buildSubject,
  isValid,
  humanize,
};

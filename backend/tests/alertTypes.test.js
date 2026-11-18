'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AT = require('../alertTypes');

describe('alertTypes module', () => {
  it('defines the 4 canonical alert enums', () => {
    assert.deepEqual(AT.ALERT_KEYS, [
      'HOLE',
      'NO_PLAYLIST',
      'DURATION_MISMATCH',
      'MISSING_IN_CLOUD',
    ]);
  });

  it('validates canonical enum keys with isValid()', () => {
    assert.equal(AT.isValid('HOLE'), true);
    assert.equal(AT.isValid('NO_PLAYLIST'), true);
    assert.equal(AT.isValid('DURATION_MISMATCH'), true);
    assert.equal(AT.isValid('MISSING_IN_CLOUD'), true);
    assert.equal(AT.isValid('UNKNOWN_TYPE'), false);
    assert.equal(AT.isValid(''), false);
    assert.equal(AT.isValid(null), false);
  });

  it('normalizes raw ATOM strings via toEnumKey()', () => {
    // Exact matches
    assert.equal(AT.toEnumKey('HOLE'), 'HOLE');
    assert.equal(AT.toEnumKey('hole'), 'HOLE');
    assert.equal(AT.toEnumKey('NO_PLAYLIST'), 'NO_PLAYLIST');

    // Fuzzy matches
    assert.equal(AT.toEnumKey('HOLE_IN_PLAYLIST'), 'HOLE');
    assert.equal(AT.toEnumKey('SCHEDULE_GAP'), 'HOLE');
    assert.equal(AT.toEnumKey('Hole in Playlist'), 'HOLE');
    assert.equal(AT.toEnumKey('MISSING_PLAYLIST'), 'NO_PLAYLIST');
    assert.equal(AT.toEnumKey('NO_PLAYLIST_PUBLISHED'), 'NO_PLAYLIST');
    assert.equal(AT.toEnumKey('Asset Duration Mismatch'), 'DURATION_MISMATCH');
    assert.equal(AT.toEnumKey('MISSING_IN_CLOUD_(PRODUCTION)'), 'MISSING_IN_CLOUD');
    assert.equal(AT.toEnumKey('ASSET_MISSING_IN_CLOUD'), 'MISSING_IN_CLOUD');
    assert.equal(AT.toEnumKey('ASSET_MISSING'), 'MISSING_IN_CLOUD');

    // Unrecognized string
    assert.equal(AT.toEnumKey('COMPLETELY_RANDOM'), null);
    assert.equal(AT.toEnumKey(null), null);
    assert.equal(AT.toEnumKey(''), null);
  });

  it('returns appropriate display labels', () => {
    assert.equal(AT.label('HOLE'), 'Hole in Playlist');
    assert.equal(AT.label('NO_PLAYLIST'), 'No Playlist');
    assert.equal(AT.label('DURATION_MISMATCH'), 'Asset Duration Mismatch');
    assert.equal(AT.label('MISSING_IN_CLOUD'), 'Missing in Cloud (Production)');
    assert.equal(AT.label('CUSTOM_KEY'), 'Custom Key');
    assert.equal(AT.label('tarang_media_seq_stall_alert'), 'Tarang Media Seq Stall');
  });

  it('generates consistent Freshdesk subjects with buildSubject()', () => {
    const s1 = AT.buildSubject('HOLE', 'BALP_APAC_HD', '2026-04-13');
    assert.equal(s1, 'TOC Alert [AM3] : Schedule Gap Detected - BALP_APAC_HD - 2026-04-13');

    const s2 = AT.buildSubject('MISSING_IN_CLOUD', 'FAILARMY_US', '2026-04-14');
    assert.equal(s2, 'TOC Alert [AM3] : Asset Missing in Cloud - FAILARMY_US - 2026-04-14');

    const s3 = AT.buildSubject('NO_PLAYLIST', 'OCA_APAC_HD', '2026-04-15');
    assert.equal(s3, 'TOC Alert [AM3] : No Playlist Published - OCA_APAC_HD - 2026-04-15');
  });
});

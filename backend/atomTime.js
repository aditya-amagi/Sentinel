// atomTime.js — timezone helpers for ATOM feeds (broadcast day, local time, region).
// Pure functions, no dependencies (uses Intl, available in Node 18+).

'use strict';

function validTz(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Wall-clock parts of an instant in a timezone. */
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset (ms) of tz from UTC at the given instant. */
function tzOffset(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Convert a wall-clock time in tz to a UTC epoch ms (DST-safe to within the transition hour). */
function wallToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

/** Parse "06:00", "06:00:00" or an ISO datetime into minutes after midnight. */
function parseClock(v) {
  const m = String(v || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? h * 60 + mi : 0;
}

const pad = n => String(n).padStart(2, '0');

/**
 * Broadcast date (YYYY-MM-DD) of an instant for a feed whose broadcast day starts at
 * broadcastStart (local clock) in timeZone. Falls back to the UTC date.
 */
function broadcastDate(iso, timeZone, broadcastStart) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (!validTz(timeZone)) return new Date(ms).toISOString().slice(0, 10);
  const p = partsIn(ms, timeZone);
  let day = Date.UTC(p.y, p.m - 1, p.d);
  if (p.h * 60 + p.mi < parseClock(broadcastStart)) day -= 86400000;
  return new Date(day).toISOString().slice(0, 10);
}

/** UTC ISO instant at which the broadcast day containing `nowIso` ends. */
function endOfBroadcastDay(nowIso, timeZone, broadcastStart) {
  const now = Date.parse(nowIso) || Date.now();
  const tz  = validTz(timeZone) ? timeZone : 'UTC';
  const date = broadcastDate(new Date(now).toISOString(), tz, broadcastStart);
  const [y, m, d] = date.split('-').map(Number);
  const mins = parseClock(broadcastStart);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return new Date(wallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(),
    Math.floor(mins / 60), mins % 60, tz)).toISOString();
}

/** "2026-11-18 16:25 Asia/Kolkata" — local time label for display/tickets. */
function formatLocal(iso, timeZone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !validTz(timeZone)) return null;
  const p = partsIn(ms, timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)} ${timeZone}`;
}

/** Map an IANA timezone to a Sentinel region. */
function regionFromTimeZone(tz) {
  if (!tz) return null;
  const s = String(tz);
  if (/^(America|US|Canada|Brazil|Pacific\/Honolulu|Mexico)\b/.test(s)) return 'US';
  if (/^(Europe|Africa|Atlantic|GB|WET|CET|EET|MET)\b/.test(s))           return 'EMEA';
  if (/^(Asia|Australia|Pacific|Indian|Japan|Singapore|NZ)\b/.test(s))     return 'APAC';
  return null;
}

module.exports = { broadcastDate, endOfBroadcastDay, formatLocal, regionFromTimeZone, parseClock, validTz };

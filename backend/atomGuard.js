// atomGuard.js — protects ATOM from Sentinel: a global rate limiter and a circuit breaker.
//
// Every ATOM call goes through `guard.run(fn)`:
//   • Rate limit: at most `perMin` requests started in any rolling 60 s, at most `concurrency` in flight.
//   • Circuit breaker: after `threshold` consecutive failures that indicate ATOM is struggling
//     (timeouts, network errors, 5xx, 429), stop calling ATOM for a cool-down that doubles each time
//     (2 min → 4 → 8 … capped at 30 min). 429 honours Retry-After. A success closes the breaker.
//
// Pure and clock-injectable so it can be unit-tested without waiting.

'use strict';

class AtomPausedError extends Error {
  constructor(until, reason) {
    super(`ATOM calls paused until ${new Date(until).toISOString()} (${reason}) — protecting ATOM after repeated failures`);
    this.name = 'AtomPausedError';
    this.paused = true;
    this.until = until;
  }
}

function isOverloadSignal(err) {
  const s = err?.response?.status ?? err?.status;
  if (s === 429 || (s >= 500 && s <= 599)) return true;
  if (s) return false;                                   // other HTTP errors (401, 403, 404…) are not overload
  const code = err?.code || '';
  return /ECONNABORTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ERR_NETWORK|timeout/i.test(code + ' ' + (err?.message || ''));
}

function createGuard({
  perMin = 20, concurrency = 1, threshold = 3,
  baseCooldownMs = 2 * 60e3, maxCooldownMs = 30 * 60e3,
  now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const started = [];          // start timestamps within the last 60 s
  let inFlight = 0;
  let failures = 0;            // consecutive overload failures
  let trips = 0;               // consecutive breaker openings (for back-off growth)
  let pausedUntil = 0;
  let pauseReason = '';
  let total = 0;
  const waiters = [];

  const prune = () => { const cut = now() - 60e3; while (started.length && started[0] <= cut) started.shift(); };

  async function acquire() {
    for (;;) {
      if (pausedUntil > now()) throw new AtomPausedError(pausedUntil, pauseReason);
      prune();
      if (inFlight < concurrency && started.length < perMin) {
        inFlight++; started.push(now()); total++;
        return;
      }
      // Wait for a slot: either the oldest start leaves the 60 s window, or an in-flight call finishes
      const waitWindow = started.length >= perMin ? Math.max(5, started[0] + 60e3 - now()) : null;
      if (waitWindow != null && inFlight < concurrency) await sleep(waitWindow);
      else await new Promise(r => waiters.push(r));
    }
  }
  function release() {
    inFlight = Math.max(0, inFlight - 1);
    const w = waiters.shift();
    if (w) w();
  }

  function trip(reason, retryAfterMs) {
    trips++;
    const cool = retryAfterMs || Math.min(maxCooldownMs, baseCooldownMs * 2 ** (trips - 1));
    pausedUntil = now() + cool;
    pauseReason = reason;
    failures = 0;
    console.warn(`[atom] circuit open: pausing ATOM calls for ${Math.round(cool / 1000)} s (${reason})`);
    // wake everyone so they see the pause
    while (waiters.length) waiters.shift()();
  }

  async function run(fn) {
    await acquire();
    try {
      const out = await fn();
      failures = 0; trips = 0;
      return out;
    } catch (err) {
      if (isOverloadSignal(err)) {
        failures++;
        const status = err?.response?.status ?? err?.status;
        if (status === 429) {
          const ra = Number(err?.response?.headers?.['retry-after']);
          trip('ATOM returned 429 Too Many Requests', Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
        } else if (failures >= threshold) {
          trip(`${failures} consecutive failures, last: ${status || err.code || err.message}`);
        }
      }
      throw err;
    } finally {
      release();
    }
  }

  function info() {
    prune();
    return {
      limit_per_min: perMin, concurrency, used_last_min: started.length, in_flight: inFlight,
      total_requests: total, consecutive_failures: failures,
      paused_until: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null,
      pause_reason: pausedUntil > now() ? pauseReason : null,
    };
  }

  const isPaused = () => pausedUntil > now();

  return { run, info, isPaused };
}

module.exports = { createGuard, AtomPausedError, isOverloadSignal };

'use strict';

// Rate limiter + circuit breaker that protect ATOM (fake clock, no real waiting).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGuard, isOverloadSignal } = require('../atomGuard');

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
}
const fail = (status, code) => { const e = new Error(code || `HTTP ${status}`); if (status) e.response = { status, headers: {} }; if (code) e.code = code; return e; };

describe('atomGuard', () => {
  it('never starts more than perMin requests in any rolling minute', async () => {
    const c = clock();
    const g = createGuard({ perMin: 20, concurrency: 1, now: c.now, sleep: c.sleep });
    const starts = [];
    for (let i = 0; i < 45; i++) await g.run(async () => { starts.push(c.now()); });
    for (let i = 0; i < starts.length; i++) {
      const inWindow = starts.filter(t => t > starts[i] - 60e3 && t <= starts[i]).length;
      assert.ok(inWindow <= 20, `window ending at #${i} has ${inWindow}`);
    }
    assert.ok(starts.at(-1) - starts[0] >= 120e3, '45 calls at 20/min need at least 2 minutes');
  });

  it('keeps at most `concurrency` requests in flight', async () => {
    const g = createGuard({ perMin: 1000, concurrency: 2 });
    let live = 0, peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => g.run(async () => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5));
      live--;
    })));
    assert.equal(peak, 2);
  });

  it('opens the breaker after 3 overload failures and refuses calls while open', async () => {
    const c = clock();
    const g = createGuard({ perMin: 1000, threshold: 3, baseCooldownMs: 120e3, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 3; i++) await assert.rejects(g.run(async () => { throw fail(503); }));
    assert.equal(g.isPaused(), true);
    let called = false;
    await assert.rejects(g.run(async () => { called = true; }), /paused/);
    assert.equal(called, false, 'no request reaches ATOM while paused');
    c.advance(121e3);
    await g.run(async () => 'ok');
    assert.equal(g.isPaused(), false);
  });

  it('backs off longer each time it trips, capped', async () => {
    const c = clock();
    const g = createGuard({ perMin: 1000, threshold: 1, baseCooldownMs: 60e3, maxCooldownMs: 200e3, now: c.now, sleep: c.sleep });
    const pauses = [];
    for (let i = 0; i < 4; i++) {
      await assert.rejects(g.run(async () => { throw fail(null, 'ETIMEDOUT'); }));
      pauses.push(Date.parse(g.info().paused_until) - c.now());
      c.advance(pauses.at(-1) + 1);
    }
    assert.deepEqual(pauses, [60e3, 120e3, 200e3, 200e3]);
  });

  it('honours Retry-After on 429 and ignores ordinary 4xx', async () => {
    const c = clock();
    const g = createGuard({ perMin: 1000, threshold: 3, now: c.now, sleep: c.sleep });
    await assert.rejects(g.run(async () => { throw fail(404); }));
    await assert.rejects(g.run(async () => { throw fail(403); }));
    assert.equal(g.isPaused(), false);
    const e = fail(429); e.response.headers['retry-after'] = '90';
    await assert.rejects(g.run(async () => { throw e; }));
    assert.equal(Date.parse(g.info().paused_until) - c.now(), 90e3);
  });

  it('classifies overload signals', () => {
    assert.equal(isOverloadSignal(fail(500)), true);
    assert.equal(isOverloadSignal(fail(429)), true);
    assert.equal(isOverloadSignal(fail(null, 'ECONNABORTED')), true);
    assert.equal(isOverloadSignal(fail(401)), false);
  });
});

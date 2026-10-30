// -----------------------------------------------------------------------------
// The period of the readings on the real clock sped up 20 times (one "hour" of
// the interval shortened to 3 s): never faster than the interval, never a
// cycle late, for each source. The app is stopped in a `finally`: a failure
// never leaves a process running. And the schedule runs on the monotonic
// clock: a wall clock moved by NTP neither hastens nor delays a reading.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePeriod, realClock, spyOn, testClock } from './kit/clock.mjs';
import { HOUR, START, createWorld, tick } from './helpers/world.js';

const PERIOD = 3 * 3000;

test('real clock x20: one reading per interval, measured', async (t) => {
  const clock = realClock({ speed: 20 });
  let world;
  try {
    world = await createWorld(t, {
      clock,
      config: { refresh_interval: '3', categories: ['consumer'] },
      timings: { hourMs: 3000, requestGapMs: 1000 },
    });
    // The reading itself (a sped-up timer can fire a few ms early: the check
    // then finds nothing due and reads nothing, which is what is measured).
    const spy = spyOn(world.monitor, 'read', clock);
    const gaps = await measurePeriod(spy, { count: 4, period: PERIOD, max: PERIOD * 1.8 });
    assert.equal(gaps.length, 3);
    assert.ok(world.server.count('cpsc') >= 3);
  } finally {
    await world?.app.stop();
    clock.close();
  }
});

test('real clock x20: three sources, each read once per interval, one request at a time', async (t) => {
  const clock = realClock({ speed: 20 });
  let world;
  try {
    world = await createWorld(t, {
      clock,
      config: {
        refresh_interval: '3',
        vehicles: 'Honda, Civic, 2019',
        categories: ['consumer', 'food'],
      },
      timings: { hourMs: 3000, requestGapMs: 1000 },
    });
    const spy = spyOn(world.monitor, 'read', clock);
    // Three readings of each of the three feeds.
    await measurePeriod(
      { ...spy, calls: spy.calls },
      { count: 9, min: 0, max: PERIOD * 1.8, timeoutMs: (4 * PERIOD * 1.8) / 20 + 2000 },
    );
    const byFeed = new Map();
    for (const call of spy.calls) {
      const id = call.args[0].id;
      byFeed.set(id, [...(byFeed.get(id) ?? []), call.at]);
    }
    assert.deepEqual([...byFeed.keys()].sort(), ['cpsc', 'fda-food', 'vehicle:HONDA|CIVIC|2019']);
    for (const [id, times] of byFeed) {
      const gaps = times.slice(1).map((at, i) => at - times[i]);
      for (const gap of gaps) {
        assert.ok(gap >= PERIOD * 0.9 && gap <= PERIOD * 1.8, `${id}: gap ${Math.round(gap)}`);
      }
    }
    // One request at a time: never two in flight (the gap separates them).
    const all = spy.calls.map((c) => c.at).sort((a, b) => a - b);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i] - all[i - 1] >= 900, `requests ${Math.round(all[i] - all[i - 1])} ms apart`);
    }
  } finally {
    await world?.app.stop();
    clock.close();
  }
});

test('the wall clock jumping 6 h does not start a reading early', async (t) => {
  const base = testClock({ start: START });
  let jump = 0;
  const clock = {
    ...base,
    now: () => base.now() + jump,
    timers: base.timers,
    advance: base.advance,
  };
  const world = await createWorld(t, { clock, config: { categories: ['consumer'] } });
  await tick(world, 1);
  const requests = world.server.requests.length;
  jump = 6 * HOUR;
  await tick(world, HOUR);
  assert.equal(world.server.requests.length, requests);
  await tick(world, 5 * HOUR);
  assert.equal(world.server.requests.length, requests + 1);
});

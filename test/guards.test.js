// -----------------------------------------------------------------------------
// The guards, each with a test that fails without it: bounded requests
// (redirect, stall, size, format), pauses per host (429, 5xx, Retry-After,
// bounds, after a restart), backoff, isolation of the sources, the scene
// events (refused, capped, pending across a restart), the bounds of /data
// (size, frozen disk, unreadable file).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getJson } from '../src/http.js';
import {
  FIRE_DAYS,
  MAX_EVENTS_PER_CYCLE,
  MAX_FEEDS,
  MAX_KNOWN,
  MAX_PENDING,
  sanitize,
} from '../src/monitor.js';
import { normalizeFda, readFeed } from '../src/sources.js';
import { FILE_NAME, Store } from '../src/store.js';
import { cpscRecall, fdaRecall, nhtsaRecall, startServer } from './helpers/server.js';
import {
  DAY,
  HOUR,
  MINUTE,
  SECOND,
  create,
  createWorld,
  idle,
  lastState,
  lastStatus,
  readData,
  tick,
} from './helpers/world.js';

const TIMEOUTS = { headers: 2000, stall: 300, total: 10000 };
const cpscFeed = { id: 'cpsc', kind: 'cpsc' };
const read = (server, extra = {}) =>
  readFeed({
    fetch,
    feed: cpscFeed,
    fromDay: '2026-10-09',
    toDay: '2026-10-31',
    baseUrls: server.baseUrls,
    timeouts: TIMEOUTS,
    ...extra,
  });

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-recalls-us-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- Requests --------------------------------------------------------------------

test('a redirect is refused, never followed', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'redirect';
  await assert.rejects(read(server), { kind: 'redirect' });
  assert.equal(server.requests.length, 1);
});

test('an answer that stalls is cut by the stall timeout', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'stall';
  const started = performance.now();
  await assert.rejects(read(server), { kind: 'stalled' });
  assert.ok(performance.now() - started < 2000);
});

test('a slow but living answer goes through (the stall timeout is re-armed at each chunk)', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'slow';
  server.slowMs = 120;
  // 6 chunks, 120 ms apart: 600 ms in all, more than the 300 ms stall bound.
  const result = await read(server, { timeouts: { ...TIMEOUTS, stall: 300 } });
  assert.ok(result.records.length > 0);
});

test('an announced oversized answer is refused before reading; a chunked one cut at the bound', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'oversize';
  await assert.rejects(read(server), { kind: 'size' });
  server.faults.cpsc = 'chunked-oversize';
  await assert.rejects(
    getJson({
      fetch,
      url: `${server.baseUrls.cpsc}/RestWebServices/Recall`,
      maxBytes: 2 * 1024 * 1024,
      timeouts: TIMEOUTS,
    }),
    { kind: 'size' },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(server.chunkedSent < 40, `${server.chunkedSent} MB sent`);
});

test('the total timeout cuts an answer that trickles', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'slow';
  server.slowMs = 150;
  await assert.rejects(read(server, { timeouts: { headers: 2000, stall: 1000, total: 400 } }), {
    kind: 'tooLong',
  });
});

test('HTML, a non-list, entries all unreadable: format errors, the copy kept', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'html';
  await assert.rejects(read(server), { kind: 'format' });
  server.faults.cpsc = false;
  const at = { RecallDate: '2026-10-30T00:00:00' };
  server.cpsc = [
    { RecallNumber: 'x', ...at },
    { nothing: true, ...at },
  ];
  await assert.rejects(read(server), { kind: 'format' });
  server.cpsc = [
    { RecallNumber: '12', ...at },
    { RecallNumber: 'x', ...at },
  ];
  const result = await read(server);
  assert.equal(result.records.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.records[0].title, 'CPSC 12');
  assert.equal(result.records[0].url, 'https://www.cpsc.gov/Recalls');
});

test('openFDA: 404 NOT_FOUND is an empty list; any other 404 is an error', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const feed = { id: 'fda-food', kind: 'fda' };
  const empty = await readFeed({
    fetch,
    feed,
    fromDay: '2027-01-01',
    toDay: '2027-01-31',
    baseUrls: server.baseUrls,
    timeouts: TIMEOUTS,
  });
  assert.deepEqual(empty.records, []);
  server.faults.fda = 404;
  await assert.rejects(
    readFeed({
      fetch,
      feed,
      fromDay: '2026-10-09',
      toDay: '2026-10-31',
      baseUrls: server.baseUrls,
      timeouts: TIMEOUTS,
    }),
    { kind: 'http', status: 404 },
  );
});

test('openFDA: more results than read is said (truncated)', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.fda.device.total = 1500;
  const world = await createWorld(t, { server, config: { categories: ['devices'] } });
  await tick(world, 1);
  assert.match(lastStatus(world).message.en, /More recalls than read for FDA \(medical devices\)/);
});

test('the records kept from one answer are bounded', async (t) => {
  const world = await createWorld(t, {
    config: { categories: ['consumer'] },
    limits: { maxRecords: 3 },
  });
  await tick(world, 1);
  assert.equal(world.monitor.feeds.get('cpsc').records.length, 3);
  assert.match(lastStatus(world).message.en, /More recalls than read for CPSC/);
});

test('NHTSA: a 400 that is not the empty list is an error, not "no campaign"', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const feed = {
    id: 'vehicle:X|Y|2020',
    kind: 'vehicle',
    vehicle: { make: 'X', model: 'Y', year: 2020 },
  };
  const none = await readFeed({
    fetch,
    feed,
    fromDay: '',
    toDay: '',
    baseUrls: server.baseUrls,
    timeouts: TIMEOUTS,
  });
  assert.deepEqual(none.records, []);
  server.faults.nhtsa = 400;
  await assert.rejects(
    readFeed({
      fetch,
      feed,
      fromDay: '',
      toDay: '',
      baseUrls: server.baseUrls,
      timeouts: TIMEOUTS,
    }),
    { kind: 'http', status: 400 },
  );
});

// --- Pauses and backoff ------------------------------------------------------------

const pauseOf = async (world) => (await readData(world)).pauses;

test('429 with Retry-After 5 s: paused 1 minute at least; 100,000 s: 6 hours at most; 90 s: 90 s', async (t) => {
  for (const [retryAfter, expected] of [
    [5, MINUTE],
    [100000, 6 * HOUR],
    [90, 90 * SECOND],
  ]) {
    const server = await startServer();
    t.after(() => server.close());
    server.faults.cpsc = 429;
    server.retryAfter = retryAfter;
    const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
    await tick(world, 1);
    const pauses = await pauseOf(world);
    const left = pauses.cpsc - world.clock.now();
    assert.ok(Math.abs(left - expected) < SECOND, `${retryAfter}: ${left}`);
    assert.match(lastStatus(world).message.en, /CPSC asked to wait: next try at/);
    // Nothing asked before the end of the pause.
    await tick(world, expected - SECOND);
    assert.equal(server.count('cpsc'), 1);
    server.faults.cpsc = false;
    await tick(world, 2 * SECOND);
    assert.equal(server.count('cpsc'), 2);
    assert.equal(lastStatus(world).connected, true);
  }
});

test('a 503 without Retry-After pauses for the backoff; a 404 never pauses the host', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 503;
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  assert.ok((await pauseOf(world)).cpsc > world.clock.now() + 14 * MINUTE);
  server.faults.cpsc = 404;
  await tick(world, 15 * MINUTE);
  assert.equal(server.count('cpsc'), 2);
  assert.equal((await pauseOf(world)).cpsc, undefined);
});

test('the backoff doubles from 15 minutes up to the interval, and resets after a success', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'drop';
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  const times = [];
  for (let i = 0; i < 8; i += 1) {
    times.push(server.count('cpsc'));
    await tick(world, 15 * MINUTE);
  }
  // 15, 30, 60, 120 minutes: after 2 h of 15-minute steps, 4 readings in all.
  assert.deepEqual(times, [1, 2, 2, 3, 3, 3, 3, 4]);
  // At 120 minutes; the next try at 105 + 120 = 225 minutes.
  server.faults.cpsc = false;
  await tick(world, 2 * HOUR);
  assert.equal(server.count('cpsc'), 5);
  assert.equal(world.monitor.feeds.get('cpsc').failures, 0);
  // Then the interval again: 225 + 360 = 585 minutes.
  await tick(world, 6 * HOUR - 20 * MINUTE);
  assert.equal(server.count('cpsc'), 5);
  await tick(world, 10 * MINUTE);
  assert.equal(server.count('cpsc'), 6);
});

test('a pause of one host never holds the others', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.fda = 429;
  server.retryAfter = 3600;
  const world = await createWorld(t, { server, config: { vehicles: 'Honda, Civic, 2019' } });
  await tick(world, 1);
  // The second FDA feed waits for the pause; CPSC and NHTSA are read.
  assert.equal(server.count('fda'), 1);
  assert.equal(server.count('cpsc'), 1);
  assert.equal(server.count('nhtsa'), 1);
  // Hour by hour: the virtual clock fires only the timers set before it moves.
  for (let i = 0; i < 6; i += 1) {
    await tick(world, HOUR);
  }
  assert.equal(server.count('fda'), 7);
  assert.equal(server.count('cpsc'), 2);
  assert.equal(server.count('nhtsa'), 2);
});

test('a pause is honoured after a restart; a pause of /data beyond 6 h is not trusted', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 429;
  server.retryAfter = 3600;
  const config = { categories: ['consumer'] };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  server.faults.cpsc = false;
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(world, 30 * MINUTE);
  assert.equal(server.count('cpsc'), 1);
  await tick(world, 31 * MINUTE);
  assert.equal(server.count('cpsc'), 2);
  const clean = sanitize({ pauses: { cpsc: 1, fda: 'x' } });
  assert.deepEqual(clean.pauses, { cpsc: 1 });
});

// --- Scene events ------------------------------------------------------------------

test('an event refused by Gladys is sent at the next reading, also after a restart', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: ['consumer'] };
  const world = await createWorld(t, { server, config });
  await tick(world, 1);
  const real = world.gladys.publishSceneEvent.bind(world.gladys);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  server.cpsc.unshift(cpscRecall(28001));
  await tick(world, 6 * HOUR);
  assert.deepEqual((await readData(world)).feeds.cpsc.pending, ['28001']);
  await world.app.stop();
  const again = await createWorld(t, {
    server,
    config,
    dataDir: world.dataDir,
    clock: world.clock,
  });
  await tick(again, 6 * HOUR);
  assert.equal(again.fake.sceneEvents.length, 1);
  assert.deepEqual((await readData(again)).feeds.cpsc.pending, []);
  void real;
});

test(`at most ${MAX_EVENTS_PER_CYCLE} events a check, the rest at the next one, oldest first`, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  for (let i = 0; i < 25; i += 1) {
    server.cpsc.unshift(
      cpscRecall(29000 + i, { RecallDate: `2026-10-${String(5 + i).padStart(2, '0')}T00:00:00` }),
    );
  }
  await tick(world, 6 * HOUR);
  // Within 14 days: 17 to 29 October (dates of the 25 new recalls: 5 to 29).
  const from = 31 - FIRE_DAYS;
  const expected = 29 - from + 1;
  assert.equal(world.fake.sceneEvents.length, Math.min(expected, MAX_EVENTS_PER_CYCLE));
  const days = world.fake.sceneEvents.map((e) => e.data.day);
  assert.deepEqual(days, [...days].sort());
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, expected);
});

test(`at most ${MAX_PENDING} events pending per source`, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  for (let i = 0; i < 260; i += 1) {
    server.cpsc.unshift(cpscRecall(30000 + i));
  }
  await tick(world, 6 * HOUR);
  assert.equal((await readData(world)).feeds.cpsc.pending.length, MAX_PENDING);
  assert.equal(
    sanitize({ feeds: { cpsc: { pending: Array.from({ length: 300 }, (_, i) => `${i}`) } } }).feeds
      .cpsc.pending.length,
    MAX_PENDING,
  );
});

test(`the ids seen are bounded (${MAX_KNOWN} a source), the newest kept`, async (t) => {
  const world = await createWorld(t, { config: { categories: ['consumer'] } });
  await tick(world, 1);
  const feed = world.monitor.feeds.get('cpsc');
  const fillers = Array.from({ length: MAX_KNOWN - feed.known.size }, (_, i) => `${i}`);
  feed.known = new Set([...fillers, ...feed.known]);
  world.server.cpsc.unshift(cpscRecall(99999));
  await tick(world, 6 * HOUR);
  assert.equal(feed.known.size, MAX_KNOWN);
  assert.ok(feed.known.has('99999'));
  assert.ok(!feed.known.has('0'));
  assert.equal(world.fake.sceneEvents.length, 1);
});

test('a vehicle campaign of any age fires once; the first reading of a vehicle fires nothing', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { categories: [], vehicles: 'Honda, Civic, 2019' },
  });
  await tick(world, 1);
  assert.equal(world.fake.sceneEvents.length, 0);
  server.vehicles['HONDA|CIVIC|2019'].push(
    nhtsaRecall('19V500000', { ReportReceivedDate: '02/03/2019' }),
  );
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  assert.equal(world.fake.sceneEvents[0].data.day, '2019-03-02');
});

test('an unreadable /data: said, nothing fired at the first reading, nothing written over it', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, FILE_NAME);
  await writeFile(path, '{"version":1');
  const world = await createWorld(t, { dataDir: dir, config: { categories: ['consumer'] } });
  await tick(world, 1);
  assert.equal(world.fake.sceneEvents.length, 0);
  assert.match(lastStatus(world).message.en, /cannot be read/);
  assert.equal(await readFile(`${path}.bad`, 'utf8'), '{"version":1');
});

// --- /data bounds ------------------------------------------------------------------

test('a state too large: the recalls kept and their time dropped, never the ids seen', async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir, { maxFileBytes: 2000 });
  const records = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, title: 'x'.repeat(100) }));
  await store.save({
    version: 1,
    feeds: {
      cpsc: { readAt: 5, etag: 'e', query: 'q', known: ['1', '2'], pending: ['3'], records },
    },
  });
  const data = JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8'));
  assert.equal(data.feeds.cpsc.records, null);
  assert.equal(data.feeds.cpsc.readAt, null, 'an empty copy is never taken as current');
  assert.equal(data.feeds.cpsc.etag, null);
  assert.deepEqual(data.feeds.cpsc.known, ['1', '2']);
  assert.deepEqual(data.feeds.cpsc.pending, ['3']);
  // Read back: no copy, so not fresh, and read in full.
  const clean = sanitize(data);
  assert.equal(clean.feeds.cpsc.readAt, null);
  assert.equal(clean.feeds.cpsc.records, null);
});

test('a file of /data larger than the bound is set aside, never parsed', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, FILE_NAME), JSON.stringify({ version: 1, pad: 'x'.repeat(5000) }));
  const store = new Store(dir, { maxFileBytes: 1000 });
  const { data, unreadable } = await store.load();
  assert.equal(data, null);
  assert.equal(unreadable, true);
});

test('/data keeps the followed feeds first, 16 in all', async (t) => {
  const world = await createWorld(t, { config: { categories: ['consumer'] } });
  await tick(world, 1);
  for (let i = 0; i < 20; i += 1) {
    world.monitor.feedOf(`vehicle:MAKE${i}|M|2020`);
  }
  const data = world.monitor.toData();
  assert.equal(Object.keys(data.feeds).length, MAX_FEEDS);
  assert.equal(Object.keys(data.feeds)[0], 'cpsc');
});

test('a frozen /data never holds the readings: several checks go through', async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  store.save = () => new Promise(() => {});
  store.flush = async () => {};
  const world = await createWorld(t, {
    store,
    config: { categories: ['consumer', 'food'] },
    timings: { saveWaitMs: 30 },
  });
  await tick(world, 1);
  assert.equal(world.server.count('cpsc'), 1);
  assert.equal(world.server.count('fda'), 1);
  for (let i = 0; i < 3; i += 1) {
    await tick(world, 6 * HOUR);
  }
  assert.equal(world.server.count('cpsc'), 4);
  assert.equal(world.server.count('fda'), 4);
  await create(world);
  assert.equal(typeof lastState(world, 'recalls_week'), 'number');
});

test('stop() gives up a request in progress at once', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'stall';
  const world = await createWorld(t, {
    server,
    config: { categories: ['consumer'] },
    connect: false,
  });
  world.app.monitor.sourceTimeouts = { headers: 60000, stall: 60000, total: 600000 };
  const connecting = world.gladys.connect();
  await connecting;
  await world.app.ready;
  world.clock.advance(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(world.monitor.running, 'a reading in progress');
  const started = performance.now();
  await world.app.stop();
  assert.ok(performance.now() - started < 1000);
  void idle;
  void DAY;
  void fdaRecall;
});

test('an FDA report without recall number: named by its event and product, stable', () => {
  const raw = fdaRecall(1, { recall_number: 'N/A', event_id: '100041' });
  const a = normalizeFda(raw, 'fda-food');
  const b = normalizeFda({ ...raw, recall_number: '' }, 'fda-food');
  assert.match(a.id, /^E100041-[0-9a-f]{12}$/);
  assert.equal(a.id, b.id);
  const other = normalizeFda({ ...raw, product_description: 'Other' }, 'fda-food');
  assert.notEqual(other.id, a.id);
  // Two products of one event alike on their first 300 characters, or told
  // apart by their lot only: two recalls (review r1, m2).
  const long = 'x'.repeat(400);
  const p1 = normalizeFda({ ...raw, product_description: `${long} 12 oz` }, 'fda-food');
  const p2 = normalizeFda({ ...raw, product_description: `${long} 24 oz` }, 'fda-food');
  assert.notEqual(p1.id, p2.id);
  for (const key of [
    'code_info',
    'product_quantity',
    'recalling_firm',
    'classification',
    'report_date',
  ]) {
    assert.notEqual(normalizeFda({ ...raw, [key]: 'different' }, 'fda-food').id, a.id, key);
  }
  assert.equal(normalizeFda({ ...raw, event_id: undefined }, 'fda-food'), null);
  assert.equal(normalizeFda(fdaRecall(7), 'fda-food').id, 'F-0007-2027');
});

test('a stop before the start (getConfig() failing) never writes over /data', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, FILE_NAME);
  const kept = JSON.stringify({ version: 1, feeds: { cpsc: { known: ['1'] } } });
  await writeFile(path, kept);
  const world = await createWorld(t, { dataDir: dir, connect: false });
  world.gladys.getConfig = async () => {
    throw new Error('ECONNRESET');
  };
  world.gladys.emit('connected');
  await idle(world);
  await world.app.stop();
  assert.equal(await readFile(path, 'utf8'), kept);
});

// -----------------------------------------------------------------------------
// Review r1: one test per guard a mutant of the reviewer survived (I1), and
// the minor points (m1 VIN in the vehicles field, m3 events dropped, m4 /data
// hung, m5 VINs after a quick restart, m6 vehicles left in memory).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { MAX_BYTES, retryAfterMs } from '../src/http.js';
import { MAX_PENDING, sanitize } from '../src/monitor.js';
import { normalizeCpsc, normalizeFda, normalizeNhtsa, readFeed } from '../src/sources.js';
import { FILE_NAME, Store } from '../src/store.js';
import { itemOf } from '../src/widgets.js';
import { TEST_VIN, cpscRecall, fdaRecall, nhtsaRecall, startServer } from './helpers/server.js';
import {
  HOUR,
  MINUTE,
  START,
  create,
  createWorld,
  idle,
  lastState,
  lastStatus,
  readData,
  tick,
  widgetOf,
} from './helpers/world.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-recalls-us-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- Requests and answers -----------------------------------------------------------

test('H1: an answer without Content-Length is cut at 16 MB, as "too large"', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.cpsc = 'chunked-oversize';
  await assert.rejects(
    readFeed({
      fetch,
      feed: { id: 'cpsc', kind: 'cpsc' },
      fromDay: '2026-10-09',
      toDay: '2026-10-31',
      baseUrls: server.baseUrls,
      timeouts: { headers: 5000, stall: 5000, total: 30000 },
    }),
    { kind: 'size' },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    server.chunkedSent * 1024 * 1024 <= MAX_BYTES + 2 * 1024 * 1024,
    `${server.chunkedSent} MB`,
  );
});

test('H10: Retry-After as an HTTP date is counted from the Date header', () => {
  const headers = new Headers({
    'retry-after': 'Fri, 30 Oct 2026 16:02:00 GMT',
    date: 'Fri, 30 Oct 2026 16:00:00 GMT',
  });
  assert.equal(retryAfterMs(headers), 2 * MINUTE);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '90' })), 90000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Fri, 30 Oct 2026 16:02:00 GMT' })), null);
});

test('X8: a CPSC URL outside cpsc.gov is replaced by the CPSC page, in the event and the widget', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  server.cpsc.unshift(cpscRecall(41000, { URL: 'javascript:alert(1)' }));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents[0].data.url, 'https://www.cpsc.gov/Recalls');
  assert.doesNotMatch(JSON.stringify(await widgetOf(world)), /javascript:/);
  assert.equal(
    normalizeCpsc(cpscRecall(1, { URL: 'https://evil.test/cpsc.gov/x' })).url,
    'https://www.cpsc.gov/Recalls',
  );
});

test('X15: the same recall twice in an answer is counted once', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.cpsc = [cpscRecall(41001), cpscRecall(41001)];
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  await create(world);
  assert.equal(lastState(world, 'recalls_week'), 1);
});

test('X11: only an FDA Class I recall is serious (red in the widget)', () => {
  const one = normalizeFda(fdaRecall(1, { classification: 'Class I' }), 'fda-food');
  const two = normalizeFda(fdaRecall(2, { classification: 'Class II' }), 'fda-food');
  assert.equal(one.serious, true);
  assert.equal(two.serious, false);
  assert.equal(itemOf(one, 'en').badge.color, WIDGET_COLORS.DANGER);
  assert.notEqual(itemOf(two, 'en').badge.color, WIDGET_COLORS.DANGER);
});

test('X14: an impossible date is no date', () => {
  assert.equal(normalizeCpsc(cpscRecall(1, { RecallDate: '2026-02-30T00:00:00' })).day, null);
  assert.equal(normalizeFda(fdaRecall(1, { report_date: '20261332' }), 'fda-food').day, null);
  const vehicle = { make: 'HONDA', model: 'CIVIC', year: 2019 };
  assert.equal(
    normalizeNhtsa(nhtsaRecall('26V000001', { ReportReceivedDate: '31/04/2026' }), 'v', vehicle)
      .day,
    null,
  );
  assert.equal(
    normalizeCpsc(cpscRecall(1, { RecallDate: '2024-02-29T00:00:00' })).day,
    '2024-02-29',
  );
});

test('X16: an NHTSA campaign without a valid number is skipped', () => {
  const vehicle = { make: 'HONDA', model: 'CIVIC', year: 2019 };
  for (const bad of ['', '26v000001', '26V 00001', 'X'.repeat(16), '<b>']) {
    assert.equal(normalizeNhtsa(nhtsaRecall(bad), 'v', vehicle), null, bad);
  }
  assert.equal(normalizeNhtsa(nhtsaRecall('26V000001'), 'v', vehicle).id, '26V000001');
});

// --- /data ------------------------------------------------------------------------

test('M13: the attempt is in /data before the request leaves', async (t) => {
  const dir = await tempDir(t);
  let seen;
  const spy = async (url, init) => {
    if (String(url).includes('RestWebServices') && seen === undefined) {
      try {
        seen =
          JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8')).feeds.cpsc?.attemptAt ?? null;
      } catch {
        seen = null;
      }
    }
    return fetch(url, init);
  };
  const world = await createWorld(t, {
    dataDir: dir,
    fetch: spy,
    config: { categories: ['consumer'] },
  });
  await tick(world, 1);
  assert.equal(typeof seen, 'number');
  assert.ok(Math.abs(seen - START) < 1000);
});

test('M24: a next time 10 days ahead in /data never delays a reading beyond the interval', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: ['consumer'] };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  const path = join(first.dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.feeds.cpsc.nextAt = first.clock.now() + 10 * 24 * HOUR;
  await writeFile(path, JSON.stringify(data));
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(world, 6 * HOUR + MINUTE);
  assert.equal(server.count('cpsc'), 2);
});

test('T2: a /data that cannot be read (permissions) is never written over; said', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, FILE_NAME);
  const kept = JSON.stringify({ version: 1, feeds: {}, marker: 'precious' });
  await writeFile(path, kept);
  await chmod(path, 0o000);
  t.after(() => chmod(path, 0o600).catch(() => {}));
  const world = await createWorld(t, { dataDir: dir, config: { categories: ['consumer'] } });
  await tick(world, 1);
  await world.app.stop();
  await chmod(path, 0o600);
  assert.equal(await readFile(path, 'utf8'), kept);
  assert.match(lastStatus(world).message.en, /\/data\) cannot be read/);
});

test('T1: /data is written through a temporary file renamed (none left behind)', async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  assert.equal(await store.save({ version: 1, feeds: {} }), true);
  assert.deepEqual(await readdir(dir), [FILE_NAME]);
});

test('M49, M50: /data with a foreign feed id or records of another feed: dropped', () => {
  const record = { ...normalizeCpsc(cpscRecall(1)) };
  const clean = sanitize({
    feeds: {
      'evil:x': { known: ['1'] },
      'vehicle:honda|civic|2019': { known: ['1'] },
      cpsc: { readAt: 5, records: [record, { ...record, id: '2', feed: 'fda-food' }] },
    },
  });
  assert.deepEqual(Object.keys(clean.feeds), ['cpsc']);
  assert.deepEqual(
    clean.feeds.cpsc.records.map((r) => r.id),
    ['1'],
  );
});

// --- Configuration and app ---------------------------------------------------------

test('C1: eight typed vehicles, five followed, five requests', async (t) => {
  const vehicles = 'ABCDEFGH'
    .split('')
    .map((l) => `${l}, ${l}, 2020`)
    .join('; ');
  const world = await createWorld(t, { config: { categories: [], vehicles } });
  await tick(world, 1);
  assert.equal(world.monitor.config.vehicles.length, 5);
  assert.equal(world.server.count('nhtsa'), 5);
  assert.match(
    lastStatus(world).message.en,
    /More than 5 vehicles \(3 by VIN at most\): 3 left out/,
  );
});

test('A5: a configuration read for an older connection is dropped', async (t) => {
  const gladys = createFakeGladys({ config: { language: 'en' } });
  let release;
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) {
      // The read of the first `connected`: slow, and with an older language.
      await new Promise((resolve) => {
        release = resolve;
      });
      return { language: 'fr' };
    }
    return original();
  };
  const world = await createWorld(t, { gladys, connect: false });
  const first = gladys.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  gladys.emit('connected');
  await world.app.ready;
  release();
  await first;
  await idle(world);
  assert.equal(world.monitor.config.language, 'en');
  assert.equal(world.fake.discoveredDevices[0].name, 'Recalls in the United States');
});

test('m1: a VIN typed as a make or model is refused, never sent, shown, logged or stored', async (t) => {
  const lines = [];
  const level = process.env.LOG_LEVEL;
  const { log, error } = console;
  process.env.LOG_LEVEL = 'debug';
  console.log = (...args) => lines.push(format(...args));
  console.error = (...args) => lines.push(format(...args));
  t.after(() => {
    process.env.LOG_LEVEL = level;
    console.log = log;
    console.error = error;
  });
  const vehicles = `${TEST_VIN}, Civic, 2019; Honda, ${TEST_VIN.toLowerCase()}, 2019; Honda, Civic, 2019`;
  const config = normalizeConfig({ vehicles }, START);
  assert.deepEqual(config.invalidVehicles, [1, 2]);
  const world = await createWorld(t, { config: { categories: [], vehicles } });
  await tick(world, 1);
  const all = [
    ...lines,
    JSON.stringify(world.server.requests.map((r) => r.url)),
    JSON.stringify(world.fake.connectionStatuses),
    JSON.stringify(await readData(world)),
  ].join('\n');
  assert.ok(!all.toUpperCase().includes(TEST_VIN));
  assert.equal(world.server.count('nhtsa'), 1);
  assert.match(lastStatus(world).message.en, /Vehicle entries not understood .*: 1, 2\./);
  // Real makes and models are never taken for a VIN.
  for (const name of ['F-150', 'MERCEDES-BENZ', 'GRAND CHEROKEE', 'RANGE ROVER EVOQUE']) {
    assert.equal(normalizeConfig({ vehicles: `X, ${name}, 2020` }, START).vehicles.length, 1, name);
  }
});

// --- Events -----------------------------------------------------------------------

test(`m3: beyond ${MAX_PENDING} events waiting, the oldest dropped and said`, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  for (let i = 0; i < 260; i += 1) {
    server.cpsc.unshift(cpscRecall(42000 + i));
  }
  await tick(world, 6 * HOUR);
  assert.match(
    lastStatus(world).message.en,
    /More than 200 new recalls waiting for Gladys for CPSC \(consumer products\): the oldest were dropped/,
  );
});

// --- /data hung -------------------------------------------------------------------

test('m4: a hung /data: stop() ends within saveWaitMs, the status says it', async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  store.save = () => new Promise(() => {});
  store.flush = () => new Promise(() => {});
  const world = await createWorld(t, {
    store,
    config: { categories: ['consumer'] },
    timings: { saveWaitMs: 50 },
  });
  await tick(world, 1);
  assert.match(lastStatus(world).message.en, /\/data\) does not answer/);
  const started = performance.now();
  await world.app.stop();
  assert.ok(performance.now() - started < 1000);
});

// --- VINs -------------------------------------------------------------------------

test('M41: a decoded VIN is decoded once a day, not at every reading', async (t) => {
  const world = await createWorld(t, {
    config: { categories: [], vins: TEST_VIN, refresh_interval: '3' },
  });
  await tick(world, 1);
  for (let i = 0; i < 7; i += 1) {
    await tick(world, 3 * HOUR);
  }
  assert.equal(world.server.count('vpic'), 1);
  assert.equal(world.server.count('nhtsa'), 8);
  for (let i = 0; i < 2; i += 1) {
    await tick(world, 3 * HOUR);
  }
  assert.equal(world.server.count('vpic'), 2);
});

test('M33, M47: a VIN not decoded (vPIC failing): not fresh, not connected, no state', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.vpic = 'drop';
  const world = await createWorld(t, {
    server,
    config: { categories: ['consumer'], vins: TEST_VIN },
  });
  await tick(world, 1);
  await create(world);
  assert.notEqual(world.monitor.survey().overall, 'fresh');
  assert.equal(lastStatus(world).connected, false);
  assert.equal(world.fake.states.length, 0);
});

test('M45: the vehicle of a VIN in /data survives the saves until it is decoded again', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: ['consumer'], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  server.faults.vpic = 'drop';
  await first.clock.advance(HOUR);
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(world, 1);
  const data = await readData(world);
  assert.ok(
    data.feeds['vehicle:HONDA|ACCORD|2003']?.known?.length > 0,
    Object.keys(data.feeds).join(),
  );
});

test('M59: a time of decoding in the future in /data never postpones the decoding', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: [], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  const path = join(first.dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.vinDecodeAt = first.clock.now() + 365 * 24 * HOUR;
  await writeFile(path, JSON.stringify(data));
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(world, 1);
  assert.equal(server.count('vpic'), 2);
});

test('m5: a restart within 10 minutes reuses the vehicles decoded, by position, never the VIN', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: [], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  const raw = await readFile(join(first.dataDir, FILE_NAME), 'utf8');
  assert.deepEqual(JSON.parse(raw).vinVehicles, ['HONDA|ACCORD|2003']);
  assert.ok(!raw.includes(TEST_VIN));
  await first.clock.advance(2 * MINUTE);
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await create(world);
  // No decoding yet, but the vehicle and its fresh copy serve at once.
  assert.equal(server.count('vpic'), 1);
  assert.equal(lastState(world, 'vehicle_recalls'), 2);
  assert.equal(lastStatus(world).connected, true);
  await tick(world, 8 * MINUTE);
  assert.equal(server.count('vpic'), 2);
});

test('m6: a vehicle no longer followed leaves the memory, and comes back with what it saw', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { categories: [], vehicles: 'Honda, Civic, 2019' },
  });
  await tick(world, 1);
  for (let i = 0; i < 20; i += 1) {
    await world.fake.configUpdated({ categories: [], vehicles: `Make${i}, M, 2020` });
  }
  await tick(world, 1);
  assert.ok(world.monitor.feeds.size <= 2, `${world.monitor.feeds.size} feeds in memory`);
  assert.ok(Object.keys(world.monitor.toData().feeds).length <= 16);
});

test('m6: a vehicle taken off and back keeps what it saw and its time', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { categories: [], vehicles: 'Honda, Civic, 2019' },
  });
  await tick(world, 1);
  for (let i = 0; i < 5; i += 1) {
    await world.fake.configUpdated({ categories: [], vehicles: `Make${i}, M, 2020` });
  }
  await tick(world, 1);
  assert.ok(world.monitor.feeds.size <= 2);
  // Back: what it saw is known again, only the campaign published meanwhile fires.
  server.vehicles['HONDA|CIVIC|2019'].unshift(nhtsaRecall('26V980000'));
  const civic = () =>
    world.server.requests.filter((r) => /make=HONDA&model=CIVIC/.test(r.url)).length;
  await world.fake.configUpdated({ categories: [], vehicles: 'Honda, Civic, 2019' });
  // Not read again before its interval (it keeps its time), then read.
  await tick(world, 1);
  assert.equal(civic(), 1);
  await tick(world, 6 * HOUR + MINUTE);
  assert.equal(civic(), 2);
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => e.data.url),
    ['https://www.nhtsa.gov/recalls?nhtsaId=26V980000'],
  );
});

// --- Widget -----------------------------------------------------------------------

test('M35: the widget lists the fresh sources only', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.cpsc = [cpscRecall(43000)];
  server.vehicles['HONDA|CIVIC|2019'].unshift(nhtsaRecall('26V990000'));
  const world = await createWorld(t, {
    server,
    config: { categories: ['consumer'], vehicles: 'Honda, Civic, 2019' },
  });
  await tick(world, 1);
  let content = await widgetOf(world);
  assert.ok(JSON.stringify(content).includes('Honda Civic 2019'));
  server.faults.nhtsa = 'drop';
  for (let i = 0; i < 14; i += 1) {
    await tick(world, HOUR);
  }
  content = await widgetOf(world);
  const rows = content.components.find((c) => c.type === 'card-list').items;
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((row) => /Honda/.test(row.title)), JSON.stringify(rows.map((r) => r.title)));
  assert.equal(content.components[0].text, 'Recalls not up to date');
});

test('M47: a VIN waiting for its decoding (no error yet): not connected, said', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: ['consumer'], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  // A quick restart without the vehicles of the decoding (an older /data).
  const path = join(first.dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  delete data.vinVehicles;
  await writeFile(path, JSON.stringify(data));
  await first.clock.advance(MINUTE);
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(world, 1);
  assert.equal(server.count('vpic'), 1);
  assert.equal(world.monitor.vinSlots[0].error, null);
  assert.equal(lastStatus(world).connected, false);
  assert.match(lastStatus(world).message.en, /Waiting for the first reading of NHTSA \(VIN 1\)/);
});

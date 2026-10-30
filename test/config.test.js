// -----------------------------------------------------------------------------
// The configuration: parsing (vehicles, VINs, keywords), the queue of the
// configurations saved back to back (the last wins, a failing one never
// blocks the next), getConfig() failing in `connected`, the reconnection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CONFIG_RETRY_MAX_MS, CONFIG_RETRY_MS } from '../src/app.js';
import {
  MAX_KEYWORDS,
  normalizeConfig,
  parseKeywords,
  parseVehicles,
  parseVins,
} from '../src/config.js';
import { testClock } from './kit/clock.mjs';
import { TEST_VIN, TEST_VIN_2, startServer } from './helpers/server.js';
import {
  HOUR,
  MINUTE,
  START,
  create,
  createWorld,
  idle,
  lastState,
  readData,
  tick,
} from './helpers/world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('vehicles: "make, model, year", separated by semicolons or lines; the bad ones by position', () => {
  const { vehicles, invalid } = parseVehicles(
    'Honda, Civic, 2019; ford ,  f-150 , 2021\nToyota Corolla 2020; Kia, Rio, 1890; Kia, Rio, 2029;; Honda, CIVIC, 2019; A, <b>, 2020',
    2028,
  );
  assert.deepEqual(vehicles, [
    { make: 'HONDA', model: 'CIVIC', year: 2019 },
    { make: 'FORD', model: 'F-150', year: 2021 },
  ]);
  assert.deepEqual(invalid, [3, 4, 5, 7]);
});

test('VINs: 17 characters without I, O, Q; the bad ones by position, never repeated', () => {
  const { vins, invalid } = parseVins(
    `${TEST_VIN.toLowerCase()}, 1HGCM82633A00435, ${TEST_VIN}; 1HGCM82633A0O4352 ${TEST_VIN_2}`,
  );
  assert.deepEqual(vins, [TEST_VIN, TEST_VIN_2]);
  assert.deepEqual(invalid, [2, 4]);
});

test('five vehicles in all, three by VIN at most; the rest counted as left out', () => {
  const typed = Array.from({ length: 4 }, (_, i) => `Honda, Civic, ${2010 + i}`).join(';');
  const config = normalizeConfig({ vehicles: typed, vins: `${TEST_VIN}, ${TEST_VIN_2}` }, START);
  assert.equal(config.vehicles.length, 4);
  assert.deepEqual(config.vins, [TEST_VIN]);
  assert.equal(config.droppedVehicles, 1);
  const vins = normalizeConfig(
    { vins: `${TEST_VIN} ${TEST_VIN_2} 1G1ZT53826F109149 2T1BURHE0JC034565` },
    START,
  );
  assert.equal(vins.vins.length, 3);
  assert.equal(vins.droppedVehicles, 1);
});

test('model years up to two years ahead of the calendar', () => {
  assert.equal(normalizeConfig({ vehicles: 'Honda, Civic, 2028' }, START).vehicles.length, 1);
  assert.equal(normalizeConfig({ vehicles: 'Honda, Civic, 2029' }, START).vehicles.length, 0);
});

test(`at most ${MAX_KEYWORDS} words, folded`, () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(', ');
  assert.equal(parseKeywords(words).length, MAX_KEYWORDS);
  assert.deepEqual(parseKeywords(' Crème-Brûlée ; IKEA,,ikea'), ['creme brulee', 'ikea']);
});

test('defaults: consumer, food and drugs; 6 h; English', () => {
  const config = normalizeConfig({}, START);
  assert.deepEqual(config.categories, ['consumer', 'food', 'drugs']);
  assert.equal(config.refreshHours, 6);
  assert.equal(config.language, 'en');
  assert.deepEqual(normalizeConfig({ categories: ['devices', 'x'] }, START).categories, [
    'devices',
  ]);
});

test('configurations saved back to back: applied in order, the last wins (slow first)', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  const real = world.gladys.publishDiscoveredDevices.bind(world.gladys);
  let calls = 0;
  world.gladys.publishDiscoveredDevices = async (...args) => {
    calls += 1;
    if (calls === 1) {
      await sleep(80);
    }
    return real(...args);
  };
  const first = world.fake.configUpdated({ language: 'fr', keywords: 'zzzz' });
  await sleep(10);
  const second = world.fake.configUpdated({ language: 'en' });
  await Promise.all([first, second]);
  await idle(world);
  assert.equal(world.monitor.config.language, 'en');
  assert.deepEqual(world.monitor.config.keywords, []);
  assert.ok(lastState(world, 'recalls_week') > 0, 'never 0 from a configuration applied late');
  assert.equal(world.fake.discoveredDevices[0].name, 'Recalls in the United States');
});

test('a configuration whose application fails never blocks the next ones', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  const real = world.gladys.publishDiscoveredDevices.bind(world.gladys);
  let calls = 0;
  world.gladys.publishDiscoveredDevices = async (...args) => {
    calls += 1;
    if (calls === 1) {
      throw new Error('HTTP 500');
    }
    return real(...args);
  };
  await world.fake.configUpdated({ language: 'fr' }).catch(() => {});
  await world.fake.configUpdated({ language: 'en', keywords: 'ikea' });
  await idle(world);
  assert.equal(world.monitor.config.language, 'en');
  assert.deepEqual(world.monitor.config.keywords, ['ikea']);
});

test('a new category is read at once; one taken off and back is not read again before its time', async (t) => {
  const world = await createWorld(t, { config: { categories: ['consumer'] } });
  await tick(world, 1);
  assert.equal(world.server.count('fda'), 0);
  await world.fake.configUpdated({ categories: ['consumer', 'food'] });
  await tick(world, 1);
  assert.equal(world.server.count('fda'), 1);
  assert.equal(world.server.count('cpsc'), 1);
  await world.fake.configUpdated({ categories: ['consumer'] });
  await world.fake.configUpdated({ categories: ['consumer', 'food'] });
  await tick(world, HOUR);
  assert.equal(world.server.count('fda'), 1);
});

test('a new interval: the next reading follows it, and so does /data', async (t) => {
  const world = await createWorld(t, { config: { refresh_interval: '24' } });
  await tick(world, 1);
  await world.fake.configUpdated({ refresh_interval: '3' });
  await tick(world, 1);
  const data = await readData(world);
  const { attemptAt, nextAt } = data.feeds.cpsc;
  assert.ok(Math.abs(nextAt - attemptAt - 3 * HOUR) < 1000, `${nextAt - attemptAt}`);
  await tick(world, 3 * HOUR);
  assert.equal(world.server.count('cpsc'), 2);
});

test('getConfig() failing in `connected` is tried again until it works, status said', async (t) => {
  const gladys = createFakeGladys({ config: {} });
  let calls = 0;
  const failing = new Set([2, 3]);
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (failing.has(calls)) {
      throw new Error(`ECONNRESET ${TEST_VIN}`);
    }
    return original();
  };
  const world = await createWorld(t, { gladys, connect: false });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration/);
  assert.deepEqual(gladys.fake.discoveredDevices, []);
  await tick(world, CONFIG_RETRY_MS);
  assert.deepEqual(gladys.fake.discoveredDevices, [], 'second failure');
  await tick(world, 2 * CONFIG_RETRY_MS);
  await world.app.ready;
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  await tick(world, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // At a reconnection too.
  failing.add(calls + 2);
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await tick(world, CONFIG_RETRY_MS);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('getConfig() retried 5 s, then doubled, capped at 5 minutes', async (t) => {
  const gladys = createFakeGladys({ config: {} });
  const clock = testClock({ start: START });
  const times = [];
  gladys.getConfig = async () => {
    times.push(clock.monotonic());
    throw new Error('ECONNRESET');
  };
  const world = await createWorld(t, { gladys, clock, connect: false });
  gladys.emit('connected');
  await idle(world);
  for (let i = 0; i < 9; i += 1) {
    await tick(world, CONFIG_RETRY_MAX_MS);
  }
  const gaps = times.slice(1).map((at, i) => Math.round((at - times[i]) / 1000) * 1000);
  assert.deepEqual(gaps.slice(0, 7), [
    CONFIG_RETRY_MS,
    2 * CONFIG_RETRY_MS,
    4 * CONFIG_RETRY_MS,
    8 * CONFIG_RETRY_MS,
    16 * CONFIG_RETRY_MS,
    32 * CONFIG_RETRY_MS,
    CONFIG_RETRY_MAX_MS,
  ]);
});

test('a reconnection applies the configuration changed while Gladys was away, reads nothing again', async (t) => {
  const world = await createWorld(t, { config: { refresh_interval: '24' } });
  await tick(world, 1);
  await create(world);
  const requests = world.server.requests.length;
  await world.gladys.disconnect();
  world.fake.config = { refresh_interval: '12', keywords: 'zzzz' };
  await world.gladys.connect();
  await idle(world);
  assert.equal(world.monitor.config.refreshHours, 12);
  assert.deepEqual(world.monitor.config.keywords, ['zzzz']);
  assert.equal(lastState(world, 'recalls_week'), 0);
  assert.equal(world.server.requests.length, requests);
  await tick(world, 12 * HOUR - MINUTE);
  assert.equal(world.server.requests.length, requests);
  await tick(world, 2 * MINUTE);
  assert.equal(world.server.requests.length, requests + 3);
});

test('a late getConfig() of a reconnection never overwrites a configuration saved meanwhile', async (t) => {
  const gladys = createFakeGladys({ config: { language: 'en' } });
  const world = await createWorld(t, { gladys });
  await tick(world, 1);
  const original = gladys.getConfig.bind(gladys);
  let release;
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    const config = structuredClone(await original());
    if (calls === 2) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return config;
  };
  await gladys.disconnect();
  const reconnect = gladys.connect();
  await sleep(20);
  await gladys.fake.configUpdated({ ...gladys.fake.config, language: 'fr' });
  release();
  await reconnect;
  await idle(world);
  assert.equal(world.monitor.config.language, 'fr');
});

test('a VIN added by a configuration is decoded at once, the vehicle read', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: [] } });
  await tick(world, 1);
  await world.fake.configUpdated({ categories: [], vins: TEST_VIN });
  await tick(world, 1);
  assert.equal(server.count('vpic'), 1);
  assert.equal(server.count('nhtsa'), 1);
  await create(world);
  assert.equal(lastState(world, 'vehicle_recalls'), 2);
});

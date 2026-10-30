// -----------------------------------------------------------------------------
// Review r2: the guards of the r1 code (I1): the vehicles of the VINs reused by
// position and only for the same number of VINs (V1, V3), kept until a
// decoding (V4), read from /data within bounds (V5, V6); a VIN split by
// separators in the vehicles field (N3); the fields of an FDA id kept apart
// (F3); the vehicles kept aside bounded in memory (P3).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { MAX_FEEDS, sanitize } from '../src/monitor.js';
import { normalizeFda } from '../src/sources.js';
import { FILE_NAME } from '../src/store.js';
import { TEST_VIN, TEST_VIN_2, fdaRecall, startServer } from './helpers/server.js';
import { HOUR, MINUTE, START, createWorld, readData, tick } from './helpers/world.js';

const UNKNOWN_VIN = '5YJ3E1EA7KF000316';
const slotsOf = (world) =>
  world.monitor.vinSlots.map((slot) => (slot.vehicle ? slot.vehicle.model : null)).join(',');

test('V3: a quick restart gives each VIN the vehicle of its position, without asking vPIC', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: [], vins: `${TEST_VIN}, ${TEST_VIN_2}` };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  assert.equal(server.count('vpic'), 2);
  assert.deepEqual((await readData(first)).vinVehicles, ['HONDA|ACCORD|2003', 'FORD|F-150|2013']);
  await first.clock.advance(2 * MINUTE);
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  assert.equal(slotsOf(world), 'ACCORD,F-150');
  await tick(world, 1);
  assert.equal(server.count('vpic'), 2);
});

test('V1: a quick restart with another number of VINs reuses nothing', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const first = await createWorld(t, { server, config: { categories: [], vins: TEST_VIN } });
  await tick(first, 1);
  await first.app.stop();
  await first.clock.advance(2 * MINUTE);
  server.faults.vpic = 'drop';
  const world = await createWorld(t, {
    server,
    config: { categories: [], vins: `${TEST_VIN_2}, ${TEST_VIN}` },
    dataDir: first.dataDir,
    clock: first.clock,
  });
  assert.equal(slotsOf(world), ',');
});

test('V4: the vehicles of /data are kept while no VIN is decoded again', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: [], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  // An hour later, vPIC fails: nothing decoded in this run.
  await first.clock.advance(HOUR);
  server.faults.vpic = 'drop';
  const second = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(second, 1);
  assert.equal(slotsOf(second), '');
  await second.app.stop();
  assert.deepEqual((await readData(second)).vinVehicles, ['HONDA|ACCORD|2003']);
  // A quick restart after the failed attempt still has the vehicle.
  await first.clock.advance(MINUTE);
  const third = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  assert.equal(slotsOf(third), 'ACCORD');
});

test('V5, V6: the vehicles of the VINs read from /data: 3 at most, valid keys only', () => {
  const clean = sanitize({
    vinVehicles: ['HONDA|ACCORD|2003', 'bad|key', 'FORD|F-150|2013', 'A|B|2020', 'C|D|2021'],
  });
  assert.deepEqual(clean.vinVehicles, ['HONDA|ACCORD|2003', null, 'FORD|F-150|2013']);
  assert.deepEqual(sanitize({ vinVehicles: [42, 'X|Y|20'] }).vinVehicles, [null, null]);
});

test('V6: an invalid vehicle of /data is never reused', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: [], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  const path = join(first.dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.vinVehicles = ['HONDA|<b>|2003'];
  await writeFile(path, JSON.stringify(data));
  await first.clock.advance(MINUTE);
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  assert.equal(slotsOf(world), '');
});

test('N3: a VIN split by dashes, dots or spaces in the vehicles field is refused', () => {
  for (const vin of [
    '1HGCM-82633-A004352',
    '1HGCM 82633 A004352',
    '1HGCM.82633.A004352',
    `${UNKNOWN_VIN.slice(0, 8)}/${UNKNOWN_VIN.slice(8)}`,
  ]) {
    const config = normalizeConfig({ vehicles: `${vin}, Civic, 2019; Honda, ${vin}, 2019` }, START);
    assert.deepEqual(config.vehicles, [], vin);
    assert.deepEqual(config.invalidVehicles, [1, 2], vin);
  }
});

test('F3: two FDA reports that differ across the boundary of two fields keep two ids', () => {
  const base = fdaRecall(1, { recall_number: '', event_id: '100041' });
  const a = normalizeFda(
    { ...base, product_description: 'Cookies AB', code_info: 'C' },
    'fda-food',
  );
  const b = normalizeFda(
    { ...base, product_description: 'Cookies A', code_info: 'BC' },
    'fda-food',
  );
  assert.notEqual(a.id, b.id);
});

test('P3: the vehicles kept aside in memory are bounded', async (t) => {
  const world = await createWorld(t, {
    config: { categories: [], vehicles: 'Honda, Civic, 2019' },
  });
  await tick(world, 1);
  for (let i = 0; i < 25; i += 1) {
    await world.fake.configUpdated({ categories: [], vehicles: `Make${i}, M, 2020` });
  }
  assert.ok(Object.keys(world.monitor.stored).length <= MAX_FEEDS);
});

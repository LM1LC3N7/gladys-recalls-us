// -----------------------------------------------------------------------------
// VINs: decoded by vPIC only, read as a vehicle; never in the logs (debug
// included), the connection status, /data, the scene events, the widget or
// the actions, whatever happens (decoded, unknown, failing, refused).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'node:util';
import { TEST_VIN, TEST_VIN_2, nhtsaRecall, startServer } from './helpers/server.js';
import {
  HOUR,
  MINUTE,
  create,
  createWorld,
  lastState,
  lastStatus,
  readData,
  tick,
  widgetOf,
} from './helpers/world.js';

const UNKNOWN_VIN = '5YJ3E1EA7KF000316';
const VINS = [TEST_VIN, TEST_VIN_2, UNKNOWN_VIN];

/** Captures every log line (debug included) while the test runs. */
function captureLogs(t) {
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
  return lines;
}

/** Everything the integration wrote or said, as one text. */
async function everything(world, lines) {
  await world.monitor.store.flush();
  const files = await readdir(world.dataDir);
  const data = await Promise.all(files.map((f) => readFile(join(world.dataDir, f), 'utf8')));
  const scene = await world.fake.sceneAction('read_recalls', {});
  const action = await world.fake.action('check_now', {});
  return [
    ...lines,
    ...data,
    JSON.stringify(world.fake.connectionStatuses),
    JSON.stringify(world.fake.sceneEvents),
    JSON.stringify(world.fake.states),
    JSON.stringify(world.fake.discoveredDevices),
    JSON.stringify(await widgetOf(world, 'en')),
    JSON.stringify(await widgetOf(world, 'fr')),
    JSON.stringify(scene),
    JSON.stringify(action),
  ].join('\n');
}

const assertNoVin = (text) => {
  for (const vin of VINS) {
    assert.ok(!text.includes(vin), 'a VIN was written or said');
    assert.ok(!text.toLowerCase().includes(vin.toLowerCase()), 'a VIN was written or said');
  }
};

test('a VIN decoded: the vehicle read like a typed one; the VIN nowhere but in the vPIC path', async (t) => {
  const lines = captureLogs(t);
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: [], vins: TEST_VIN } });
  await tick(world, 1);
  await create(world);
  assert.equal(lastState(world, 'vehicle_recalls'), 2);
  const vpic = server.requests.filter((r) => r.source === 'vpic');
  assert.equal(vpic.length, 1);
  assert.equal(vpic[0].url, `/api/vehicles/DecodeVinValues/${TEST_VIN}?format=json`);
  for (const request of server.requests.filter((r) => r.source !== 'vpic')) {
    assert.ok(!request.url.includes(TEST_VIN));
  }
  assert.match(server.requests[1].url, /make=HONDA&model=ACCORD&modelYear=2003/);
  // A new campaign of the decoded vehicle fires, with the make, model and year.
  server.vehicles['HONDA|ACCORD|2003'].unshift(nhtsaRecall('26V997000', { Model: 'ACCORD' }));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  assert.equal(world.fake.sceneEvents[0].data.vehicle, 'Honda Accord 2003');
  const data = await readData(world);
  assert.deepEqual(Object.keys(data.feeds), ['vehicle:HONDA|ACCORD|2003']);
  // The capture works: the debug lines are there, with the vehicle.
  assert.ok(lines.some((line) => /VIN 1 decoded: Honda Accord 2003/.test(line)));
  assertNoVin(await everything(world, lines));
});

test('an unknown VIN, a malformed one and a failing vPIC: said by position, never repeated', async (t) => {
  const lines = captureLogs(t);
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { categories: [], vins: `${UNKNOWN_VIN}, ${TEST_VIN.slice(0, 16)}` },
  });
  await tick(world, 1);
  await create(world);
  const status = lastStatus(world);
  assert.equal(status.connected, false);
  assert.match(
    status.message.en,
    /NHTSA \(VIN 1\): the VIN cannot be decoded \(NHTSA does not know its make, model or year\)/,
  );
  assert.match(status.message.en, /VINs that are not 17 valid characters: 2\./);
  assert.match(status.message.fr, /NHTSA \(NIV 1\) : le NIV ne peut pas être décodé/);
  assert.equal(world.fake.states.length, 0, 'no count without the vehicle');
  // An unknown VIN is not asked again before the interval.
  await tick(world, HOUR);
  assert.equal(server.count('vpic'), 1);
  await tick(world, 5 * HOUR);
  assert.equal(server.count('vpic'), 2);
  // vPIC failing: paused, said, still never the VIN.
  server.faults.vpic = 503;
  await world.fake.configUpdated({ categories: [], vins: TEST_VIN_2 });
  await tick(world, 1);
  assert.match(
    lastStatus(world).message.en,
    /NHTSA \(VIN 1\): the VIN cannot be decoded \(the server answered with an error \(HTTP 503\)\)/,
  );
  assert.match(lastStatus(world).message.en, /NHTSA asked to wait: next try at/);
  server.faults.vpic = 'drop';
  await tick(world, 20 * MINUTE);
  assertNoVin(await everything(world, lines));
});

test('a scene event refused, a failing /data and a stop: still never the VIN', async (t) => {
  const lines = captureLogs(t);
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: [], vins: TEST_VIN_2 } });
  server.vehicles['FORD|F-150|2013'] = [nhtsaRecall('13V100000', { Make: 'FORD', Model: 'F-150' })];
  await tick(world, 1);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  server.vehicles['FORD|F-150|2013'].unshift(
    nhtsaRecall('26V996000', { Make: 'FORD', Model: 'F-150' }),
  );
  await tick(world, 6 * HOUR);
  await world.app.stop();
  assertNoVin(await everything(world, lines));
});

test('a restart decodes the VINs at once, but not twice in 10 minutes', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const config = { categories: [], vins: TEST_VIN };
  const first = await createWorld(t, { server, config });
  await tick(first, 1);
  await first.app.stop();
  assert.equal(server.count('vpic'), 1);
  // Restarted 2 minutes later: decoded 8 minutes later only; the vehicle read
  // when its interval ends, not before.
  await first.clock.advance(2 * MINUTE);
  const world = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(world, 1);
  assert.equal(server.count('vpic'), 1);
  await tick(world, 8 * MINUTE);
  assert.equal(server.count('vpic'), 2);
  assert.equal(server.count('nhtsa'), 1);
  // The copy of /data serves at once once the VIN is decoded.
  await create(world);
  assert.equal(lastState(world, 'vehicle_recalls'), 2);
  await world.app.stop();
  // Restarted an hour later: decoded at once.
  await first.clock.advance(HOUR);
  const later = await createWorld(t, {
    server,
    config,
    dataDir: first.dataDir,
    clock: first.clock,
  });
  await tick(later, 1);
  assert.equal(server.count('vpic'), 3);
});

test('getConfig() failing with a message holding a VIN: never logged', async (t) => {
  const lines = captureLogs(t);
  const world = await createWorld(t, { connect: false });
  world.gladys.getConfig = async () => {
    throw new Error(`invalid config ${TEST_VIN}`);
  };
  world.gladys.emit('connected');
  await tick(world, 1);
  assert.ok(lines.some((line) => /Cannot read the configuration/.test(line)));
  assertNoVin(lines.join('\n'));
  assertNoVin(JSON.stringify(world.fake.connectionStatuses));
});

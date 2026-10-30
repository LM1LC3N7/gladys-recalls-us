// -----------------------------------------------------------------------------
// The monitor on the fake sources: first reading, states, new recalls fired
// once, the selection, the vehicles, restarts, the schedule.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_ACTION, CONFIG_ACTION } from '../src/actions.js';
import { cpscRecall, fdaRecall, nhtsaRecall, startServer } from './helpers/server.js';
import {
  DAY,
  HOUR,
  MINUTE,
  create,
  createWorld,
  lastState,
  lastStatus,
  readData,
  tick,
} from './helpers/world.js';

test('first start: each followed source read once, one request at a time, nothing fired', async (t) => {
  const world = await createWorld(t);
  await tick(world, 1);
  assert.equal(world.server.count('cpsc'), 1);
  assert.equal(world.server.count('fda'), 2);
  assert.equal(world.server.count('nhtsa'), 0);
  assert.equal(world.fake.sceneEvents.length, 0);
  const [cpsc] = world.server.requests;
  assert.match(cpsc.url, /RecallDateStart=2026-10-09$/);
  assert.match(
    cpsc.headers['user-agent'],
    /^gladys-recalls-us\/0\.1\.0 \(Gladys Assistant integration; \+https:\/\/github\.com\/LM1LC3N7\/gladys-recalls-us\)$/,
  );
  const fda = world.server.requests.find((r) => r.source === 'fda');
  assert.match(decodeURIComponent(fda.url), /report_date:\[20261009\+TO\+20261031\]/);
  assert.equal(lastStatus(world).connected, true);
  assert.equal(lastStatus(world).message, undefined);
});

test('the states: recalls in 7 days and the latest, published once the device exists', async (t) => {
  const world = await createWorld(t);
  await tick(world, 1);
  assert.equal(world.fake.states.length, 0);
  await create(world);
  // CPSC recalls of the fixtures dated 24/10 to 30/10.
  const week = lastState(world, 'recalls_week');
  assert.ok(week > 0, `week ${week}`);
  assert.match(lastState(world, 'latest_recall'), /^Oct \d+, 2026 · /);
  // No vehicle followed: no state for the vehicle counter.
  assert.equal(lastState(world, 'vehicle_recalls'), undefined);
});

test('a new CPSC recall fires once; a restart fires nothing again', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  server.cpsc.unshift(cpscRecall(27999));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  const [event] = world.fake.sceneEvents;
  assert.equal(event.key, 'new_recall');
  assert.equal(event.data.category, 'consumer');
  assert.equal(event.data.day, '2026-10-30');
  assert.match(event.data.url, /^https:\/\/www\.cpsc\.gov\/Recalls\//);
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  // A second integration on the same /data: nothing new.
  await world.app.stop();
  const again = await createWorld(t, { server, dataDir: world.dataDir, clock: world.clock });
  await tick(again, 7 * HOUR);
  assert.equal(again.fake.sceneEvents.length, 0);
});

test('a new FDA recall fires, its class and firm in the variables', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  server.fda.food.results.unshift(fdaRecall(1));
  server.touch();
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  const { data } = world.fake.sceneEvents[0];
  assert.equal(data.category, 'food');
  assert.equal(data.recall_class, 'Class I');
  assert.equal(data.firm, 'Maple Foods LLC');
  assert.equal(data.issue, 'Undeclared peanut');
});

test('keywords: whole words of the title, product or firm; vehicles never filtered', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { keywords: 'nut, Crème', vehicles: 'Honda, Civic, 2019' },
  });
  await tick(world, 1);
  server.fda.food.results.unshift(
    fdaRecall(2, { product_description: 'Peanut butter' }),
    fdaRecall(3, { product_description: 'Mixed nut bars' }),
    fdaRecall(4, { product_description: 'CREME brulee', recalling_firm: 'X' }),
  );
  server.touch();
  server.vehicles['HONDA|CIVIC|2019'].unshift(nhtsaRecall('26V999000'));
  await tick(world, 6 * HOUR);
  const titles = world.fake.sceneEvents.map((e) => e.data.product).sort();
  assert.deepEqual(titles, ['CREME brulee', 'Honda Civic 2019', 'Mixed nut bars']);
});

test('a recall older than 14 days is remembered, never fired', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  server.fda.drug.results.unshift(fdaRecall(5, { report_date: '20261014' }));
  server.touch();
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 0);
});

test('a typed vehicle: its campaigns counted, a new one fired with the vehicle', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { categories: [], vehicles: 'honda,  civic , 2019' },
  });
  await tick(world, 1);
  await create(world);
  assert.equal(server.count('nhtsa'), 1);
  assert.equal(server.count('cpsc') + server.count('fda'), 0);
  assert.equal(lastState(world, 'vehicle_recalls'), 4);
  assert.match(server.requests[0].url, /make=HONDA&model=CIVIC&modelYear=2019/);
  server.vehicles['HONDA|CIVIC|2019'].unshift(nhtsaRecall('26V998000', { parkIt: true }));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  const { data } = world.fake.sceneEvents[0];
  assert.equal(data.category, 'vehicles');
  assert.equal(data.vehicle, 'Honda Civic 2019');
  assert.equal(data.url, 'https://www.nhtsa.gov/recalls?nhtsaId=26V998000');
  assert.equal(data.day, '2026-10-29');
  assert.equal(lastState(world, 'vehicle_recalls'), 5);
  // In the 7 days too.
  assert.equal(lastState(world, 'recalls_week'), 1);
});

test('a vehicle unknown to NHTSA: 0 campaigns, said in the status', async (t) => {
  const world = await createWorld(t, {
    config: { categories: [], vehicles: 'Hondda, Civic, 2019' },
  });
  await tick(world, 1);
  await create(world);
  assert.equal(lastState(world, 'vehicle_recalls'), 0);
  assert.match(
    lastStatus(world).message.en,
    /No recall campaign known to NHTSA for Hondda Civic 2019/,
  );
  assert.equal(lastStatus(world).connected, true);
});

test('the schedule: each source once per interval, never faster', async (t) => {
  const world = await createWorld(t, { config: { refresh_interval: '3' } });
  await tick(world, 1);
  assert.equal(world.server.count('cpsc'), 1);
  await tick(world, 3 * HOUR - MINUTE);
  assert.equal(world.server.count('cpsc'), 1);
  await tick(world, MINUTE);
  assert.equal(world.server.count('cpsc'), 2);
  // An unchanged configuration saved again reads nothing.
  await world.fake.configUpdated({ refresh_interval: '3' });
  await tick(world, 1);
  assert.equal(world.server.count('cpsc'), 2);
});

test('openFDA: the ETag of the same question is sent, a 304 keeps the copy', async (t) => {
  const world = await createWorld(t);
  await tick(world, 1);
  await create(world);
  await tick(world, 6 * HOUR);
  const fda = world.server.requests.filter((r) => r.source === 'fda');
  assert.equal(fda.length, 4);
  assert.match(fda[2].headers['if-none-match'], /^W\/"fda-food-1-20261009-20261031"$/);
  assert.equal(lastStatus(world).connected, true);
});

test('a restart in the middle of the interval reads nothing before the end of it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  await tick(world, 2 * HOUR);
  await world.app.stop();
  const before = server.requests.length;
  const again = await createWorld(t, { server, dataDir: world.dataDir, clock: world.clock });
  await tick(again, 1);
  assert.equal(server.requests.length, before);
  // Published from the copy of /data, still fresh.
  await create(again);
  assert.ok(lastState(again, 'recalls_week') > 0);
  assert.equal(lastStatus(again).connected, true);
  await tick(again, 4 * HOUR);
  assert.equal(server.requests.length, before + 3);
});

test('the scene action and the button give the recalls of the 7 days', async (t) => {
  const world = await createWorld(t, { config: { vehicles: 'Honda, Civic, 2019' } });
  await tick(world, 1);
  const { data } = await world.fake.sceneAction(SCENE_ACTION, {});
  assert.match(data.outputs.text, /^\d+ recalls? in 7 days: /);
  assert.match(
    data.outputs.text,
    /Your vehicles: Honda Civic 2019, 4 recall campaigns, the latest received on /,
  );
  assert.equal(data.outputs.vehicle_count, 4);
  const button = await world.fake.action(CONFIG_ACTION, {});
  assert.match(JSON.stringify(button), /Read at/);
});

test('/data holds the copies, the ids seen and the attempts', async (t) => {
  const world = await createWorld(t);
  await tick(world, 1);
  const data = await readData(world);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.feeds).sort(), ['cpsc', 'fda-drug', 'fda-food']);
  assert.ok(data.feeds.cpsc.known.length > 0);
  assert.ok(Number.isFinite(data.feeds.cpsc.attemptAt));
  assert.ok(data.feeds.cpsc.nextAt - data.feeds.cpsc.attemptAt >= 6 * HOUR - 1);
  assert.ok(data.feeds['fda-food'].etag);
  void DAY;
});

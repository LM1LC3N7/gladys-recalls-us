// -----------------------------------------------------------------------------
// Freshness (lessons of gladys-rappels-canada, reviews r1 to r3): the scene
// action, the button and the widget never give recalls that are not up to
// date as current, never a count that leaves a source out, and say when the
// last reading of a source failed while its recalls are still fresh.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_ACTION, SCENE_ACTION } from '../src/actions.js';
import { FILE_NAME } from '../src/store.js';
import { startServer } from './helpers/server.js';
import {
  DAY,
  HOUR,
  create,
  createWorld,
  lastState,
  lastStatus,
  sceneFails,
  tick,
  widgetOf,
} from './helpers/world.js';

const widget = widgetOf;
const heading = (content) => content.components[0].text;
const caption = (content) => content.components.find((c) => c.variant === 'caption').text;

/** Ages every time of /data by `ms`, as if the integration had been off. */
async function age(dir, ms) {
  const path = join(dir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  for (const feed of Object.values(data.feeds)) {
    for (const key of ['attemptAt', 'nextAt', 'readAt']) {
      if (Number.isFinite(feed[key])) feed[key] -= ms;
    }
  }
  await writeFile(path, JSON.stringify(data));
}

test('a copy of 9 days and sources in 503: the action fails, the widget says not up to date, no state', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const first = await createWorld(t, { server });
  await tick(first, 1);
  await first.app.stop();
  await age(first.dataDir, 9 * DAY);
  server.faults.all = 503;
  const world = await createWorld(t, { server, dataDir: first.dataDir, clock: first.clock });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.states.length, 0, 'no state from old recalls');
  await sceneFails(
    world,
    /The recalls are not up to date: CPSC \(consumer products\) last read on /,
  );
  const button = await world.fake.action(CONFIG_ACTION, {});
  assert.match(JSON.stringify(button), /not up to date/);
  assert.doesNotMatch(JSON.stringify(button), /No recall/);
  const content = await widget(world);
  assert.equal(heading(content), 'Recalls not up to date');
  assert.equal(lastStatus(world).connected, false);
  assert.match(
    lastStatus(world).message.en,
    /CPSC \(consumer products\) cannot be read \(the server answered with an error \(HTTP 503\)\)/,
  );
});

test('a copy of /data dated in the future is not taken as fresh', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const first = await createWorld(t, { server });
  await tick(first, 1);
  await first.app.stop();
  await age(first.dataDir, -2 * HOUR);
  server.faults.all = 503;
  const world = await createWorld(t, { server, dataDir: first.dataDir, clock: first.clock });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.states.length, 0);
  await sceneFails(world, /not up to date/);
});

test('a restart with a fresh copy publishes it at once, connected, without reading', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const first = await createWorld(t, { server });
  await tick(first, 1);
  await first.app.stop();
  const before = server.requests.length;
  const world = await createWorld(t, { server, dataDir: first.dataDir, clock: first.clock });
  await create(world);
  assert.ok(lastState(world, 'recalls_week') > 0);
  assert.equal(lastStatus(world).connected, true);
  assert.equal(server.requests.length, before);
  const { data } = await world.fake.sceneAction(SCENE_ACTION, {});
  assert.match(data.outputs.text, /recalls? in 7 days/);
});

test('openFDA not loaded for 21 days: stale, said, no counter, the action fails', async (t) => {
  const server = await startServer({ date: () => 'Fri, 20 Nov 2026 16:00:00 GMT' });
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: ['food'] } });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.states.length, 0);
  assert.match(
    lastStatus(world).message.en,
    /FDA \(food\) has not been updated since Oct 21, 2026/,
  );
  await sceneFails(world, /FDA \(food\) not updated since Oct 21, 2026/);
  assert.equal(heading(await widget(world)), 'Recalls not up to date');
});

test('openFDA loaded 20 days ago is not stale; without a Date header, never stale', async (t) => {
  for (const date of [() => 'Tue, 10 Nov 2026 16:00:00 GMT', () => null]) {
    const server = await startServer({ date });
    t.after(() => server.close());
    const world = await createWorld(t, { server, config: { categories: ['food'] } });
    await tick(world, 1);
    await create(world);
    assert.equal(lastState(world, 'recalls_week'), 0);
  }
});

test('a source that fails after a good reading: still fresh, the warning comes first', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  await create(world);
  const week = lastState(world, 'recalls_week');
  server.faults.cpsc = 'drop';
  await tick(world, 6 * HOUR);
  const { data } = await world.fake.sceneAction(SCENE_ACTION, {});
  assert.match(
    data.outputs.text,
    /^Warning: the last reading failed for CPSC \(consumer products\) \(the connection was cut by the server; recalls of Oct 30, 12:00 PM\)\. \d+ recalls? in 7 days/,
  );
  const button = await world.fake.action(CONFIG_ACTION, {});
  assert.match(JSON.stringify(button), /Warning: the last reading failed/);
  assert.match(caption(await widget(world)), /Warning/);
  // The counters stay published while fresh.
  assert.equal(lastState(world, 'recalls_week'), week);
  assert.equal(lastStatus(world).connected, false);
});

test('one source never read: no counter (never a count that leaves it out), the action names it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.fda = 503;
  const world = await createWorld(t, { server });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.states.length, 0);
  await sceneFails(world, /Not read yet: FDA \(food\) and FDA \(drugs\)\./);
  const content = await widget(world, 'fr');
  assert.equal(heading(content), 'Rappels non à jour');
  // The rows of the fresh source are still listed.
  assert.ok(content.components.some((c) => c.type === 'card-list'));
  // Back: the counters come.
  server.faults.fda = false;
  await tick(world, 6 * HOUR);
  assert.ok(lastState(world, 'recalls_week') >= 0);
  assert.equal(lastStatus(world).connected, true);
});

test('fresh only for two intervals and an hour', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  server.faults.all = 'drop';
  await tick(world, 12 * HOUR);
  const { data } = await world.fake.sceneAction(SCENE_ACTION, {});
  assert.match(data.outputs.text, /^Warning/);
  await tick(world, 1 * HOUR);
  await sceneFails(world, /not up to date/);
});

test('nothing followed: said everywhere, no state, the action fails', async (t) => {
  const world = await createWorld(t, { config: { categories: [] } });
  await tick(world, 1);
  await create(world);
  assert.equal(world.server.requests.length, 0);
  assert.equal(world.fake.states.length, 0);
  assert.match(lastStatus(world).message.en, /Nothing is followed/);
  await sceneFails(world, /Nothing is followed/);
  assert.equal(heading(await widget(world)), 'Nothing followed');
});

test('the widget: heading, rows of the 7 days then the vehicle campaigns, caption within 80', async (t) => {
  const world = await createWorld(t, { config: { vehicles: 'Honda, Civic, 2019' } });
  await tick(world, 1);
  const busy = await widget(world);
  assert.match(heading(busy), /^\d+ recalls in 7 days$/);
  assert.equal(busy.components[1].items.length, 8);
  await world.fake.configUpdated({ vehicles: 'Honda, Civic, 2019', keywords: 'zzzz' });
  await tick(world, 1);
  const content = await widget(world);
  assert.equal(heading(content), 'No recall in 7 days');
  const list = content.components.find((c) => c.type === 'card-list');
  assert.ok(list.items.length <= 8);
  assert.ok(list.items.some((item) => item.badge.text === 'Vehicle'));
  assert.ok(caption(content).length <= 80);
  for (const item of list.items) {
    assert.ok(item.title.length <= 60 && item.subtitle.length <= 60);
    assert.ok(item.badge.text.length <= 16);
    assert.match(item.links[0].url, /^https:\/\//);
  }
});

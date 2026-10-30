// -----------------------------------------------------------------------------
// One test per guard a mutant of the milestone survived: errors without URL,
// openFDA and NHTSA error shapes, the ETag of the same question only, model
// years of vPIC, restarts with dates of /data in the future or a pause beyond
// its bound, the cap of events per check, a 304 without copy, the schedule of
// the VINs, events kept across a 304, vehicle_count without vehicle, the
// caption of the widget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson } from '../src/http.js';
import { MAX_EVENTS_PER_CYCLE } from '../src/monitor.js';
import { decodeVin, readFeed } from '../src/sources.js';
import { FILE_NAME } from '../src/store.js';
import { TEST_VIN, cpscRecall, fdaRecall, startServer } from './helpers/server.js';
import { HOUR, MINUTE, createWorld, lastStatus, tick, widgetOf } from './helpers/world.js';

const BASE = {
  cpsc: 'https://c.test',
  fda: 'https://f.test',
  nhtsa: 'https://n.test',
  vpic: 'https://v.test',
};
const answer =
  (status, body, headers = {}) =>
  async (url, init) => {
    answer.last = { url, init };
    return new Response(JSON.stringify(body), { status, headers });
  };

test('a network error whose message holds the URL: only the host and a code are kept', async () => {
  const fetch = async () => {
    throw new TypeError(`fetch failed for https://v.test/api/vehicles/DecodeVinValues/${TEST_VIN}`);
  };
  await assert.rejects(getJson({ fetch, url: `https://v.test/x/${TEST_VIN}` }), (err) => {
    assert.ok(!err.message.includes(TEST_VIN), err.message);
    assert.equal(err.message, 'v.test: request failed');
    return true;
  });
  const coded = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(getJson({ fetch: coded, url: 'https://v.test/x' }), {
    message: 'v.test: ECONNREFUSED',
    kind: 'refused',
  });
});

test('openFDA: a 404 in JSON that is not NOT_FOUND is an error', async () => {
  const fetch = answer(404, { error: { code: 'BAD_REQUEST', message: 'x' } });
  const feed = { id: 'fda-food', kind: 'fda' };
  await assert.rejects(
    readFeed({ fetch, feed, fromDay: '2026-10-09', toDay: '2026-10-31', baseUrls: BASE }),
    {
      kind: 'http',
      status: 404,
    },
  );
});

test('NHTSA: a 400 in JSON with campaigns is an error', async () => {
  const fetch = answer(400, { Count: 1, results: [{ NHTSACampaignNumber: '20V314000' }] });
  const feed = {
    id: 'vehicle:X|Y|2020',
    kind: 'vehicle',
    vehicle: { make: 'X', model: 'Y', year: 2020 },
  };
  await assert.rejects(readFeed({ fetch, feed, fromDay: '', toDay: '', baseUrls: BASE }), {
    kind: 'http',
    status: 400,
  });
});

test('openFDA: the ETag is sent for the same question only', async () => {
  const fetch = answer(404, { error: { code: 'NOT_FOUND' } });
  const feed = { id: 'fda-food', kind: 'fda' };
  const args = { fetch, feed, fromDay: '2026-10-09', toDay: '2026-10-31', baseUrls: BASE };
  await readFeed({ ...args, copy: { query: 'other', etag: 'W/"x"' } });
  assert.equal(answer.last.init.headers['If-None-Match'], undefined);
  const query = new URL(answer.last.url).search.slice(1);
  await readFeed({ ...args, copy: { query, etag: 'W/"x"' } });
  assert.equal(answer.last.init.headers['If-None-Match'], 'W/"x"');
});

test('vPIC: a model year beyond the bound is "unknown", never a vehicle', async () => {
  const fetch = answer(200, { Results: [{ Make: 'HONDA', Model: 'CIVIC', ModelYear: '2031' }] });
  await assert.rejects(decodeVin({ fetch, vin: TEST_VIN, baseUrls: BASE, maxYear: 2028 }), {
    kind: 'vinUnknown',
  });
  const ok = answer(200, { Results: [{ Make: 'Honda', Model: 'Civic', ModelYear: '2028' }] });
  assert.deepEqual(await decodeVin({ fetch: ok, vin: TEST_VIN, baseUrls: BASE, maxYear: 2028 }), {
    make: 'HONDA',
    model: 'CIVIC',
    year: 2028,
  });
});

/** Rewrites /data with `edit(data, now)`. */
async function editData(world, edit) {
  const path = join(world.dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  edit(data, world.clock.now());
  await writeFile(path, JSON.stringify(data));
}

test('a restart after times of /data in the future, or a pause beyond 6 h: read at once', async (t) => {
  for (const edit of [
    (data, now) => {
      data.feeds.cpsc.attemptAt = now + 2 * HOUR;
      data.feeds.cpsc.nextAt = now + 8 * HOUR;
    },
    (data, now) => {
      data.feeds.cpsc.attemptAt = now - 7 * HOUR;
      data.feeds.cpsc.nextAt = now - HOUR;
      data.pauses = { cpsc: now + 10 * HOUR };
    },
  ]) {
    const server = await startServer();
    t.after(() => server.close());
    const config = { categories: ['consumer'] };
    const first = await createWorld(t, { server, config });
    await tick(first, 1);
    await first.app.stop();
    await editData(first, edit);
    const world = await createWorld(t, {
      server,
      config,
      dataDir: first.dataDir,
      clock: first.clock,
    });
    await tick(world, 1);
    assert.equal(server.count('cpsc'), 2);
  }
});

test(`more than ${MAX_EVENTS_PER_CYCLE} new recalls in the window: ${MAX_EVENTS_PER_CYCLE} now, the rest next`, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { categories: ['consumer'] } });
  await tick(world, 1);
  for (let i = 0; i < 25; i += 1) {
    server.cpsc.unshift(cpscRecall(31000 + i, { RecallDate: '2026-10-29T00:00:00' }));
  }
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, MAX_EVENTS_PER_CYCLE);
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 25);
});

test('a 304 for a copy never kept is a failure, never "up to date"', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.fda = 'force304';
  const world = await createWorld(t, { server, config: { categories: ['food'] } });
  await tick(world, 1);
  assert.equal(lastStatus(world).connected, false);
  assert.match(
    lastStatus(world).message.en,
    /FDA \(food\) cannot be read \(the answer is not in the expected format\)/,
  );
  assert.equal(world.monitor.feeds.get('fda-food').etag, null);
});

test('a VIN is decoded on its own schedule, not at every check of another source', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.faults.nhtsa = 'drop';
  const world = await createWorld(t, {
    server,
    config: { categories: [], vehicles: 'Honda, Civic, 2019', vins: '5YJ3E1EA7KF000316' },
  });
  await tick(world, 1);
  assert.equal(server.count('vpic'), 1);
  // The vehicle is tried again at 15 and 45 minutes: no new decoding.
  await tick(world, 15 * MINUTE);
  await tick(world, 30 * MINUTE);
  assert.equal(server.count('nhtsa'), 3);
  assert.equal(server.count('vpic'), 1);
});

test('an event refused is sent again when the next answer of openFDA is a 304', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, {
    server,
    config: { categories: ['food'], refresh_interval: '3' },
  });
  await tick(world, 1);
  const publish = world.gladys.publishSceneEvent.bind(world.gladys);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  // Same day all along (12:00 to 18:00 in New York): the same question.
  server.fda.food.results.unshift(fdaRecall(9));
  server.touch();
  await tick(world, 3 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 0);
  world.gladys.publishSceneEvent = publish;
  await tick(world, 3 * HOUR);
  const last = server.requests.filter((r) => r.source === 'fda').at(-1);
  assert.ok(last.headers['if-none-match'], 'a conditional request');
  assert.equal(world.fake.sceneEvents.length, 1);
});

test('vehicle_count is absent without a vehicle, never 0 nor -1', async (t) => {
  const world = await createWorld(t, { config: { categories: ['consumer'] } });
  await tick(world, 1);
  const { data } = await world.fake.sceneAction('read_recalls', {});
  assert.equal('vehicle_count' in data.outputs, false);
});

test('the caption of the widget stays within 80 characters, warnings included', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server });
  await tick(world, 1);
  server.faults.all = 503;
  await tick(world, 6 * HOUR);
  const content = await widgetOf(world, 'fr');
  const caption = content.components.find((c) => c.variant === 'caption').text;
  assert.ok(caption.length <= 80, `${caption.length}`);
  assert.match(caption, /Attention/);
});

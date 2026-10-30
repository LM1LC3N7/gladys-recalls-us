// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, the fake sources
// (test/helpers/server.js) read through the real fetch, a virtual clock (wall
// and monotonic, timers), a temporary /data removed after the test, and the
// integration wired on top through registerHandlers.
// -----------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { FILE_NAME, Store } from '../../src/store.js';
import { testClock, settle } from '../kit/clock.mjs';
import { startServer } from './server.js';

process.env.LOG_LEVEL ??= 'silent';
process.env.TZ = 'America/New_York';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
// 30/10/2026 12:00 in New York.
export const START = Date.parse('2026-10-30T16:00:00Z');

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 */
export async function createWorld(
  t,
  {
    config = {},
    devices = [],
    clock = testClock({ start: START }),
    server,
    dataDir,
    connect = true,
    gladys,
    store,
    timings,
    limits,
    fetch: fetchImpl = (...args) => fetch(...args),
  } = {},
) {
  const srv = server ?? (await startServer());
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'gladys-recalls-us-')));
  const fake = gladys ?? createFakeGladys({ config, devices });
  const app = registerHandlers(fake, {
    store: store ?? new Store(dir),
    fetch: fetchImpl,
    baseUrls: srv.baseUrls,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    // No gap between two requests on the virtual clock (its timers fire only
    // when it is moved); the real-clock test keeps one.
    timings: { requestGapMs: 0, saveWaitMs: 200, ...timings },
    limits,
    sourceTimeouts: { headers: 2000, stall: 300, total: 10000 },
  });
  // One hook, in this order: the app stops (its last write lands), then the
  // server and the folder of this world go.
  t.after(async () => {
    await app.stop();
    if (!server) {
      await srv.close();
    }
    if (!dataDir) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
  const world = {
    gladys: fake,
    fake: fake.fake,
    app,
    monitor: app.monitor,
    server: srv,
    clock,
    dataDir: dir,
  };
  if (connect) {
    await fake.connect();
    await app.ready;
    await idle(world);
  }
  return world;
}

/** Waits for the running check, if any, and lets the promises settle. */
export async function idle(world) {
  for (let i = 0; i < 50; i += 1) {
    await settle(3);
    // A turn of the real timers too: /data is real I/O.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!world.monitor.running) {
      return;
    }
    await world.monitor.running;
  }
}

/** Moves the virtual clock on, then waits for the check it started. */
export async function tick(world, ms) {
  await world.clock.advance(ms);
  await idle(world);
}

/** Create the device in Gladys, as the user would. */
export async function create(world) {
  const [device] = world.fake.discoveredDevices;
  await world.fake.deviceCreated(device);
  await idle(world);
  return device;
}

/** External id of one feature of a device. */
export const featureId = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`))?.external_id;

/** The last state published for a feature key (undefined: none). */
export function lastState(world, key) {
  const states = world.fake.states.filter((s) => s.device_feature_external_id.endsWith(`:${key}`));
  const last = states.at(-1);
  return last === undefined ? undefined : (last.text ?? last.state);
}

/** The JSON of /data (after the pending writes). */
export async function readData(world) {
  await world.monitor.store.flush();
  return JSON.parse(await readFile(join(world.dataDir, FILE_NAME), 'utf8'));
}

/** The last connection status. */
export const lastStatus = (world) => world.fake.connectionStatus;

/** The scene action fails, with this reason. */
export async function sceneFails(world, reason) {
  const ack = await world.fake.sceneAction('read_recalls', {});
  if (ack.success !== false || !reason.test(ack.error)) {
    throw new Error(`expected a failure matching ${reason}, got ${JSON.stringify(ack)}`);
  }
}

/** The content of the widget. */
export async function widgetOf(world, language = 'en') {
  const ack = await world.fake.widgetGet('recalls', { language });
  return ack.data.content;
}

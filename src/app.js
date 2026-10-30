// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the monitor, so index.js stays a few lines and the tests drive
// the very same wiring.
//
// `getConfig()` failing in `connected` (at the start or at a reconnection) is
// tried again without end, 5 s, then doubled up to 5 minutes, with the status
// saying so.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { CONFIG_ACTION, SCENE_ACTION, checkNow, readRecalls } from './actions.js';
import { normalizeConfig } from './config.js';
import { STATUS, render } from './messages.js';
import { Monitor } from './monitor.js';
import { Store } from './store.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'recalls-us-app' });

export const CONFIG_RETRY_MS = 5000;
export const CONFIG_RETRY_MAX_MS = 5 * 60 * 1000;

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, fetch, baseUrls, now, monotonic,
 *   timers, timings, sourceTimeouts, limits
 */
export function registerHandlers(gladys, options = {}) {
  const timers = options.timers === undefined ? { setTimeout, clearTimeout } : options.timers;
  const now = options.now ?? (() => Date.now());
  const normalize = (raw) => normalizeConfig(raw, now());
  const monitor = new Monitor({
    gladys,
    store: options.store ?? new Store(),
    fetch: options.fetch,
    baseUrls: options.baseUrls,
    now: options.now,
    monotonic: options.monotonic,
    timers,
    timings: options.timings,
    sourceTimeouts: options.sourceTimeouts,
    limits: options.limits,
  });

  // Resolved once the monitor has started; every handler waits for it, so a
  // request arriving during the start is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  let retryTimer = null;
  let retryDelay = CONFIG_RETRY_MS;
  let stopped = false;
  // One `connected` handled at a time; a newer one makes the older retry moot.
  let generation = 0;

  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  // Configurations saved by the user, counted: a getConfig() of a
  // reconnection answered after one of them carries an older configuration.
  let saved = 0;

  async function onConnected(gen) {
    if (stopped || gen !== generation) {
      return;
    }
    const savedBefore = saved;
    let config;
    try {
      config = normalize(await gladys.getConfig());
    } catch (err) {
      if (stopped || gen !== generation) {
        return;
      }
      // The error of the SDK, never the configuration (it holds the VINs).
      logger.warn(
        `Cannot read the configuration: ${err?.name ?? 'error'}; trying again in ${retryDelay / 1000} s`,
      );
      await gladys.setConnectionStatus(false, render(STATUS, 'initFailed')).catch(() => {});
      if (timers) {
        retryTimer = timers.setTimeout(() => {
          retryTimer = null;
          onConnected(gen);
        }, retryDelay);
        retryTimer?.unref?.();
      }
      retryDelay = Math.min(retryDelay * 2, CONFIG_RETRY_MAX_MS);
      return;
    }
    if (stopped || gen !== generation) {
      return;
    }
    retryDelay = CONFIG_RETRY_MS;
    try {
      if (started) {
        // A reconnection (Gladys restarted): publish everything again.
        // A configuration saved while it was read is newer: kept (null).
        await monitor.resync(saved === savedBefore ? config : null);
      } else {
        await monitor.start(config);
        started = true;
      }
    } catch (err) {
      logger.error('Initialization failed', err);
    } finally {
      if (started) {
        resolveReady();
      }
    }
  }

  gladys.on('connected', () => {
    generation += 1;
    if (retryTimer !== null && timers) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    return onConnected(generation);
  });

  gladys.onScanRequest(whenReady(() => monitor.publishDiscovered()));

  // The device is published with should_poll: false (refreshed by the
  // monitor's own timer); this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady((device) => monitor.poll(device)));

  gladys.onDeviceCreated(whenReady((device) => monitor.onDeviceCreated(device)));

  gladys.onConfigUpdated((newConfig) => {
    saved += 1;
    return whenReady(() => monitor.reconfigure(normalize(newConfig)))();
  });

  gladys.onAction(
    CONFIG_ACTION,
    whenReady(() => checkNow(monitor)),
  );
  gladys.onSceneAction(
    SCENE_ACTION,
    whenReady(() => readRecalls(monitor)),
  );

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(monitor, request)),
    );
  }

  return {
    monitor,
    ready,
    stop: () => {
      stopped = true;
      if (retryTimer !== null && timers) {
        timers.clearTimeout(retryTimer);
      }
      return monitor.stop();
    },
  };
}

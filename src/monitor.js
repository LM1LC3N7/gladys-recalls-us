// -----------------------------------------------------------------------------
// The monitor: reads each followed source (a "feed") every `refresh_interval`
// hours, keeps its recent recalls, publishes the states of the device, fires
// the scene trigger and serves the widget and the actions.
//
// Feeds: `cpsc` (consumer products), `fda-food`, `fda-drug`, `fda-device`
// (openFDA enforcement reports) for the ticked categories, and
// `vehicle:MAKE|MODEL|YEAR` (NHTSA) for each vehicle, typed or decoded from a
// VIN (NHTSA vPIC). Each feed has its own schedule, failures and copy: a
// source that fails never holds the others; a pause asked by a host (429,
// 5xx) holds only the feeds of that host. One request at a time, a second
// apart.
//
// Selection: CPSC and FDA recalls naming a followed brand or word, if any
// (title, product or firm); every campaign of a followed vehicle.
//
// Trigger `new_recall`: an id absent from the previous answers of its feed, in
// the selection, whose day is within the last 14 days (or unknown); for a
// vehicle, any campaign NHTSA lists for the first time. The first answer of a
// feed fires nothing: what is listed then is not news. What was seen is kept
// under /data, so a restart fires nothing again; a scene event Gladys
// refused, or one beyond the cap of a check, stays pending (in /data too) and
// is sent at the next reading of its feed. An event is sent before /data
// records it: a crash in between sends it again (at least once).
//
// Freshness: the values (states, actions, widget) come from readings less than
// two intervals and an hour old, of sources that are not stale; the counters
// are published only when every followed feed is fresh (never a count that
// leaves a source out, never 0 for what is unknown). A restart takes the
// copies of /data with the time they were read.
//
// Configurations saved back to back are applied one by one, in order: the last
// one wins.
//
// VINs: kept in memory only (from the configuration), sent only to vPIC. A
// restart decodes them at once, unless it did less than 10 minutes ago; the
// decoded vehicle is then read like a typed one. Never logged, stored or shown:
// the texts say "VIN 2", the logs and /data hold the make, model and year.
//
// Clocks: the schedule runs on the monotonic clock (a wall clock moved by NTP
// neither hastens nor delays a reading); the wall clock dates the days of the
// recalls, and the attempts kept in /data so a restart never reads faster
// than the interval.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { CATEGORIES, fold, vehicleKey } from './config.js';
import { buildDevice, deviceIds, MAX_COUNT } from './device.js';
import {
  CATEGORY_NAMES,
  PHRASES,
  STATUS,
  clip,
  dayBefore,
  describe,
  describeError,
  feedName,
  formatDate,
  formatSourceDay,
  formatTime,
  join,
  listOf,
  localDay,
  render,
  renderEach,
} from './messages.js';
import { BASE_URLS, MAX_RECORDS, decodeVin, readFeed, vehicleLabel } from './sources.js';

const logger = createLogger({ name: 'recalls-us' });

export const WIDGET_KEY = 'recalls';
export const TRIGGERS = { NEW: 'new_recall' };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_TIMINGS = {
  // One hour of the refresh interval (shortened by the real-clock test only).
  hourMs: HOUR,
  heartbeatMs: 12 * HOUR,
  // requestWidgetRefresh is rate-limited to one call every 10 s by the core.
  widgetRefreshMs: 10 * SECOND,
  // First retry of a feed after a failure; doubled each time, up to the interval.
  retryMs: 15 * MINUTE,
  // Bounds of a pause asked by a host (Retry-After) or after a 429/5xx.
  minPauseMs: MINUTE,
  maxPauseMs: 6 * HOUR,
  // Between two requests of a check: one at a time, never a burst.
  requestGapMs: SECOND,
  // The wait for /data before a request is bounded: a frozen disk never holds
  // a reading (the write goes on in the background).
  saveWaitMs: 2 * SECOND,
  // A decoded VIN is decoded again after a day; a restart decodes at once,
  // but not twice in 10 minutes (a container restarting in a loop).
  vinRedecodeMs: DAY,
  startDecodeMs: 10 * MINUTE,
};

// Recalls asked to CPSC and openFDA: the last 21 days (the counter needs 7,
// the trigger 14; openFDA publishes weekly, a few days late).
export const WINDOW_DAYS = 21;
export const WEEK_DAYS = 7;
export const FIRE_DAYS = 14;
// openFDA loads its reports every week: not loaded for 21 days, it is stale.
export const FDA_STALE_MS = 21 * DAY;
export const MAX_EVENTS_PER_CYCLE = 20;
export const MAX_PENDING = 200;
export const MAX_KNOWN = 5000;
// Feeds kept under /data: the followed ones first, then the others by last reading.
export const MAX_FEEDS = 16;
// Texts of the scene variables (the core takes 1000 characters).
const MAX_VARIABLE = 500;
const MAX_STATUS = 1500;

const CATEGORY_FEEDS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.feed]));

const newestFirst = (a, b) => (b.day ?? '').localeCompare(a.day ?? '') || b.id.localeCompare(a.id);

export const vehicleFeedId = (vehicle) => `vehicle:${vehicleKey(vehicle)}`;

/** The vehicle of a feed id `vehicle:MAKE|MODEL|YEAR`, or null. */
export function vehicleOf(id) {
  const match = /^vehicle:([^|]{1,40})\|([^|]{1,40})\|(\d{4})$/.exec(id);
  return match ? { make: match[1], model: match[2], year: Number(match[3]) } : null;
}

function kindOf(id) {
  if (id === 'cpsc') {
    return { kind: 'cpsc', host: 'cpsc' };
  }
  if (id.startsWith('fda-')) {
    return { kind: 'fda', host: 'fda' };
  }
  return { kind: 'vehicle', host: 'nhtsa' };
}

export class Monitor {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK fake)
   * @param {object} options.store see src/store.js
   * @param {Function} [options.fetch] fetch
   * @param {object} [options.baseUrls] where the sources are read (tests)
   * @param {Function} [options.now] wall clock in ms
   * @param {Function} [options.monotonic] monotonic clock in ms
   * @param {object|false} [options.timers] { setTimeout, clearTimeout }; false: no timer
   * @param {object} [options.timings] overrides of DEFAULT_TIMINGS
   * @param {object} [options.sourceTimeouts] overrides of the request timeouts
   * @param {object} [options.limits] overrides of maxRecords (tests)
   */
  constructor({
    gladys,
    store,
    fetch: fetchImpl,
    baseUrls = BASE_URLS,
    now,
    monotonic,
    timers,
    timings,
    sourceTimeouts,
    limits,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.fetch = fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrls = baseUrls;
    this.now = now ?? (() => Date.now());
    this.monotonic = monotonic ?? (() => performance.now());
    this.timers = timers === undefined ? { setTimeout, clearTimeout } : timers;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.sourceTimeouts = sourceTimeouts;
    this.limits = { maxRecords: MAX_RECORDS, ...limits };
    this.config = null;
    // True once /data was read: before, a save would write an empty state
    // over it (a stop while getConfig() keeps failing).
    this.loaded = false;
    this.configChain = Promise.resolve();
    this.dataUnreadable = false;
    // What /data held at the start, for the feeds not yet in use (a vehicle
    // of a VIN not decoded yet): written back untouched.
    this.stored = {};
    this.vinDecodeAt = null;
    // The vehicles the VINs were decoded to, by position (from /data): reused
    // by a restart within startDecodeMs, never a VIN.
    this.vinVehicles = [];
    // True while a write of /data does not end within saveWaitMs.
    this.dataHung = false;
    // Every feed met since the start (followed or not any more), by id.
    this.feeds = new Map();
    // The ids of the followed feeds, in the order of the configuration.
    this.active = [];
    // One entry per VIN of the configuration (in memory only).
    this.vinSlots = [];
    // Pauses asked by each host, on the monotonic clock.
    this.pauses = {};
    this.cycleTimer = null;
    this.statusKey = undefined;
    this.running = null;
    this.controller = null;
    this.lastRefreshMono = -Infinity;
    this.refreshTimer = null;
    this.signature = null;
    this.stopped = false;
    // Keys of the failures already logged, so a repeated one is not logged again.
    this.failing = new Set();
  }

  /** Log a failure once (warn or error), then at debug until `recovered(key)`. */
  failed(key, level, message, err) {
    const details = err ? [message, err] : [message];
    if (this.failing.has(key)) {
      logger.debug(...details);
      return;
    }
    this.failing.add(key);
    logger[level](...details);
  }

  /** One line when a failure logged by `failed(key)` is over. */
  recovered(key, message) {
    if (this.failing.delete(key)) {
      logger.info(message);
    }
  }

  intervalMs(config = this.config) {
    return config.refreshHours * this.timings.hourMs;
  }

  /** The age up to which a reading is fresh: two intervals and an hour. */
  freshMs() {
    return 2 * this.intervalMs() + this.timings.hourMs;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    const { data, unreadable } = await this.store.load();
    this.loaded = true;
    this.dataUnreadable = unreadable;
    if (data?.version === 1) {
      const clean = sanitize(data);
      this.stored = clean.feeds;
      this.vinDecodeAt = clean.vinDecodeAt;
      this.vinVehicles = clean.vinVehicles;
      this.restorePauses(clean.pauses);
    }
    const mono = this.monotonic();
    this.syncVinSlots(mono, { restart: true });
    this.syncActive(mono);
    await this.publishDiscovered();
    this.warnAboutConfig();
    logger.info(
      `Started: ${this.active.length + this.vinSlots.length} source(s) followed, read every ${config.refreshHours} h`,
    );
    await this.updateConnectionStatus();
    await this.publishStates();
    this.schedule();
  }

  /** Pauses of /data: honoured after a restart, if not in the future beyond the bound. */
  restorePauses(pauses) {
    const now = this.now();
    const mono = this.monotonic();
    for (const [host, until] of Object.entries(pauses)) {
      if (until > now && until - now <= this.timings.maxPauseMs) {
        this.pauses[host] = mono + (until - now);
      }
    }
  }

  /** Reconnection: Gladys may have restarted, publish everything again. */
  async resync(config) {
    await this.reconfigure(config, { quiet: true });
    await this.publishDiscovered();
    this.statusKey = undefined;
    await this.updateConnectionStatus();
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
    this.requestRefresh();
  }

  /** Configurations are applied one by one, in the order they came: the last wins. */
  reconfigure(config, options) {
    const run = this.configChain.then(() => this.applyConfig(config, options));
    this.configChain = run.catch(() => {});
    return run;
  }

  /** `config` null: the configuration in force is kept (a reconnection after a newer save). */
  async applyConfig(newConfig, { quiet = false } = {}) {
    const config = newConfig ?? this.config;
    const previous = this.config;
    this.config = config;
    if (!quiet) {
      logger.info('Configuration saved');
      this.warnAboutConfig();
    }
    const mono = this.monotonic();
    if (config.refreshHours !== previous?.refreshHours) {
      // The readings that went well follow the new interval from their last attempt.
      for (const feed of this.feeds.values()) {
        if (feed.failures === 0 && feed.attemptMono !== null) {
          feed.nextMono = feed.attemptMono + this.intervalMs(config);
        }
      }
    }
    this.syncVinSlots(mono);
    this.syncActive(mono);
    this.save();
    if (config.language !== previous?.language) {
      await this.publishDiscovered();
    }
    this.schedule();
    if (!quiet) {
      await this.updateConnectionStatus();
      await this.publishStates();
      this.requestRefresh();
    }
  }

  async stop() {
    this.stopped = true;
    this.clearTimer('cycleTimer');
    this.clearTimer('refreshTimer');
    // A request in progress is given up at once (Docker kills after 10 s).
    this.controller?.abort();
    await this.running?.catch(() => {});
    // The last state, never an empty one over /data (save() checks it);
    // waited for saveWaitMs at most (Docker kills after 10 s).
    this.save();
    let timer;
    await Promise.race([
      this.store.flush(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.timings.saveWaitMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  clearTimer(name) {
    if (this[name] !== null && this.timers) {
      this.timers.clearTimeout(this[name]);
    }
    this[name] = null;
  }

  warnAboutConfig() {
    const { categories, vehicles, vins, invalidVehicles, invalidVins } = this.config;
    if (categories.length === 0 && vehicles.length === 0 && vins.length === 0) {
      logger.warn('Nothing followed: no category and no vehicle');
    }
    if (invalidVehicles.length > 0 || invalidVins.length > 0) {
      // Positions only: a VIN is never logged.
      logger.warn(
        `Entries not understood: vehicles ${invalidVehicles.join(', ') || '-'}, VINs ${invalidVins.join(', ') || '-'}`,
      );
    }
  }

  async publishDiscovered() {
    await this.gladys.publishDiscoveredDevices([buildDevice(this.gladys, this.config.language)]);
  }

  isCreated() {
    const id = deviceIds(this.gladys).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === id);
  }

  // --- Feeds and VINs ---------------------------------------------------------

  /** The VIN entries of the configuration; a VIN seen before keeps its state. */
  syncVinSlots(mono, { restart = false } = {}) {
    const previous = new Map(this.vinSlots.map((slot) => [slot.vin, slot]));
    let firstDue = mono;
    let reuse = false;
    if (restart) {
      // A restart decodes at once, unless it did less than startDecodeMs ago
      // (a container restarting in a loop): then the vehicles decoded then,
      // kept by position in /data, serve until the decoding is due again.
      const now = this.now();
      const at = this.vinDecodeAt;
      if (Number.isFinite(at) && at <= now && now - at < this.timings.startDecodeMs) {
        firstDue = mono + (this.timings.startDecodeMs - (now - at));
        reuse = this.vinVehicles.length === this.config.vins.length;
      }
    }
    this.vinSlots = this.config.vins.map(
      (vin, index) =>
        previous.get(vin) ?? {
          vin,
          position: index + 1,
          vehicle: reuse ? vehicleOf(`vehicle:${this.vinVehicles[index]}`) : null,
          error: null,
          failures: 0,
          nextMono: firstDue,
        },
    );
    this.vinSlots.forEach((slot, index) => {
      slot.position = index + 1;
    });
  }

  /** The ids of the followed feeds, their states created (from /data if any). */
  syncActive(mono) {
    const ids = [];
    for (const key of this.config.categories) {
      ids.push(CATEGORY_FEEDS[key]);
    }
    for (const vehicle of this.config.vehicles) {
      ids.push(vehicleFeedId(vehicle));
    }
    for (const slot of this.vinSlots) {
      if (slot.vehicle) {
        ids.push(vehicleFeedId(slot.vehicle));
      }
    }
    this.active = [...new Set(ids)];
    for (const id of this.active) {
      this.feedOf(id, mono);
    }
    // A vehicle no longer followed leaves the memory: its state goes back to
    // the part of /data kept as is (ids seen, times), taken again if it comes back.
    const now = this.now();
    for (const [id, feed] of this.feeds) {
      if (feed.kind === 'vehicle' && !this.active.includes(id)) {
        this.stored[id] = this.persisted(feed, now, mono);
        this.feeds.delete(id);
      }
    }
    const extra = Object.keys(this.stored);
    for (const id of extra.slice(0, Math.max(0, extra.length - MAX_FEEDS))) {
      delete this.stored[id];
    }
  }

  /** A feed as /data keeps it (wall times only). */
  persisted(feed, now, mono) {
    return {
      attemptAt: feed.attemptAt,
      nextAt: Number.isFinite(feed.nextMono) ? now + (feed.nextMono - mono) : null,
      readAt: feed.readAt,
      stale: feed.stale,
      sourceDay: feed.sourceDay,
      truncated: feed.truncated,
      etag: feed.etag,
      query: feed.query,
      known: feed.known === null ? null : [...feed.known],
      pending: feed.pending,
      records: feed.records,
    };
  }

  /** The state of a feed, created on first use from /data. */
  feedOf(id, mono = this.monotonic()) {
    let feed = this.feeds.get(id);
    if (feed) {
      return feed;
    }
    const { kind, host } = kindOf(id);
    const vehicle = kind === 'vehicle' ? vehicleOf(id) : null;
    feed = {
      id,
      kind,
      host,
      vehicle,
      label: vehicle ? vehicleLabel(vehicle) : undefined,
      records: [],
      readAt: null,
      readMono: null,
      stale: false,
      sourceDay: null,
      truncated: false,
      error: null,
      failures: 0,
      attemptAt: null,
      attemptMono: null,
      nextMono: mono,
      known: null,
      pending: [],
      etag: null,
      query: null,
    };
    const stored = this.stored[id];
    if (stored) {
      delete this.stored[id];
      const now = this.now();
      feed.records = stored.records ?? [];
      feed.readAt = stored.records ? stored.readAt : null;
      if (feed.readAt !== null && now - feed.readAt >= 0) {
        // A date of /data in the future is not trusted.
        feed.readMono = mono - (now - feed.readAt);
      }
      feed.stale = stored.stale;
      feed.sourceDay = stored.sourceDay;
      feed.truncated = stored.truncated;
      feed.known = stored.known === null ? null : new Set(stored.known);
      feed.pending = stored.pending;
      feed.etag = stored.records ? stored.etag : null;
      feed.query = stored.records ? stored.query : null;
      feed.attemptAt = stored.attemptAt;
      feed.nextMono = mono + this.restartDelay(stored, now);
    }
    this.feeds.set(id, feed);
    return feed;
  }

  /** Time to wait after a restart: the rest of the interval of the last attempt. */
  restartDelay({ attemptAt, nextAt }, now) {
    const interval = this.intervalMs();
    let wait = 0;
    // A date of /data in the future is not trusted.
    if (attemptAt !== null && attemptAt <= now) {
      wait = nextAt !== null && nextAt >= attemptAt ? nextAt - now : attemptAt + interval - now;
    }
    return Math.min(Math.max(0, wait), interval);
  }

  /** When an item is due: its time, or the end of the pause of its host. */
  dueMono(item, host) {
    return Math.max(item.nextMono ?? Infinity, this.pauses[host] ?? -Infinity);
  }

  paused(host, mono) {
    return (this.pauses[host] ?? -Infinity) > mono;
  }

  schedule() {
    if (!this.timers || this.stopped) {
      return;
    }
    this.clearTimer('cycleTimer');
    if (this.running) {
      // Scheduled again when the running check ends.
      return;
    }
    const due = [
      ...this.vinSlots.map((slot) => this.dueMono(slot, 'vpic')),
      ...this.active.map((id) => this.dueMono(this.feeds.get(id), this.feeds.get(id).host)),
    ].filter(Number.isFinite);
    if (due.length === 0) {
      return;
    }
    const wait = Math.max(0, Math.min(...due) - this.monotonic());
    this.cycleTimer = this.timers.setTimeout(() => {
      this.cycleTimer = null;
      this.runCycle();
    }, wait);
    this.cycleTimer?.unref?.();
  }

  // --- Selection ---------------------------------------------------------------

  /** CPSC and FDA: naming a followed word, if any; vehicles: always. */
  selected(recall) {
    const { keywords } = this.config;
    if (recall.category === 'vehicles' || keywords.length === 0) {
      return true;
    }
    const words = ` ${fold(`${recall.title} ${recall.product} ${recall.firm}`)} `;
    return keywords.some((keyword) => words.includes(` ${keyword} `));
  }

  /** The recalls of the selection of the last 7 days, from the given feeds. */
  weekOf(feeds, wall) {
    const from = dayBefore(localDay(wall), WEEK_DAYS - 1);
    return feeds
      .flatMap((feed) => feed.records)
      .filter((recall) => recall.day !== null && recall.day >= from && this.selected(recall))
      .sort(newestFirst);
  }

  // --- Checks ------------------------------------------------------------------

  runCycle() {
    if (this.running || this.stopped) {
      return this.running;
    }
    this.running = this.cycle()
      .catch((err) => this.failed('cycle', 'error', 'Check failed', err))
      .finally(() => {
        this.running = null;
        this.controller = null;
        this.schedule();
      });
    return this.running;
  }

  /** Waits between two requests (none in the virtual-clock tests). */
  gap() {
    const ms = this.timings.requestGapMs;
    if (!this.timers || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(resolve, ms);
      timer?.unref?.();
    });
  }

  /** Save, waiting `saveWaitMs` at most: a frozen /data never holds a reading. */
  saveWithin() {
    const saving = this.save();
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, this.timings.saveWaitMs);
      timer.unref?.();
    });
    return Promise.race([saving.then(() => true), bound.then(() => false)]).then((ended) => {
      clearTimeout(timer);
      if (ended === this.dataHung) {
        // Turned hung (or back): said in the status.
        this.dataHung = !ended;
        this.statusKey = undefined;
      }
      return ended;
    });
  }

  async cycle() {
    this.controller = new AbortController();
    const budget = { events: MAX_EVENTS_PER_CYCLE };
    let requests = 0;
    for (const slot of [...this.vinSlots]) {
      const mono = this.monotonic();
      if (this.stopped || !this.vinSlots.includes(slot) || this.dueMono(slot, 'vpic') > mono) {
        continue;
      }
      if (requests > 0) {
        await this.gap();
      }
      requests += 1;
      await this.decode(slot);
    }
    for (const id of [...this.active]) {
      const feed = this.feeds.get(id);
      const mono = this.monotonic();
      if (this.stopped || !this.active.includes(id) || this.dueMono(feed, feed.host) > mono) {
        continue;
      }
      if (requests > 0) {
        await this.gap();
      }
      requests += 1;
      await this.read(feed, budget);
    }
    if (this.stopped) {
      return;
    }
    this.save();
    await this.publishStates();
    await this.updateConnectionStatus();
    const signature = this.active
      .map((id) => this.feeds.get(id))
      .map((feed) => `${feed.id}:${feed.readAt}:${feed.records.length}`)
      .join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      this.requestRefresh();
    }
  }

  /** Decode one VIN (vPIC); the vehicle found joins the followed feeds. */
  async decode(slot) {
    const startMono = this.monotonic();
    const startWall = this.now();
    this.vinDecodeAt = startWall;
    slot.nextMono = startMono + this.timings.vinRedecodeMs;
    await this.saveWithin();
    try {
      const vehicle = await decodeVin({
        fetch: this.fetch,
        vin: slot.vin,
        baseUrls: this.baseUrls,
        timeouts: this.sourceTimeouts,
        signal: this.controller.signal,
        maxYear: new Date(startWall).getUTCFullYear() + 2,
      });
      if (this.stopped || !this.vinSlots.includes(slot)) {
        return;
      }
      slot.vehicle = vehicle;
      slot.error = null;
      slot.failures = 0;
      this.recovered(`vin${slot.position}`, `VIN ${slot.position} decoded again`);
      logger.debug(`VIN ${slot.position} decoded: ${vehicleLabel(vehicle)}`);
      this.syncActive(this.monotonic());
    } catch (err) {
      if (this.stopped || !this.vinSlots.includes(slot)) {
        return;
      }
      slot.failures += 1;
      slot.error = { kind: err.kind ?? 'network', status: err.status ?? null };
      // An unknown VIN will not be known in an hour: tried again after the
      // interval; a failure of the network after the usual backoff.
      const wait =
        slot.error.kind === 'vinUnknown'
          ? this.intervalMs()
          : this.failureWait(err, slot.failures, 'vpic', startMono);
      slot.nextMono = startMono + wait;
      this.failed(
        `vin${slot.position}`,
        'warn',
        `VIN ${slot.position} cannot be decoded: ${err.message}`,
      );
    }
  }

  /** The wait after a failure; a 429 or a 5xx also pauses the host. */
  failureWait(err, failures, host, startMono) {
    const { retryMs, minPauseMs, maxPauseMs } = this.timings;
    let wait = Math.min(this.intervalMs(), retryMs * 2 ** Math.min(failures - 1, 10));
    const status = err.status ?? null;
    if (status === 429 || (status !== null && status >= 500)) {
      // Retry-After when given, else the backoff, between 1 minute and 6 hours.
      wait = Math.min(maxPauseMs, Math.max(minPauseMs, err.retryAfterMs ?? wait));
      this.pauses[host] = startMono + wait;
    }
    return wait;
  }

  /** Read one feed, fire its new recalls, keep the result. */
  async read(feed, budget) {
    const startMono = this.monotonic();
    const startWall = this.now();
    const interval = this.intervalMs();
    feed.attemptMono = startMono;
    // The next reading is armed before anything is awaited: a slow /data or a
    // failure never leaves the feed without one.
    feed.nextMono = startMono + interval;
    feed.attemptAt = startWall;
    await this.saveWithin();
    if (this.stopped) {
      return;
    }
    const today = localDay(startWall);
    let result;
    try {
      result = await readFeed({
        fetch: this.fetch,
        feed,
        fromDay: dayBefore(today, WINDOW_DAYS),
        // Tomorrow: a report dated in the east of the country is never missed.
        toDay: dayBefore(today, -1),
        copy: feed.readAt === null ? null : feed,
        baseUrls: this.baseUrls,
        timeouts: this.sourceTimeouts,
        signal: this.controller.signal,
        maxRecords: this.limits.maxRecords,
      });
    } catch (err) {
      if (!this.stopped) {
        this.onFailure(feed, err, startMono);
      }
      return;
    }
    if (this.stopped) {
      return;
    }
    if (!result.modified && feed.readAt === null) {
      // A 304 for a copy no longer kept: read in full next time.
      feed.etag = null;
      const err = new Error('304 without a copy');
      err.kind = 'format';
      this.onFailure(feed, err, startMono);
      return;
    }
    feed.failures = 0;
    feed.error = null;
    this.recovered(`feed:${feed.id}`, `${feedName(feed, 'en')} can be read again`);

    let pending;
    if (result.modified) {
      const ids = result.records.map((record) => record.id);
      if (feed.known === null) {
        logger.info(
          `${feedName(feed, 'en')}: first reading, ${ids.length} recall(s) taken as known`,
        );
        pending = [];
      } else {
        const fresh = ids.filter((id) => !feed.known.has(id));
        pending = [...new Set([...feed.pending, ...fresh])];
      }
      const known = new Set([...(feed.known ?? []), ...ids]);
      feed.known = known.size > MAX_KNOWN ? new Set([...known].slice(-MAX_KNOWN)) : known;
      feed.records = result.records;
      feed.etag = result.etag;
      feed.query = result.query;
      feed.sourceDay = result.sourceDay;
      feed.truncated = result.truncated;
      if (result.skipped > 0) {
        logger.debug(`${feedName(feed, 'en')}: ${result.skipped} entr(ies) unreadable, skipped`);
      }
    } else {
      pending = feed.pending;
    }
    // openFDA only: its last load, compared to the Date header of the server
    // (never to the local clock; without both, never stale).
    const loaded = feed.sourceDay === null ? null : Date.parse(`${feed.sourceDay}T00:00:00Z`);
    feed.stale = result.date !== null && loaded !== null && result.date - loaded > FDA_STALE_MS;
    feed.pending = await this.fireNew(feed, pending, startWall, budget);
    feed.readAt = startWall;
    feed.readMono = startMono;
    this.recovered('cycle', 'Checks work again');
    logger.debug(
      `${feedName(feed, 'en')}: ${result.modified ? `${feed.records.length} recall(s)` : 'unchanged (304)'}`,
    );
  }

  onFailure(feed, err, startMono) {
    feed.failures += 1;
    feed.error = { kind: err.kind ?? 'network', status: err.status ?? null };
    const wait = this.failureWait(err, feed.failures, feed.host, startMono);
    feed.nextMono = startMono + wait;
    this.failed(
      `feed:${feed.id}`,
      'warn',
      `${feedName(feed, 'en')} cannot be read: ${err.message}`,
    );
  }

  /**
   * Fire the scene trigger for the pending ids still worth it; returns the ids
   * left pending (refused by Gladys, or beyond the cap of the check).
   */
  async fireNew(feed, pending, wall, budget) {
    if (pending.length === 0) {
      return [];
    }
    const byId = new Map(feed.records.map((record) => [record.id, record]));
    const from = dayBefore(localDay(wall), FIRE_DAYS - 1);
    const toFire = pending
      .map((id) => byId.get(id))
      .filter(
        (record) =>
          record !== undefined &&
          this.selected(record) &&
          (feed.kind === 'vehicle' || record.day === null || record.day >= from),
      )
      // Oldest first, so the scenes hear them in the order of publication.
      .sort(newestFirst)
      .reverse();
    const left = [];
    for (const record of toFire) {
      if (budget.events <= 0 || this.stopped) {
        left.push(record.id);
        continue;
      }
      budget.events -= 1;
      if (!(await this.fire(record))) {
        left.push(record.id);
      }
    }
    if (left.length > 0) {
      logger.debug(`${feedName(feed, 'en')}: ${left.length} new recall(s) left for the next check`);
    }
    // Beyond the cap, the oldest are dropped: said in the status.
    feed.droppedEvents = Math.max(0, left.length - MAX_PENDING);
    return left.slice(-MAX_PENDING);
  }

  /** Fire one scene event; true once Gladys accepted it. */
  async fire(recall) {
    logger.debug(`New recall: ${recall.feed} ${recall.id}`);
    try {
      await this.gladys.publishSceneEvent(TRIGGERS.NEW, this.eventData(recall));
      this.recovered('scene', 'Scene triggers work again');
      return true;
    } catch (err) {
      this.failed('scene', 'warn', `Firing the scene trigger failed: ${err.message}`);
      return false;
    }
  }

  /** The flat data of a scene event (fields, then variables of the manifest). */
  eventData(recall) {
    const language = this.config.language;
    return {
      category: recall.category,
      category_name: CATEGORY_NAMES[language][recall.category],
      title: clip(recall.title, MAX_VARIABLE),
      product: clip(recall.product, MAX_VARIABLE),
      firm: clip(recall.firm, MAX_VARIABLE),
      issue: clip(recall.issue, MAX_VARIABLE),
      remedy: clip(recall.remedy, MAX_VARIABLE),
      recall_class: recall.recallClass,
      vehicle: recall.vehicle,
      day: recall.day ?? '',
      url: recall.url,
      summary: clip(
        PHRASES[language].summary({
          title: clip(recall.title, 300),
          issue: clip(recall.issue, 300),
        }),
        MAX_VARIABLE * 2,
      ),
    };
  }

  // --- /data ---------------------------------------------------------------------

  /** The state for /data (wall times only); never a VIN. */
  toData() {
    const now = this.now();
    const mono = this.monotonic();
    const wall = (at) => (Number.isFinite(at) ? now + (at - mono) : null);
    const feeds = {};
    const ordered = [
      ...this.active.map((id) => this.feeds.get(id)),
      ...[...this.feeds.values()]
        .filter((feed) => !this.active.includes(feed.id))
        .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0)),
    ];
    for (const feed of ordered) {
      feeds[feed.id] = this.persisted(feed, now, mono);
    }
    // Feeds of /data not in use yet (a vehicle of a VIN not decoded yet).
    for (const [id, feed] of Object.entries(this.stored)) {
      feeds[id] ??= feed;
    }
    const kept = Object.fromEntries(Object.entries(feeds).slice(0, MAX_FEEDS));
    const pauses = {};
    for (const [host, until] of Object.entries(this.pauses)) {
      if (until > mono) {
        pauses[host] = wall(until);
      }
    }
    // The vehicles of the VINs by position, never a VIN: those of /data until
    // a decoding of this run.
    const vinVehicles = this.vinSlots.some((slot) => slot.vehicle)
      ? this.vinSlots.map((slot) => (slot.vehicle ? vehicleKey(slot.vehicle) : null))
      : this.vinVehicles;
    return { version: 1, vinDecodeAt: this.vinDecodeAt, vinVehicles, pauses, feeds: kept };
  }

  save() {
    if (!this.loaded) {
      return Promise.resolve(false);
    }
    return this.store.save(this.toData());
  }

  // --- States ------------------------------------------------------------------

  /** 'none' (never read), 'old' (too old, or of an unknown age), 'stale' or 'fresh'. */
  freshnessOf(feed, mono) {
    if (feed.readAt === null) {
      return 'none';
    }
    if (feed.readMono === null || mono - feed.readMono > this.freshMs()) {
      return 'old';
    }
    return feed.stale ? 'stale' : 'fresh';
  }

  /**
   * Everything the texts need, read once: the followed feeds with their
   * freshness, the VINs not decoded, and the overall state:
   * 'empty' (nothing followed), 'none' (nothing read yet), 'fresh' (every
   * followed source up to date) or 'notFresh'.
   */
  survey() {
    const mono = this.monotonic();
    const wall = this.now();
    const feeds = this.active.map((id) => {
      const feed = this.feeds.get(id);
      return { feed, freshness: this.freshnessOf(feed, mono) };
    });
    const vins = this.vinSlots.filter((slot) => slot.vehicle === null);
    const all = [...feeds.map((f) => f.freshness), ...vins.map(() => 'none')];
    let overall = 'notFresh';
    if (all.length === 0) {
      overall = 'empty';
    } else if (all.every((f) => f === 'fresh')) {
      overall = 'fresh';
    } else if (all.every((f) => f === 'none')) {
      overall = 'none';
    }
    return { mono, wall, feeds, vins, overall };
  }

  statesOf(survey) {
    if (survey.overall !== 'fresh' || !this.isCreated()) {
      return [];
    }
    const ids = deviceIds(this.gladys);
    const language = this.config.language;
    const feeds = survey.feeds.map((f) => f.feed);
    const week = this.weekOf(feeds, survey.wall);
    const [latest] = week;
    const states = [
      { device_feature_external_id: ids.week, state: Math.min(week.length, MAX_COUNT) },
      {
        device_feature_external_id: ids.latest,
        text: latest ? describe(latest, language) : PHRASES[language].none,
      },
    ];
    const vehicles = feeds.filter((feed) => feed.kind === 'vehicle');
    if (vehicles.length > 0) {
      const count = vehicles.reduce((sum, feed) => sum + feed.records.length, 0);
      states.push({
        device_feature_external_id: ids.vehicles,
        state: Math.min(count, MAX_COUNT),
      });
    }
    return states;
  }

  async publishStates() {
    const states = this.statesOf(this.survey());
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.recovered('publish', 'Publishing the states works again');
    } catch (err) {
      // Sent again at the next check (the SDK forgets what Gladys refused).
      this.failed('publish', 'warn', `Publishing the states failed: ${err.message}`);
    }
  }

  async updateConnectionStatus() {
    const survey = this.survey();
    const { mono, wall } = survey;
    const parts = [];
    const names = (feeds) => (l) => ({
      names: listOf(
        feeds.map((f) => feedName(f, l)),
        l,
      ),
    });
    for (const { feed } of survey.feeds) {
      if (feed.error !== null) {
        parts.push(
          renderEach(STATUS, 'feedDown', (l) => ({
            name: feedName(feed, l),
            error: describeError(feed.error, l),
          })),
        );
      }
    }
    for (const slot of this.vinSlots) {
      if (slot.error !== null) {
        parts.push(
          renderEach(STATUS, 'vinFailed', (l) => ({
            name: feedName(slot, l),
            error: describeError(slot.error, l),
          })),
        );
      }
    }
    for (const [host, until] of Object.entries(this.pauses)) {
      if (until > mono) {
        const feed = [...survey.feeds.map((f) => f.feed), ...this.vinSlots].find(
          (item) => (item.host ?? 'vpic') === host,
        );
        if (feed) {
          const at = wall + (until - mono);
          parts.push(
            renderEach(STATUS, 'paused', (l) => ({
              name: feedName(feed, l).replace(/ \(.*\)$/, ''),
              time: formatTime(at, l),
            })),
          );
        }
      }
    }
    const waiting = [
      ...survey.feeds
        .filter((f) => f.freshness === 'none' && f.feed.error === null)
        .map((f) => f.feed),
      ...survey.vins.filter((slot) => slot.error === null),
    ];
    if (waiting.length > 0) {
      parts.push(renderEach(STATUS, 'waiting', names(waiting)));
    }
    for (const { feed } of survey.feeds) {
      if (feed.stale && feed.readAt !== null) {
        parts.push(
          renderEach(STATUS, 'stale', (l) => ({
            name: feedName(feed, l),
            day: formatSourceDay(feed.sourceDay, l),
          })),
        );
      }
    }
    const { invalidVehicles, invalidVins, droppedVehicles } = this.config;
    if (survey.overall === 'empty') {
      parts.push(render(STATUS, 'nothingFollowed'));
    }
    if (invalidVehicles.length > 0) {
      parts.push(render(STATUS, 'invalidVehicles', { positions: invalidVehicles.join(', ') }));
    }
    if (invalidVins.length > 0) {
      parts.push(render(STATUS, 'invalidVins', { positions: invalidVins.join(', ') }));
    }
    if (droppedVehicles > 0) {
      parts.push(render(STATUS, 'tooManyVehicles', { count: droppedVehicles }));
    }
    const empty = survey.feeds
      .map((f) => f.feed)
      .filter(
        (feed) => feed.kind === 'vehicle' && feed.readAt !== null && feed.records.length === 0,
      );
    if (empty.length > 0) {
      parts.push(
        renderEach(STATUS, 'noCampaign', (l) => ({
          names: listOf(
            empty.map((f) => f.label),
            l,
          ),
        })),
      );
    }
    const truncated = survey.feeds.map((f) => f.feed).filter((feed) => feed.truncated);
    if (truncated.length > 0) {
      parts.push(renderEach(STATUS, 'truncated', names(truncated)));
    }
    if (this.dataUnreadable) {
      parts.push(render(STATUS, 'dataUnreadable'));
    } else if (!this.store.writable || this.store.writeFailed) {
      parts.push(render(STATUS, 'dataUnwritable'));
    } else if (this.dataHung) {
      parts.push(render(STATUS, 'dataHung'));
    }
    const dropped = survey.feeds.map((f) => f.feed).filter((feed) => feed.droppedEvents > 0);
    if (dropped.length > 0) {
      parts.push(renderEach(STATUS, 'eventsDropped', names(dropped)));
    }
    const joined = parts.length > 0 ? join(...parts) : undefined;
    const message = joined
      ? Object.fromEntries(Object.entries(joined).map(([l, text]) => [l, clip(text, MAX_STATUS)]))
      : undefined;
    const failing =
      survey.feeds.some((f) => f.feed.error !== null) ||
      this.vinSlots.some((slot) => slot.error !== null);
    // Connected: something followed, everything read once, no failure now.
    const connected =
      !failing &&
      survey.overall !== 'empty' &&
      survey.vins.length === 0 &&
      survey.feeds.every((f) => f.freshness !== 'none');
    const key = JSON.stringify([connected, message]);
    if (key === this.statusKey) {
      return;
    }
    this.statusKey = key;
    await this.gladys.setConnectionStatus(connected, message).catch(() => {});
  }

  // --- Gladys events -----------------------------------------------------------

  async onDeviceCreated(device) {
    if (device?.external_id !== deviceIds(this.gladys).device) {
      return;
    }
    // The SDK forgot the states of the device: published again, if fresh.
    await this.publishStates();
    this.requestRefresh();
  }

  /** onPoll fallback: should_poll is false; a Gladys polling anyway gets the fresh states. */
  async poll(device) {
    if (device?.external_id !== deviceIds(this.gladys).device) {
      return;
    }
    await this.publishStates();
  }

  /**
   * What the actions and the widget show: never a new request. `freshness`
   * is the overall state of `survey()`; `warning` (multi-language) says what
   * is not up to date, or that the last reading of a fresh source failed;
   * `recalls` and `vehicles` come from the fresh feeds only.
   */
  snapshot() {
    const survey = this.survey();
    const fresh = survey.feeds.filter((f) => f.freshness === 'fresh').map((f) => f.feed);
    const recalls = this.weekOf(fresh, survey.wall);
    const vehicles = fresh
      .filter((feed) => feed.kind === 'vehicle')
      .map((feed) => ({ label: feed.label, records: [...feed.records].sort(newestFirst) }));
    const parts = [];
    const notYet = [
      ...survey.feeds.filter((f) => f.freshness === 'none').map((f) => f.feed),
      ...survey.vins,
    ];
    if (notYet.length > 0) {
      parts.push(
        renderEach(STATUS, 'notYet', (l) => ({
          names: listOf(
            notYet.map((f) => feedName(f, l)),
            l,
          ),
        })),
      );
    }
    const late = survey.feeds.filter((f) => f.freshness === 'old' || f.freshness === 'stale');
    if (late.length > 0) {
      parts.push(
        renderEach(STATUS, 'old', (l) => ({
          items: listOf(
            late.map(({ feed, freshness }) =>
              freshness === 'stale'
                ? STATUS[l].staleItem({
                    name: feedName(feed, l),
                    day: formatSourceDay(feed.sourceDay, l),
                  })
                : STATUS[l].oldItem({ name: feedName(feed, l), time: formatDate(feed.readAt, l) }),
            ),
            l,
          ),
        })),
      );
    }
    // Still fresh, but the last reading failed: said along with the recalls.
    const failed = survey.feeds.filter((f) => f.freshness === 'fresh' && f.feed.error !== null);
    if (failed.length > 0) {
      parts.push(
        renderEach(STATUS, 'lastFailed', (l) => ({
          items: listOf(
            failed.map(({ feed }) =>
              STATUS[l].lastFailedItem({
                name: feedName(feed, l),
                error: describeError(feed.error, l),
                time: formatDate(feed.readAt, l),
              }),
            ),
            l,
          ),
        })),
      );
    }
    if (survey.overall === 'empty') {
      parts.push(render(STATUS, 'nothingFollowed'));
    }
    const readAts = fresh.map((feed) => feed.readAt);
    return {
      recalls,
      vehicles,
      freshness: survey.overall,
      warning: parts.length > 0 ? join(...parts) : null,
      // The oldest reading the values come from.
      readAt: readAts.length > 0 ? Math.min(...readAts) : null,
      followsVehicles:
        survey.feeds.some((f) => f.feed.kind === 'vehicle') || this.vinSlots.length > 0,
    };
  }

  // --- Widget -------------------------------------------------------------------

  requestRefresh() {
    if (this.stopped) {
      return;
    }
    const mono = this.monotonic();
    const wait = this.lastRefreshMono + this.timings.widgetRefreshMs - mono;
    if (wait <= 0) {
      this.lastRefreshMono = mono;
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } else if (this.timers && this.refreshTimer === null) {
      this.refreshTimer = this.timers.setTimeout(() => {
        this.refreshTimer = null;
        this.requestRefresh();
      }, wait);
      this.refreshTimer?.unref?.();
    }
  }
}

// --- What /data may hold ------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9-]{1,30}$/;
const isText = (value) => typeof value === 'string';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_FIELDS = [
  'id',
  'feed',
  'category',
  'title',
  'product',
  'firm',
  'issue',
  'remedy',
  'recallClass',
  'url',
  'vehicle',
];
const FEED_RE =
  /^(cpsc|fda-food|fda-drug|fda-device|vehicle:[A-Z0-9 .\-/&']{1,40}\|[A-Z0-9 .\-/&']{1,40}\|\d{4})$/;
const finite = (value) => (Number.isFinite(value) ? value : null);
const ids = (list, max) =>
  Array.isArray(list) ? list.filter((id) => isText(id) && ID_RE.test(id)).slice(-max) : [];

function sanitizeFeed(id, feed) {
  const records = Array.isArray(feed.records)
    ? feed.records
        .filter(
          (r) =>
            r &&
            TEXT_FIELDS.every((key) => isText(r[key])) &&
            ID_RE.test(r.id) &&
            r.feed === id &&
            (r.day === null || DAY_RE.test(r.day)),
        )
        .slice(0, MAX_RECORDS)
        .map((r) => ({ ...r, serious: r.serious === true }))
    : null;
  return {
    attemptAt: finite(feed.attemptAt),
    nextAt: finite(feed.nextAt),
    readAt: records === null ? null : finite(feed.readAt),
    stale: feed.stale === true,
    sourceDay: isText(feed.sourceDay) && DAY_RE.test(feed.sourceDay) ? feed.sourceDay : null,
    truncated: feed.truncated === true,
    etag: isText(feed.etag) ? feed.etag : null,
    query: isText(feed.query) ? feed.query : null,
    known: Array.isArray(feed.known) ? ids(feed.known, MAX_KNOWN) : null,
    pending: ids(feed.pending, MAX_PENDING),
    records,
  };
}

/** Only what has the expected shape is taken from /data. */
export function sanitize(data) {
  const feeds = {};
  const source = data.feeds && typeof data.feeds === 'object' ? data.feeds : {};
  for (const [id, feed] of Object.entries(source).slice(0, MAX_FEEDS)) {
    if (FEED_RE.test(id) && feed && typeof feed === 'object') {
      feeds[id] = sanitizeFeed(id, feed);
    }
  }
  const pauses = {};
  for (const host of ['cpsc', 'fda', 'nhtsa', 'vpic']) {
    const until = finite(data.pauses?.[host]);
    if (until !== null) {
      pauses[host] = until;
    }
  }
  const vinVehicles = Array.isArray(data.vinVehicles)
    ? data.vinVehicles
        .slice(0, 3)
        .map((key) => (isText(key) && FEED_RE.test(`vehicle:${key}`) ? key : null))
    : [];
  return { feeds, pauses, vinDecodeAt: finite(data.vinDecodeAt), vinVehicles };
}

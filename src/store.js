// -----------------------------------------------------------------------------
// Persistence under /data (the only writable path of the container): for each
// source read (a "feed"), the recent recalls kept from its last answer with
// the time they were read, the ids already seen, the events still to send,
// the time of the last attempt and of the next one; the pauses asked by each
// host. So a restart publishes what is still fresh, fires nothing already
// seen, and never reads faster than the interval.
//
// Never a VIN: the vehicles decoded from a VIN are kept under their make,
// model and year, like the typed ones.
//
// A missing file is a first start. A file that cannot be read is not taken as
// empty: `load()` says so (`unreadable`), and the monitor then keeps its state
// in memory and writes nothing over it, except a file that is not JSON at all,
// moved aside to `<name>.bad` once, then started afresh.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'recalls-us-store' });
export const FILE_NAME = 'recalls-us.json';
// Above a full state (16 feeds of 1,000 recalls of 3 KB at most, 5,000 ids
// each): never written larger (serialize() drops the recalls kept first,
// never the ids seen).
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class Store {
  constructor(
    directory = process.env.RECALLS_US_DATA_DIR || '/data',
    { maxFileBytes = MAX_FILE_BYTES } = {},
  ) {
    this.maxFileBytes = maxFileBytes;
    this.directory = directory;
    this.path = join(directory, FILE_NAME);
    this.pending = null;
    this.writing = null;
    this.latest = null;
    // A failing disk would fail every save: logged once, then at debug.
    this.writeFailed = false;
    // false while /data holds a file that could not be read.
    this.writable = true;
  }

  /** `{ data, unreadable }`: data is null for a first start or an unreadable file. */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { data: null, unreadable: false };
      }
      logger.warn(`Cannot read ${this.path}: ${err.code ?? 'error'}`);
      this.writable = false;
      return { data: null, unreadable: true };
    }
    if (text.length > this.maxFileBytes) {
      logger.warn(`${this.path} is too large (${text.length} bytes): ignored`);
      return this.setAside();
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return { data, unreadable: false };
      }
    } catch {
      // handled below
    }
    logger.warn(`${this.path} is not valid JSON`);
    return this.setAside();
  }

  async setAside() {
    try {
      await rename(this.path, `${this.path}.bad`);
      logger.warn(`${this.path} moved to ${FILE_NAME}.bad`);
    } catch (err) {
      logger.warn(`Cannot move ${this.path} aside: ${err.code ?? 'error'}`);
      this.writable = false;
    }
    return { data: null, unreadable: true };
  }

  /**
   * /data is created by the image (Dockerfile): it is never created here, so
   * nothing is written anywhere else. Writes are coalesced and atomic
   * (temporary file + rename): a crash never leaves half a JSON file behind.
   * Resolves to true once this state (or a later one) is on disk, false if
   * the write failed or is not allowed. Callers never wait for it without a
   * bound (src/monitor.js): a frozen disk holds no reading.
   */
  save(data) {
    this.latest = data;
    if (!this.writable) {
      return Promise.resolve(false);
    }
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.serialize(this.latest);
        this.pending = null;
        try {
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, snapshot);
          await rename(temporary, this.path);
          if (this.writeFailed) {
            this.writeFailed = false;
            logger.info(`${this.path} written again`);
          }
          return true;
        } catch (err) {
          if (this.writeFailed) {
            logger.debug(`Cannot write ${this.path}: ${err.code ?? 'error'}`);
          } else {
            this.writeFailed = true;
            logger.warn(`Cannot write ${this.path}: ${err.code ?? 'error'}`);
          }
          return false;
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /**
   * The JSON of the state, within MAX_FILE_BYTES: the recalls kept go first
   * (with the time they were read and their validator, so a restart reads
   * them again instead of taking an empty copy for current); the ids seen and
   * the pending events stay.
   */
  serialize(data) {
    let text = JSON.stringify(data);
    if (text.length <= this.maxFileBytes) {
      return text;
    }
    logger.warn(`State of ${text.length} bytes: the recalls kept are dropped`);
    const feeds = Object.fromEntries(
      Object.entries(data.feeds ?? {}).map(([id, feed]) => [
        id,
        { ...feed, records: null, readAt: null, etag: null, query: null },
      ]),
    );
    text = JSON.stringify({ ...data, feeds });
    return text;
  }

  /** Resolves once every write requested so far is on disk (or failed). */
  async flush() {
    await this.writing;
  }
}

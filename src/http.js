// -----------------------------------------------------------------------------
// One bounded JSON GET: the request every source of the integration makes.
//
// - honest User-Agent naming the integration (version read from package.json,
//   copied into the image), never a browser's;
// - no redirect followed; no answer in 30 s, no byte for 30 s, or the whole
//   answer in more than 2 minutes: given up;
// - the body is counted while it arrives and cut beyond `maxBytes` (16 MB by
//   default): an endless or oversized answer never fills the memory;
// - errors carry the host only, never the URL: the path of a VIN decoding
//   holds the VIN, and no error, log or status ever repeats it.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const USER_AGENT = `gladys-recalls-us/${VERSION} (Gladys Assistant integration; +https://github.com/LM1LC3N7/gladys-recalls-us)`;

export const MAX_BYTES = 16 * 1024 * 1024;
export const HEADERS_TIMEOUT_MS = 30000;
export const STALL_TIMEOUT_MS = 30000;
export const TOTAL_TIMEOUT_MS = 2 * 60000;

export class SourceError extends Error {
  /**
   * @param {string} message for the logs (English, technical, without URL)
   * @param {object} [details] kind (see ERRORS in messages.js), status (HTTP), retryAfterMs
   */
  constructor(message, { kind = 'network', status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Network codes of Node and undici, as kinds of error people can read.
const NETWORK_KINDS = {
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNREFUSED: 'refused',
  ECONNRESET: 'closed',
  EPIPE: 'closed',
  UND_ERR_SOCKET: 'closed',
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
};
// Codes repeated in the logs: plain words, never a message that could hold
// the URL.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** The kind of a fetch failure, from its cause. */
export function networkKind(err) {
  const code = err?.cause?.code ?? err?.code;
  if (NETWORK_KINDS[code]) {
    return NETWORK_KINDS[code];
  }
  if (/redirect/i.test(`${err?.cause?.message ?? ''} ${err?.message ?? ''}`)) {
    return 'redirect';
  }
  return 'network';
}

const safeCode = (err) => {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'request failed';
};

/** An HTTP date in ms, or null. */
export function httpDate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Retry-After in ms (seconds or an HTTP date, against the Date header), or null. */
export function retryAfterMs(headers) {
  const value = headers.get('retry-after');
  if (value === null) {
    return null;
  }
  if (/^\d{1,9}$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const at = httpDate(value);
  const date = httpDate(headers.get('date'));
  return at !== null && date !== null ? Math.max(0, at - date) : null;
}

/**
 * GET a JSON document.
 *
 * @param {object} options
 * @param {Function} options.fetch
 * @param {string} options.url
 * @param {string|null} [options.etag] sent as If-None-Match (plain text only)
 * @param {(status: number) => boolean} [options.accept] statuses besides 200
 *   whose JSON body is returned (openFDA: 404 "No matches found!"; NHTSA: 400
 *   for a vehicle without recall)
 * @param {AbortSignal|null} [options.signal] the integration stops
 * @returns {Promise<object>} `{ status: 304, date }` or `{ status, json, etag, date }`
 */
export async function getJson({
  fetch: fetchImpl,
  url,
  etag = null,
  accept = () => false,
  maxBytes = MAX_BYTES,
  timeouts = {},
  signal = null,
}) {
  const host = new URL(url).host;
  const limits = {
    headers: HEADERS_TIMEOUT_MS,
    stall: STALL_TIMEOUT_MS,
    total: TOTAL_TIMEOUT_MS,
    ...timeouts,
  };
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (etag && /^[\x20-\x7e]{1,200}$/.test(etag)) {
    headers['If-None-Match'] = etag;
  }
  const controller = new AbortController();
  let reason = null;
  let kind = null;
  const abort = (why, why2) => {
    reason ??= why;
    kind ??= why2;
    controller.abort();
  };
  const onStop = () => abort('stopped', 'stopped');
  if (signal?.aborted) {
    onStop();
  }
  signal?.addEventListener('abort', onStop, { once: true });
  const total = setTimeout(
    () => abort(`not read in ${limits.total / 1000} s`, 'tooLong'),
    limits.total,
  );
  let stall = setTimeout(
    () => abort(`no answer in ${limits.headers / 1000} s`, 'timeout'),
    limits.headers,
  );
  // Re-armed at every chunk: a slow but living answer goes through.
  const rearm = () => {
    clearTimeout(stall);
    stall = setTimeout(
      () => abort(`no data for ${limits.stall / 1000} s`, 'stalled'),
      limits.stall,
    );
  };
  try {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
    } catch (err) {
      throw new SourceError(`${host}: ${reason ?? safeCode(err)}`, {
        kind: kind ?? networkKind(err),
      });
    }
    const date = httpDate(response.headers.get('date'));
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      return { status: 304, date };
    }
    if (response.status !== 200 && !accept(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`${host}: HTTP ${response.status}`, {
        kind: 'http',
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers),
      });
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`${host}: answer of ${length} bytes, more than ${maxBytes}`, {
        kind: 'size',
      });
    }
    const chunks = [];
    let bytes = 0;
    rearm();
    try {
      for await (const chunk of response.body ?? []) {
        rearm();
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          abort(`more than ${maxBytes} bytes`, 'size');
          break;
        }
        chunks.push(chunk);
      }
    } catch (err) {
      throw new SourceError(`${host}: ${reason ?? safeCode(err)}`, {
        kind: kind ?? networkKind(err),
      });
    }
    if (reason) {
      throw new SourceError(`${host}: ${reason}`, { kind });
    }
    let json;
    try {
      json = JSON.parse(new TextDecoder('utf-8').decode(Buffer.concat(chunks, bytes)));
    } catch {
      // An accepted error status without its JSON body is the error itself.
      if (response.status !== 200) {
        throw new SourceError(`${host}: HTTP ${response.status}`, {
          kind: 'http',
          status: response.status,
        });
      }
      throw new SourceError(`${host}: not JSON`, { kind: 'format' });
    }
    return { status: response.status, json, etag: response.headers.get('etag'), date };
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
    signal?.removeEventListener('abort', onStop);
  }
}

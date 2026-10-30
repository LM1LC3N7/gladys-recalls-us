// -----------------------------------------------------------------------------
// The three public sources, read without an account nor a key, and their
// answers normalized into one shape of recall:
//
//   { id, feed, category, title, product, firm, issue, remedy, recallClass,
//     serious, day, url, vehicle }
//
// Facts measured on 30/10/2026 (captures in test/fixtures):
//   - CPSC (saferproducts.gov/RestWebServices/Recall): a JSON array, filtered
//     by RecallDateStart; about 40 recalls a month, 3 KB each; no ETag nor
//     Last-Modified, no gzip asked;
//   - openFDA enforcement reports (api.fda.gov/{food,drug,device}/enforcement):
//     weekly (report_date a Wednesday, meta.last_updated the day of the last
//     load), searched on report_date; 404 "No matches found!" for an empty
//     search; a weak ETag, and If-None-Match answered 304; keyless quota
//     1,000 requests a day per address;
//   - NHTSA recalls by vehicle (api.nhtsa.gov/recalls/recallsByVehicle): the
//     campaigns of a make, model and model year; a vehicle without campaign
//     (or unknown to NHTSA) is a 400 with `{"Count":0,"results":[]}`;
//     ReportReceivedDate is DD/MM/YYYY; no ETag;
//   - NHTSA vPIC (vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues): make,
//     model and model year of a VIN. The VIN sits in the path: no error, log
//     or status repeats the URL (src/http.js).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { SourceError, getJson } from './http.js';

export const BASE_URLS = {
  cpsc: 'https://www.saferproducts.gov',
  fda: 'https://api.fda.gov',
  nhtsa: 'https://api.nhtsa.gov',
  vpic: 'https://vpic.nhtsa.dot.gov',
};

// The host of each source: pauses (429, 5xx) are kept per host, so a source
// that fails never holds the others.
export const HOSTS = { cpsc: 'cpsc', fda: 'fda', nhtsa: 'nhtsa', vpic: 'vpic' };

// Pages of the agencies, for the rows without a sheet of their own.
export const SITE_URL = {
  cpsc: 'https://www.cpsc.gov/Recalls',
  fda: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts',
  nhtsa: 'https://www.nhtsa.gov/recalls',
};

const FDA_KINDS = { 'fda-food': 'food', 'fda-drug': 'drug', 'fda-device': 'device' };
export const FDA_CATEGORY = { 'fda-food': 'food', 'fda-drug': 'drugs', 'fda-device': 'devices' };
// openFDA returns 1,000 results at most per request; beyond, the status says
// the list is cut (medical devices only, about 250 a month).
export const FDA_LIMIT = 1000;
// Records kept from one answer.
export const MAX_RECORDS = 1000;

/** Text of a field: no zero-width or control characters, single spaces, clipped. */
export function clean(value, max = 500) {
  const text = String(typeof value === 'string' || typeof value === 'number' ? value : '')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    // Control characters (C0, DEL, C1) become spaces.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const names = (list, max) =>
  clean(
    (Array.isArray(list) ? list : [])
      .map((item) => (item && typeof item === 'object' ? clean(item.Name, max) : ''))
      .filter(Boolean)
      .join('; '),
    max,
  );

const isDay = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const dayOr = (day) => (isDay(day) ? day : null);

/** "2026-10-29" → "20261029". */
const compact = (day) => day.replaceAll('-', '');

// --- CPSC ---------------------------------------------------------------------

const CPSC_URL_RE = /^https:\/\/(www\.)?cpsc\.gov\/\S{1,280}$/;

export function normalizeCpsc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const number = clean(raw.RecallNumber, 20);
  const id = /^\d{1,10}$/.test(number) ? number : null;
  if (id === null) {
    return null;
  }
  const url = clean(raw.URL, 300);
  const product = names(raw.Products, 300);
  const title = clean(raw.Title, 300);
  return {
    id,
    feed: 'cpsc',
    category: 'consumer',
    title: title || product || `CPSC ${id}`,
    product,
    firm: names(
      [
        ...(Array.isArray(raw.Manufacturers) ? raw.Manufacturers : []),
        ...(Array.isArray(raw.Importers) ? raw.Importers : []),
      ],
      200,
    ),
    issue: names(raw.Hazards, 400),
    remedy: names(raw.Remedies, 600),
    recallClass: '',
    serious: false,
    day: dayOr(clean(raw.RecallDate, 30).slice(0, 10)),
    url: CPSC_URL_RE.test(url) ? url : SITE_URL.cpsc,
    vehicle: '',
  };
}

// --- openFDA ------------------------------------------------------------------

export function normalizeFda(raw, feed) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const number = clean(raw.recall_number, 30);
  const event = clean(raw.event_id, 12);
  const product = clean(raw.product_description, 300);
  let id = number;
  if (!/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(number)) {
    // Some reports carry no recall number ("" or "N/A", 3 of 67 on
    // 30/10/2026): named by their event and product, stable across readings.
    if (!/^\d{1,10}$/.test(event)) {
      return null;
    }
    // The full texts (never the clipped ones) of every field that tells two
    // products of one event apart.
    const fields = [
      'product_description',
      'code_info',
      'product_quantity',
      'recalling_firm',
      'classification',
      'report_date',
    ];
    const whole = fields
      .map((key) => (typeof raw[key] === 'string' ? raw[key] : ''))
      .join('\u0000');
    id = `E${event}-${createHash('sha256').update(whole).digest('hex').slice(0, 12)}`;
  }
  const date = clean(raw.report_date, 8);
  const day = /^\d{8}$/.test(date)
    ? dayOr(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`)
    : null;
  const firm = clean(raw.recalling_firm, 120);
  const recallClass = clean(raw.classification, 20);
  return {
    id,
    feed,
    category: FDA_CATEGORY[feed],
    title: clean(firm ? `${firm}: ${product}` : product || id, 300),
    product,
    firm,
    issue: clean(raw.reason_for_recall, 400),
    remedy: '',
    recallClass: /^Class (I|II|III)$/.test(recallClass) ? recallClass : '',
    serious: recallClass === 'Class I',
    day,
    url: SITE_URL.fda,
    vehicle: '',
  };
}

// --- NHTSA --------------------------------------------------------------------

/** "28/05/2020" → "2020-05-28". */
export function nhtsaDay(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(value, 12));
  return match ? dayOr(`${match[3]}-${match[2]}-${match[1]}`) : null;
}

export function vehicleLabel({ make, model, year }) {
  const title = (text) => text.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
  return `${title(make)} ${title(model)} ${year}`;
}

export function normalizeNhtsa(raw, feed, vehicle) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const id = clean(raw.NHTSACampaignNumber, 20);
  if (!/^[0-9A-Z]{5,15}$/.test(id)) {
    return null;
  }
  const label = vehicleLabel(vehicle);
  const component = clean(raw.Component, 200);
  const consequence = clean(raw.Consequence, 300);
  const summary = clean(raw.Summary, 600);
  return {
    id,
    feed,
    category: 'vehicles',
    title: clean(component ? `${label}: ${component}` : label, 300),
    product: label,
    firm: clean(raw.Manufacturer, 120),
    issue: clean([summary, consequence].filter(Boolean).join(' '), 800),
    remedy: clean(raw.Remedy, 600),
    recallClass: '',
    // NHTSA's "park it" (do not drive) and "park outside" (fire risk) advice.
    serious: raw.parkIt === true || raw.parkOutSide === true,
    day: nhtsaDay(raw.ReportReceivedDate),
    url: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(id)}`,
    vehicle: label,
  };
}

// --- Reading ----------------------------------------------------------------------

const formatError = (host, what) => new SourceError(`${host}: ${what}`, { kind: 'format' });

/**
 * Read one feed.
 *
 * @param {object} options
 * @param {object} options.feed `{ id, kind: 'cpsc'|'fda'|'vehicle', vehicle? }`
 * @param {string} options.fromDay first day of the window (YYYY-MM-DD)
 * @param {string} options.toDay last day of the window
 * @param {object|null} options.copy the copy kept (`etag`, `query`) for a 304
 * @returns {Promise<object>} `{ modified: false, date }` or
 *   `{ modified: true, records, etag, query, date, sourceDay, truncated, skipped }`
 */
export async function readFeed({
  fetch,
  feed,
  fromDay,
  toDay,
  copy = null,
  baseUrls = BASE_URLS,
  timeouts,
  signal,
  maxRecords = MAX_RECORDS,
}) {
  if (feed.kind === 'cpsc') {
    const url = `${baseUrls.cpsc}/RestWebServices/Recall?format=json&RecallDateStart=${fromDay}`;
    const { json, date } = await getJson({ fetch, url, timeouts, signal });
    if (!Array.isArray(json)) {
      throw formatError('saferproducts.gov', 'not a list');
    }
    return collect(json, (raw) => normalizeCpsc(raw), { date, maxRecords, host: 'CPSC' });
  }
  if (feed.kind === 'fda') {
    const query = `search=report_date:[${compact(fromDay)}+TO+${compact(toDay)}]&sort=report_date:desc&limit=${FDA_LIMIT}`;
    const url = `${baseUrls.fda}/${FDA_KINDS[feed.id]}/enforcement.json?${query}`;
    // The ETag is that of the same question only (the window moves daily).
    const etag = copy?.query === query ? copy.etag : null;
    const answer = await getJson({ fetch, url, etag, signal, timeouts, accept: (s) => s === 404 });
    if (answer.status === 304) {
      return { modified: false, date: answer.date };
    }
    const { json, date } = answer;
    if (answer.status === 404) {
      // openFDA's answer to a search without result; any other 404 is an error.
      if (json?.error?.code !== 'NOT_FOUND') {
        throw new SourceError('api.fda.gov: HTTP 404', { kind: 'http', status: 404 });
      }
      return {
        modified: true,
        records: [],
        etag: null,
        query,
        date,
        sourceDay: null,
        truncated: false,
        skipped: 0,
      };
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.results)) {
      throw formatError('api.fda.gov', 'no results list');
    }
    const result = collect(json.results, (raw) => normalizeFda(raw, feed.id), {
      date,
      maxRecords,
      host: 'openFDA',
    });
    const total = json.meta?.results?.total;
    const lastUpdated = clean(json.meta?.last_updated, 10);
    return {
      ...result,
      etag: answer.etag,
      query,
      sourceDay: dayOr(lastUpdated),
      truncated: result.truncated || (Number.isInteger(total) && total > json.results.length),
    };
  }
  const { make, model, year } = feed.vehicle;
  const params = new URLSearchParams({ make, model, modelYear: String(year) });
  const url = `${baseUrls.nhtsa}/recalls/recallsByVehicle?${params}`;
  const answer = await getJson({ fetch, url, signal, timeouts, accept: (s) => s === 400 });
  const { json, date } = answer;
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) {
    throw formatError('api.nhtsa.gov', 'no results list');
  }
  if (answer.status === 400 && (json.Count !== 0 || json.results.length !== 0)) {
    throw new SourceError('api.nhtsa.gov: HTTP 400', { kind: 'http', status: 400 });
  }
  return collect(json.results, (raw) => normalizeNhtsa(raw, feed.id, feed.vehicle), {
    date,
    maxRecords,
    host: 'NHTSA',
  });
}

/** Normalize a list; a list whose entries are all unusable is not the expected format. */
function collect(list, normalize, { date, maxRecords, host }) {
  const records = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of list) {
    const record = normalize(raw);
    if (record === null) {
      skipped += 1;
      continue;
    }
    if (seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    records.push(record);
  }
  if (list.length > 0 && records.length === 0) {
    throw formatError(host, `${list.length} entries, none readable`);
  }
  return {
    modified: true,
    records: records.slice(0, maxRecords),
    etag: null,
    query: null,
    date,
    sourceDay: null,
    truncated: records.length > maxRecords,
    skipped,
  };
}

/**
 * Make, model and model year of a VIN, from NHTSA vPIC: `{ make, model, year }`.
 * Throws a SourceError of kind `vinUnknown` when vPIC does not know them.
 */
export async function decodeVin({ fetch, vin, baseUrls = BASE_URLS, timeouts, signal, maxYear }) {
  const url = `${baseUrls.vpic}/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
  const { json } = await getJson({ fetch, url, timeouts, signal });
  const result = Array.isArray(json?.Results) ? json.Results[0] : null;
  if (!result || typeof result !== 'object') {
    throw formatError('vpic.nhtsa.dot.gov', 'no result');
  }
  const make = clean(result.Make, 40).toUpperCase();
  const model = clean(result.Model, 40).toUpperCase();
  const yearText = clean(result.ModelYear, 4);
  const year = Number(yearText);
  if (
    !/^[A-Z0-9][A-Z0-9 .\-/&']*$/.test(make) ||
    !/^[A-Z0-9][A-Z0-9 .\-/&']*$/.test(model) ||
    !/^\d{4}$/.test(yearText) ||
    year < 1949 ||
    year > maxYear
  ) {
    throw new SourceError('vpic.nhtsa.dot.gov: make, model or year unknown', {
      kind: 'vinUnknown',
    });
  }
  return { make, model, year };
}

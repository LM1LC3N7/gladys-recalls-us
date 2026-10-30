// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// The VINs come from a `secret` field: kept by Gladys in its database, never
// shown again, sent only to NHTSA (vPIC) to learn the make, model and year.
// Nothing in this file (nor anywhere else) logs, stores or shows a VIN: the
// normalized configuration carries them in `vins`, read by src/monitor.js only
// to build the decoding request. Errors about them name the position ("VIN 2"),
// never the value.
// -----------------------------------------------------------------------------

// Languages of the texts the integration writes. The sources publish in
// English only: the titles, products and reasons stay in English.
export const LANGUAGES = ['en', 'fr'];

// The groups the integration follows, each read from one source. `key` is the
// stable word the manifest, the scene triggers and the docs use.
export const CATEGORIES = [
  { key: 'consumer', feed: 'cpsc' },
  { key: 'food', feed: 'fda-food' },
  { key: 'drugs', feed: 'fda-drug' },
  { key: 'devices', feed: 'fda-device' },
];
export const CATEGORY_KEYS = CATEGORIES.map((category) => category.key);
// Vehicles are not a category to tick: they are followed when listed.
export const VEHICLE = 'vehicles';
export const ALL_CATEGORY_KEYS = [...CATEGORY_KEYS, VEHICLE];

// Medical devices are left out by default: about 250 a month, nearly all
// hospital and laboratory equipment, and the largest answers of openFDA.
export const DEFAULT_CATEGORIES = ['consumer', 'food', 'drugs'];

// Hours between two readings of each source. CPSC and NHTSA have no
// validator; openFDA answers 304 for an unchanged answer.
export const REFRESH_INTERVALS = ['3', '6', '12', '24'];

// Bound of the free-text list: a scene that follows 200 brands would be
// better served by a category.
export const MAX_KEYWORDS = 30;
export const MAX_KEYWORD_LENGTH = 60;
// Vehicles followed: five in all, three of them by VIN at most.
export const MAX_VEHICLES = 5;
export const MAX_VINS = 3;
export const MIN_YEAR = 1949;
const MAX_FIELD = 40;

export const DEFAULT_CONFIG = {
  categories: DEFAULT_CATEGORIES,
  keywords: '',
  vehicles: '',
  refresh_interval: '6',
  language: 'en',
};

/** Lower case, without accents nor punctuation: "Crème-Glacée" → "creme glacee". */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Brands or words, separated by commas, semicolons or new lines. */
export function parseKeywords(text) {
  const keywords = [];
  for (const part of String(text ?? '').split(/[,;\n]+/)) {
    const keyword = fold(part).slice(0, MAX_KEYWORD_LENGTH).trim();
    if (keyword !== '' && !keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }
  return keywords.slice(0, MAX_KEYWORDS);
}

// Make and model as NHTSA spells them: upper case, single spaces; letters,
// digits, spaces and - . / & ' only (no control character, no URL syntax).
const NAME_RE = /^[A-Z0-9][A-Z0-9 .\-/&']*$/;
// A VIN: 17 characters, digits and capital letters without I, O, Q. In a make
// or model, with digits and letters mixed (no model name looks like that).
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const VIN_LIKE_RE = /^(?=.*\d)(?=.*[A-Z])[A-HJ-NPR-Z0-9]{17}$/;

/** "Honda, Civic, 2019" → { make: 'HONDA', model: 'CIVIC', year: 2019 } or null. */
export function parseVehicle(text, maxYear) {
  const parts = String(text)
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim());
  if (parts.length !== 3) {
    return null;
  }
  const [make, model, yearText] = parts.map((part) => part.toUpperCase());
  if (!/^\d{4}$/.test(yearText)) {
    return null;
  }
  const year = Number(yearText);
  if (year < MIN_YEAR || year > maxYear) {
    return null;
  }
  for (const name of [make, model]) {
    // A VIN pasted here (17 characters without I, O, Q) is refused like any
    // bad entry: never sent to NHTSA, shown, logged or stored.
    if (
      name.length === 0 ||
      name.length > MAX_FIELD ||
      !NAME_RE.test(name) ||
      VIN_LIKE_RE.test(name.replace(/[\s.\-/&']/g, ''))
    ) {
      return null;
    }
  }
  return { make, model, year };
}

/** The stable key of a vehicle: "HONDA|CIVIC|2019". */
export const vehicleKey = ({ make, model, year }) => `${make}|${model}|${year}`;

/**
 * Vehicles typed as "make, model, year", one per line or separated by
 * semicolons. `invalid` lists the positions (1-based) of the entries that
 * could not be read: the texts name them, never repeat them.
 */
export function parseVehicles(text, maxYear) {
  const vehicles = [];
  const invalid = [];
  const entries = String(text ?? '')
    .split(/[;\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const [index, entry] of entries.entries()) {
    const vehicle = parseVehicle(entry, maxYear);
    if (vehicle === null) {
      invalid.push(index + 1);
    } else if (!vehicles.some((v) => vehicleKey(v) === vehicleKey(vehicle))) {
      vehicles.push(vehicle);
    }
  }
  return { vehicles, invalid };
}

/**
 * VINs separated by commas, semicolons, spaces or new lines. `invalid` lists
 * the positions (1-based) of the entries that are not 17 valid characters.
 */
export function parseVins(text) {
  const vins = [];
  const invalid = [];
  const entries = String(text ?? '')
    .toUpperCase()
    .split(/[\s,;]+/)
    .filter((entry) => entry !== '');
  for (const [index, entry] of entries.entries()) {
    if (!VIN_RE.test(entry)) {
      invalid.push(index + 1);
    } else if (!vins.includes(entry)) {
      vins.push(entry);
    }
  }
  return { vins, invalid };
}

function categories(value) {
  // A multi_select is stored as an array; an unset field keeps the default.
  if (!Array.isArray(value)) {
    return [...DEFAULT_CATEGORIES];
  }
  return CATEGORY_KEYS.filter((key) => value.includes(key));
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 * @param {number} [now] wall clock, for the latest model year accepted
 */
export function normalizeConfig(raw = {}, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const refresh = String(source.refresh_interval ?? '');
  // Model years run up to two years ahead of the calendar.
  const maxYear = new Date(now).getUTCFullYear() + 2;
  const typed = parseVehicles(source.vehicles, maxYear);
  const vin = parseVins(source.vins);
  // Five vehicles in all: the typed ones first, then the VINs.
  const vehicles = typed.vehicles.slice(0, MAX_VEHICLES);
  const vins = vin.vins.slice(0, Math.min(MAX_VINS, MAX_VEHICLES - vehicles.length));
  return {
    categories: categories(source.categories),
    keywords: parseKeywords(source.keywords),
    vehicles,
    vins,
    invalidVehicles: typed.invalid,
    invalidVins: vin.invalid,
    droppedVehicles: typed.vehicles.length - vehicles.length + (vin.vins.length - vins.length),
    refreshHours: Number(
      REFRESH_INTERVALS.includes(refresh) ? refresh : DEFAULT_CONFIG.refresh_interval,
    ),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

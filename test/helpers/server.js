// -----------------------------------------------------------------------------
// A fake CPSC, openFDA, NHTSA and vPIC on one 127.0.0.1 server: the answers
// are built from the real captures of test/fixtures (30/10/2026) and follow
// the real services: CPSC filters on RecallDateStart, without validator;
// openFDA searches report_date, answers 404 NOT_FOUND for an empty search,
// sends a weak ETag and a 304 for a matching If-None-Match; NHTSA answers a
// vehicle without campaign with a 400 `{"Count":0,"results":[]}`; vPIC decodes
// the VINs it was given. Faults on demand, per source: a status (with
// Retry-After), a dropped connection, a body that stalls, an oversized body,
// a redirect, HTML instead of JSON.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

// A VIN for the tests: the public example of the vPIC documentation (a 2003
// Honda Accord), never a vehicle of anyone.
export const TEST_VIN = '1HGCM82633A004352';
export const TEST_VIN_2 = '1FTFW1ET5DFC10312';

const dayOf = (cpscDate) => cpscDate.slice(0, 10);

/** The source of a request path: 'cpsc', 'fda', 'nhtsa', 'vpic' or null. */
export function sourceOf(path) {
  if (path.startsWith('/RestWebServices/Recall')) return 'cpsc';
  if (/^\/(food|drug|device)\/enforcement\.json/.test(path)) return 'fda';
  if (path.startsWith('/recalls/recallsByVehicle')) return 'nhtsa';
  if (path.startsWith('/api/vehicles/DecodeVinValues/')) return 'vpic';
  return null;
}

/**
 * @param {object} [options]
 * @param {() => string|null} [options.date] the Date header (null: none)
 */
export async function startServer({ date = () => 'Fri, 30 Oct 2026 16:00:00 GMT' } = {}) {
  const fda = {
    food: fixture('fda-food-2026-10-30.json'),
    drug: fixture('fda-drug-2026-10-30.json'),
    device: fixture('fda-device-2026-10-30.json'),
  };
  const civic = fixture('nhtsa-honda-civic-2019.json').results;
  const accord = fixture('vpic-decode-honda-accord-2003.json');
  let version = 1;
  const srv = {
    cpsc: fixture('cpsc-2026-10-30.json'),
    fda,
    vehicles: {
      'HONDA|CIVIC|2019': civic,
      'HONDA|ACCORD|2003': civic.slice(0, 2).map((r, i) => ({
        ...r,
        NHTSACampaignNumber: `03V0${i}0000`,
        Model: 'ACCORD',
        ModelYear: '2003',
      })),
    },
    vins: {
      [TEST_VIN]: accord.Results[0],
      [TEST_VIN_2]: { Make: 'FORD', Model: 'F-150', ModelYear: '2013', ErrorCode: '0' },
    },
    date,
    // Per source: false, a status (503, 429, 404…), 'drop', 'stall',
    // 'oversize', 'chunked-oversize', 'redirect', 'html', 'slow', 'force304'
    faults: {},
    retryAfter: null,
    slowMs: 100,
    requests: [],
    etag: (kind, from, to) => `W/"fda-${kind}-${version}-${from}-${to}"`,
    /** openFDA loads new reports: new ETags. */
    touch() {
      version += 1;
    },
    count: (source) => srv.requests.filter((r) => r.source === source).length,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const source = sourceOf(url.pathname);
    srv.requests.push({ url: req.url, source, headers: req.headers, method: req.method });
    const headers = {};
    const dateValue = srv.date();
    if (dateValue !== null) {
      headers.Date = dateValue;
    } else {
      res.sendDate = false;
    }
    const fault = srv.faults[source] ?? srv.faults.all ?? false;
    const json = (status, body, extra = {}) => {
      const text = Buffer.from(JSON.stringify(body));
      res.writeHead(status, {
        ...headers,
        ...extra,
        'Content-Type': 'application/json',
        'Content-Length': String(text.length),
      });
      res.end(text);
    };
    if (fault === 'drop') {
      req.socket.destroy();
      return;
    }
    if (typeof fault === 'number') {
      if (srv.retryAfter !== null) headers['Retry-After'] = String(srv.retryAfter);
      res.writeHead(fault, headers);
      res.end('error');
      return;
    }
    if (fault === 'redirect') {
      res.writeHead(302, { ...headers, Location: '/elsewhere' });
      res.end();
      return;
    }
    if (fault === 'html') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      res.end('<html><body>Maintenance</body></html>');
      return;
    }
    if (fault === 'stall') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.write('[');
      return;
    }
    if (fault === 'oversize') {
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(100 * 1024 * 1024),
      });
      res.write('[');
      return;
    }
    if (fault === 'chunked-oversize') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      res.write('[');
      let sent = 0;
      const push = () => {
        while (sent < 40 && res.write(chunk)) sent += 1;
        if (sent < 40 && !res.destroyed) res.once('drain', push);
        else res.end(']');
      };
      res.on('close', () => {
        srv.chunkedSent = sent;
      });
      push();
      return;
    }
    if (source === 'cpsc') {
      const start = url.searchParams.get('RecallDateStart') ?? '0000-00-00';
      const body = srv.cpsc.filter((r) => dayOf(r.RecallDate) >= start);
      if (fault === 'slow') {
        const text = Buffer.from(JSON.stringify(body));
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        const size = Math.ceil(text.length / 6);
        let at = 0;
        const next = () => {
          if (res.destroyed) return;
          res.write(text.subarray(at, at + size));
          at += size;
          if (at >= text.length) res.end();
          else setTimeout(next, srv.slowMs);
        };
        next();
        return;
      }
      json(200, body);
      return;
    }
    if (source === 'fda') {
      const kind = url.pathname.split('/')[1];
      const match = /report_date:\[(\d{8})\+TO\+(\d{8})\]/.exec(decodeURIComponent(url.search));
      const [from, to] = match ? [match[1], match[2]] : ['00000000', '99999999'];
      const all = srv.fda[kind].results.filter((r) => r.report_date >= from && r.report_date <= to);
      const etag = srv.etag(kind, from, to);
      if (fault === 'force304' || req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ...headers, ETag: etag });
        res.end();
        return;
      }
      if (all.length === 0) {
        json(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }, { ETag: etag });
        return;
      }
      const limit = Number(url.searchParams.get('limit') ?? 1);
      json(
        200,
        {
          meta: {
            ...srv.fda[kind].meta,
            results: { skip: 0, limit, total: srv.fda[kind].total ?? all.length },
          },
          results: all.slice(0, limit),
        },
        { ETag: etag },
      );
      return;
    }
    if (source === 'nhtsa') {
      const key = [
        (url.searchParams.get('make') ?? '').toUpperCase(),
        (url.searchParams.get('model') ?? '').toUpperCase(),
        url.searchParams.get('modelYear') ?? '',
      ].join('|');
      const results = srv.vehicles[key] ?? [];
      if (results.length === 0) {
        json(400, { Count: 0, Message: 'Results returned successfully', results: [] });
        return;
      }
      json(200, { Count: results.length, Message: 'Results returned successfully', results });
      return;
    }
    if (source === 'vpic') {
      const vin = decodeURIComponent(url.pathname.split('/').pop());
      const result = srv.vins[vin] ?? {
        Make: '',
        Model: '',
        ModelYear: '',
        ErrorCode: '11',
        ErrorText: '11 - Incorrect Model Year',
      };
      json(200, { Count: 1, Message: 'Results returned successfully', Results: [result] });
      return;
    }
    res.writeHead(404, headers);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  srv.baseUrls = { cpsc: base, fda: base, nhtsa: base, vpic: base };
  srv.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return srv;
}

/** A new CPSC recall, shaped like the real ones. */
export function cpscRecall(number, fields = {}) {
  return {
    RecallID: 90000 + Number(number),
    RecallNumber: String(number),
    RecallDate: '2026-10-30T00:00:00',
    Title: `Maple Toys Recalls Wooden Cribs Due to Fall Hazard (${number})`,
    URL: `https://www.cpsc.gov/Recalls/2027/Maple-Toys-Recalls-Wooden-Cribs-${number}`,
    LastPublishDate: '2026-10-30T00:00:00',
    Products: [{ Name: 'Maple Toys wooden cribs', Type: 'Cribs' }],
    Manufacturers: [{ Name: 'Maple Toys Inc.' }],
    Importers: [],
    Hazards: [{ Name: 'The crib side can detach, posing a fall hazard.' }],
    Remedies: [{ Name: 'Stop using the cribs and contact Maple Toys for a refund.' }],
    ...fields,
  };
}

/** A new openFDA enforcement report entry. */
export function fdaRecall(number, fields = {}) {
  return {
    status: 'Ongoing',
    classification: 'Class I',
    recalling_firm: 'Maple Foods LLC',
    recall_number: `F-${String(number).padStart(4, '0')}-2027`,
    product_description: 'Maple peanut cookies, 12 oz',
    reason_for_recall: 'Undeclared peanut',
    report_date: '20261028',
    ...fields,
  };
}

/** A new NHTSA campaign of a vehicle. */
export function nhtsaRecall(campaign, fields = {}) {
  return {
    Manufacturer: 'Honda (American Honda Motor Co.)',
    NHTSACampaignNumber: campaign,
    parkIt: false,
    parkOutSide: false,
    overTheAirUpdate: false,
    ReportReceivedDate: '29/10/2026',
    Component: 'AIR BAGS',
    Summary: 'The air bag inflator may rupture.',
    Consequence: 'A rupture can strike the occupants.',
    Remedy: 'Dealers will replace the inflator, free of charge.',
    Notes: '',
    ModelYear: '2019',
    Make: 'HONDA',
    Model: 'CIVIC',
    ...fields,
  };
}

# TODO

## Before announcing

- [ ] Review (high).
- [ ] Try on a real Gladys 5.1+: device creation, the widget, a scene on
      `new_recall` over a few days, the scene action, a VIN saved.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store: `keywords` (recall, CPSC, FDA, NHTSA, VIN) and `countries` (US)
      once the core accepts them.

## To watch on the real services

- [ ] The weekly load of openFDA (meta.last_updated 2026-10-21 on 30/10/2026:
      9 days): the stale alarm is at 21 days.
- [ ] Whether CPSC ever sends a validator (none on 30/10/2026).
- [ ] The vPIC model names against the recalls API (a VIN decoded to a model
      spelled differently would find no campaign: the status says it).

## Decisions

- Version 0.1.0 set by hand in package.json, its lock, the manifest and the
  image tag (`ghcr.io/lm1lc3n7/gladys-recalls-us:0.1.0`); SDK ^0.16.0, the
  latest published on 30/10/2026.
- Sources, measured on 30/10/2026: CPSC `RestWebServices/Recall?format=json`
  filtered by `RecallDateStart` (no validator); openFDA
  `{food,drug,device}/enforcement.json` searched on `report_date` (weak ETag,
  304 on If-None-Match, 404 NOT_FOUND for an empty search); NHTSA
  `recalls/recallsByVehicle` (400 `{"Count":0}` for a vehicle without
  campaign); vPIC `DecodeVinValues` for the VINs. NHTSA has no public lookup
  of the recalls of one VIN (`recallsByVin` answers 403): a VIN gives the make, model and year only, said in the
  docs and the manifest.
- No openFDA key: the keyless quota (1,000 requests a day per address) is far
  above what the integration asks (at most 3 requests per interval, 24 a day
  at 3 h), and a key would be one more secret to guard.
- One feed per source and vehicle, each with its schedule, failures, pause
  (per host) and copy: a source down never holds the others. The counters are
  published only when every followed feed is fresh; the widget lists the
  fresh ones and says the others.
- Window asked to CPSC and openFDA: 21 days (7 for the counter, 14 for the
  trigger, openFDA a few days late). openFDA stale after 21 days without a
  load (meta.last_updated against the Date header, never the local clock).
- "New recall" = an id never seen in an answer of its feed, in the selection,
  within 14 days (CPSC, FDA) or of any age (a vehicle campaign is new for that
  vehicle). The first answer of a feed fires nothing.
- VINs: `secret` field, at most 3, five vehicles in all; never logged,
  stored or shown (positions only); decoded at start, when saved, then daily; a
  restart within 10 minutes of a decoding reuses the make, model and year kept
  by position in /data (review r1, m5), never asking vPIC in a loop. /data keeps the decoded
  make, model and year, like a typed vehicle; no fingerprint of a VIN (a
  salted hash next to its salt would be brute-forced from the make, model
  and year).
- `vehicle_count` of the scene action is absent when no vehicle is followed
  (review r1: never a 0 nor a -1 that a scene could misread).
- A make or model shaped like a VIN is refused (review r1, m1).
- /data hung: the readings go on, `stop()` waits 2 s at most, the status says
  it (review r1, m4).
- Memory: one answer at most 16 MB (counted while it arrives), 1,000 recalls
  kept per feed, 5,000 ids seen per feed, 200 pending events per feed, 16
  feeds in /data (16 MB at most; the recalls kept and their time dropped
  first, never the ids seen).
- Texts: English and French; the recalls stay in English (the language of
  the sources). Catalog categories: `environment` and `notifications`.
- No `poll_frequency`: the integration runs its own schedule.

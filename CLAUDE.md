# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/vin.test.js              # one file
node --test --test-name-pattern "VIN"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js              SDK wiring only (registerHandlers, shutdown)
src/app.js            handlers; getConfig() retried without end in `connected`; configurations in order
src/monitor.js        feeds (one per source and vehicle), schedule per feed (monotonic clock), pauses
                      per host, VIN decoding, selection, new recalls, states, freshness, status
src/sources.js        CPSC, openFDA, NHTSA and vPIC: URLs, answers normalized into one shape
src/http.js           one bounded JSON GET (size, time, no redirect), errors without URL
src/store.js          /data: copies, ids seen, pending events, attempts, pauses (never a VIN)
src/device.js         the one device (recalls_week, vehicle_recalls, latest_recall)
src/actions.js        check_now, read_recalls (answer from memory, never a request)
src/widgets.js        the `recalls` widget
src/messages.js       texts EN/FR, dates
src/config.js         DEFAULT_CONFIG (mirrors the manifest) + normalization, vehicles, VINs
test/helpers/         fake CPSC/openFDA/NHTSA/vPIC server (real HTTP on 127.0.0.1), test world
test/kit/clock.mjs    virtual and sped-up clocks (from gladys-testkit)
```

## Rules

- **VINs**: a `secret` field; sent only to vPIC (in the path of the request);
  never in a log (debug included), an error message, the status, /data, a
  scene event, the widget or an action. Errors carry the host only, texts say
  "VIN 2". `test/vin.test.js` checks it on every output.
- **Cadence of the sources**: one request at a time, a second apart, each
  feed never faster than the interval (restart included: the attempt and the
  next time are in /data before the request leaves, the wait for /data being
  bounded), openFDA conditional (ETag), honest User-Agent. The actions and
  the widget never ask a source.
- **No invented value**: a source unreachable, never read or stale is said
  in the status; the counters are published only when every followed source
  is fresh (never a count that leaves one out, never 0 for what is unknown).
- **Isolation**: one feed failing or paused never holds the others.
- **External ids are forever** (`gladys.externalIds('recalls', 'selection')`),
  as the manifest keys, feature keys, trigger and widget keys.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions**: 0.1.0 set by hand for the first release; then the Release
  workflow owns them. `test/manifest.test.js` checks they agree.
- **Changelog** under `## [Unreleased]`.
- **User-facing text** in English and French: manifest, messages, docs
  (`docs/en.md` / `docs/fr.md` kept in sync), checked by
  `test/encoding.test.js` (clean UTF-8, forbidden words).
- **Tests never touch the network** beyond 127.0.0.1. Temporary /data folders
  are removed after each test; the real-clock tests stop the app in a
  `finally`.

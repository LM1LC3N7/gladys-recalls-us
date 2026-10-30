# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
reads public data and reuses the structure of the projects below, each
distributed under its own license.

## Public data of the United States government

Read at runtime, and recorded in `test/fixtures` (captured on 30/10/2026:
subsets of the answers; the CPSC consumer contacts (`ConsumerContact`)
removed and the e-mail addresses left in other texts replaced by
`recall@example.com`; the vPIC answer reduced to the fields used, its
`SearchCriteria` removed, so the file holds no VIN — the tests use the
example VIN of the vPIC documentation, in `test/helpers/server.js`):

- CPSC Recalls Retrieval Web Services, <https://www.saferproducts.gov/RestWebServices>
  (`cpsc-2026-10-30.json`);
- openFDA enforcement reports, <https://open.fda.gov/apis/> (`fda-*-2026-10-30.json`),
  under the terms of <https://open.fda.gov/terms/> and the license
  <https://open.fda.gov/license/> (public domain, CC0 for the parts that are
  not). "Do not rely on openFDA to make decisions regarding medical care."
- NHTSA recalls API, <https://api.nhtsa.gov> (`nhtsa-honda-civic-2019.json`),
  and NHTSA vPIC, <https://vpic.nhtsa.dot.gov/api/> (`vpic-decode-honda-accord-2003.json`,
  the example VIN of the vPIC documentation).

Works of the United States government are not subject to copyright in the
United States (17 U.S.C. 105). This integration is not affiliated with, nor
endorsed by, CPSC, the FDA, NHTSA or any agency of the United States.

## gladys-rappels-canada

<https://github.com/LM1LC3N7/gladys-rappels-canada>, version 0.1.1: same
author, Apache License 2.0. Its structure was reused and adapted: the wiring
of the handlers and the retry of the configuration (`src/app.js`), the
monitor that fires the scene events once, remembers what was seen and says
what is not up to date (`src/monitor.js`), the coalesced atomic writes under
/data (`src/store.js`), the device, the actions, the widget, the
multi-language messages, and the tests of the manifest and of the Gladys
rules with the table `test/fixtures/gladys-feature-table.json` (itself from
gladys-rappelconso, guim31, Apache License 2.0).

## gladys-testkit and gladys-span-panel

`test/kit/clock.mjs` (virtual and sped-up clocks) comes from gladys-testkit,
and `test/encoding.test.js` and `scripts/cover.mjs` (drawing helpers) from
gladys-span-panel: same author, Apache License 2.0.

## @gladysassistant/integration-sdk

The runtime dependency: <https://github.com/GladysAssistant/integration-sdk-js>,
Apache License 2.0.

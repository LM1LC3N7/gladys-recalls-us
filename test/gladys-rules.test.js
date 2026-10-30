// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on the device discovered from realistic
// inputs (the recorded answers of CPSC, openFDA and NHTSA, several configurations), in
// every feature-name language. (From gladys-rappels-canada.)
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys". The
// supported_options follow the rule of the core (normalizeSupportedOptions):
// one bad option rejects the whole discovery. Do not loosen this test to make
// it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { create, createWorld, tick } from './helpers/world.js';

/** The rule of the core for supported_options (server/utils/normalizeSupportedOptions.js). */
export function checkSupportedOptions(options, { allowStringValues }, where) {
  assert.ok(Array.isArray(options), `${where}: supported_options must be an array`);
  const seen = new Set();
  for (const option of options) {
    const extra = Object.keys(option).filter(
      (key) => !['value', 'label', 'sort_order'].includes(key),
    );
    assert.deepEqual(extra, [], `${where}: unknown keys ${extra}`);
    assert.equal(typeof option.label, 'string', `${where}: label must be a string`);
    assert.ok(option.label.trim().length > 0, `${where}: empty label`);
    assert.equal(option.label, option.label.trim(), `${where}: label with spaces around`);
    const ok =
      Number.isInteger(option.value) ||
      (allowStringValues && typeof option.value === 'string' && option.value.trim().length > 0);
    assert.ok(ok, `${where}: value ${JSON.stringify(option.value)}`);
    assert.ok(!seen.has(`${option.value}`), `${where}: duplicate value ${option.value}`);
    seen.add(`${option.value}`);
  }
}

test('the check of supported_options refuses what the core refuses', () => {
  const bad = [
    [{ value: 1, label: ' On' }],
    [{ value: 1, label: '' }],
    [{ value: 1, label: { en: 'On' } }],
    [{ value: 1.5, label: 'x' }],
    [
      { value: 1, label: 'a' },
      { value: '1', label: 'b' },
    ],
    [{ value: 1, label: 'a', icon: 'x' }],
  ];
  for (const options of bad) {
    assert.throws(() => checkSupportedOptions(options, { allowStringValues: true }, 'x'));
  }
  checkSupportedOptions(
    [
      { value: 'a', label: 'A' },
      { value: 2, label: 'B' },
    ],
    { allowStringValues: true },
    'x',
  );
});

const CONFIGS = [
  {},
  { keywords: 'peanut, IKEA' },
  { categories: [] },
  { categories: ['devices'], vehicles: 'Honda, Civic, 2019' },
];

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

for (const language of LANGUAGES) {
  for (const [index, config] of CONFIGS.entries()) {
    test(`the discovered device follows the Gladys rules (${language} names, config ${index})`, async (t) => {
      const world = await createWorld(t, { config: { ...config, language } });
      await tick(world, 1);
      const devices = world.fake.discoveredDevices;
      assert.equal(devices.length, 1);
      await create(world);
      for (const device of devices) {
        const where = device.name;
        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );
          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          }
          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          if (feature.supported_options !== undefined) {
            checkSupportedOptions(
              feature.supported_options,
              { allowStringValues: feature.category === 'text' || feature.type === 'select' },
              at,
            );
          }
          names.add(feature.name);
        }

        // Every published state stays within the bounds of its feature.
        for (const state of world.fake.states) {
          const feature = device.features.find(
            (f) => f.external_id === state.device_feature_external_id,
          );
          assert.ok(feature, `${state.device_feature_external_id}: state of an unknown feature`);
          if (state.text !== undefined) {
            assert.ok(state.text.length > 0, `${feature.name}: empty text`);
          } else {
            assert.ok(
              state.state >= feature.min && state.state <= feature.max,
              `${feature.name}: ${state.state} outside [${feature.min}, ${feature.max}]`,
            );
          }
        }
      }
    });
  }
}

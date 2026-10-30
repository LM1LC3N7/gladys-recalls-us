// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code,
// and the rules of the project on the manifest: 0.1.0 everywhere, Gladys 5.1.0
// at least, 1 to 3 catalog categories, no key prefixed `gladys_`, no secret
// with a default, multi-language texts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ALL_CATEGORY_KEYS,
  CATEGORY_KEYS,
  DEFAULT_CONFIG,
  LANGUAGES,
  REFRESH_INTERVALS,
  normalizeConfig,
} from '../src/config.js';
import { CONFIG_ACTION, SCENE_ACTION } from '../src/actions.js';
import { registerHandlers } from '../src/app.js';
import { TRIGGERS, WIDGET_KEY } from '../src/monitor.js';
import { USER_AGENT } from '../src/http.js';
import { WIDGETS } from '../src/widgets.js';
import { cpscRecall, startServer } from './helpers/server.js';
import { HOUR, create, createWorld, tick } from './helpers/world.js';

const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('gladys-assistant-integration.json'));
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));

const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
];
const keysOf = (list) => (list ?? []).map((entry) => entry.key);
const field = (list, key) => list.find((entry) => entry.key === key);

// The handlers the integration registers on the SDK.
const registered = createFakeGladys({});
registerHandlers(registered, { timers: false });
const handlerKeys = (prefix) =>
  Object.keys(registered.handlers ?? {})
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));

test('identity: name, image, cover, cloud transport, categories', () => {
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.docker_image, 'ghcr.io/lm1lc3n7/gladys-recalls-us:0.1.0');
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-recalls-us/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
});

test('version 0.1.0 in package.json, its lock, the manifest and the image tag', () => {
  for (const version of [pkg.version, lock.version, lock.packages[''].version, manifest.version]) {
    assert.equal(version, '0.1.0');
  }
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
  assert.doesNotMatch(manifest.docker_image, /:latest$/);
  assert.match(USER_AGENT, new RegExp(`/${manifest.version.replaceAll('.', '\\.')} `));
});

test('the dependency of the SDK is a range, never pinned', () => {
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('Gladys 5.1.0 at least: widgets, scene triggers and actions', () => {
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('every manifest action, scene action and widget has its handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.actions), [CONFIG_ACTION]);
  assert.deepEqual(keysOf(manifest.scene_actions), [SCENE_ACTION]);
  assert.deepEqual(keysOf(manifest.widgets), [WIDGET_KEY]);
  assert.deepEqual(Object.keys(WIDGETS), [WIDGET_KEY]);
  assert.deepEqual(keysOf(manifest.scene_triggers), Object.values(TRIGGERS));
  if (registered.handlers) {
    assert.deepEqual(handlerKeys('action:'), [CONFIG_ACTION]);
    assert.deepEqual(handlerKeys('sceneAction:'), [SCENE_ACTION]);
    assert.deepEqual(handlerKeys('widget:'), [WIDGET_KEY]);
  }
});

const valued = manifest.config_schema.filter((f) => f.type !== 'section' && f.type !== 'secret');

test('the defaults of config_schema are DEFAULT_CONFIG, and normalize to themselves', () => {
  for (const entry of valued) {
    assert.deepEqual(entry.default, DEFAULT_CONFIG[entry.key], entry.key);
  }
  assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), keysOf(valued).sort());
  const normalized = normalizeConfig(DEFAULT_CONFIG);
  assert.deepEqual(normalized.categories, DEFAULT_CONFIG.categories);
  assert.equal(normalized.refreshHours, Number(DEFAULT_CONFIG.refresh_interval));
  assert.equal(normalized.language, DEFAULT_CONFIG.language);
});

test('the options of the selects are the values the code knows', () => {
  const values = (key) => field(manifest.config_schema, key).options.map((o) => o.value);
  assert.deepEqual(values('categories'), CATEGORY_KEYS);
  assert.deepEqual(values('refresh_interval'), REFRESH_INTERVALS);
  assert.deepEqual(values('language'), LANGUAGES);
  const trigger = field(manifest.scene_triggers[0].fields, 'category');
  assert.deepEqual(
    trigger.options.map((o) => o.value),
    ALL_CATEGORY_KEYS,
  );
});

test('no key is prefixed gladys_, one secret (the VINs) without default, every text has en and fr', () => {
  const texts = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (['label', 'description', 'placeholder'].includes(key)) {
          texts.push([`${path}.${key}`, inner]);
        }
        walk(inner, `${path}.${key}`);
      }
    }
  };
  walk(manifest, 'manifest');
  for (const [path, text] of texts) {
    assert.equal(typeof text, 'object', `${path} must be multi-language`);
    assert.ok(text.en && text.fr, `${path} needs en and fr`);
  }
  for (const entry of allFields) {
    assert.doesNotMatch(entry.key, /^gladys_/);
    assert.notEqual(entry.type, 'password');
  }
  const secrets = allFields.filter((entry) => entry.type === 'secret');
  assert.deepEqual(keysOf(secrets), ['vins']);
  for (const secret of secrets) {
    assert.equal(secret.default, undefined, 'a secret never has a default');
    assert.equal(secret.placeholder, undefined, 'a secret never shows an example');
    assert.match(secret.description.en, /never shown again, sent only to NHTSA/);
    assert.match(secret.description.fr, /jamais réaffichés, envoyés seulement à la NHTSA/);
  }
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `${language}: ${text.length}`);
  }
});

test('sections store nothing; their links are https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.default, undefined);
    assert.equal(section.required, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the scene event carries exactly the declared field and variables', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const world = await createWorld(t, { server, config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  server.cpsc.unshift(cpscRecall(95000));
  await tick(world, 6 * HOUR);
  const [event] = world.fake.sceneEvents;
  const data = event.data ?? event;
  const declared = [
    ...keysOf(manifest.scene_triggers[0].fields),
    ...keysOf(manifest.scene_triggers[0].variables),
  ];
  assert.deepEqual(Object.keys(data).sort(), [...new Set(declared)].sort());
  for (const value of Object.values(data)) {
    assert.equal(typeof value, 'string');
  }
});

test('the outputs of read_recalls are the declared ones (vehicle_count with vehicles only)', async (t) => {
  const world = await createWorld(t, { config: { vehicles: 'Honda, Civic, 2019' } });
  await tick(world, 1);
  const { data } = await world.fake.sceneAction(SCENE_ACTION, {});
  assert.deepEqual(
    Object.keys(data.outputs).sort(),
    keysOf(manifest.scene_actions[0].outputs).sort(),
  );
  await world.fake.configUpdated({ vehicles: '' });
  await tick(world, 1);
  const without = await world.fake.sceneAction(SCENE_ACTION, {});
  assert.deepEqual(Object.keys(without.data.outputs).sort(), ['count', 'text']);
});

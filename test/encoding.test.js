// -----------------------------------------------------------------------------
// The texts read by Gladys, the store and people are clean UTF-8: no BOM, no
// mojibake (a file written through a wrong code page), no control byte. The
// source files too. And nothing is ever said to be "encrypted" (any word of
// that family, in English or French, anywhere): the VINs are kept by Gladys,
// never described so. (From gladys-span-panel.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sources = (dir) =>
  readdirSync(new URL(dir, root), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))
    .map((name) => `${dir}${name.replaceAll('\\', '/')}`);

const FILES = [
  'gladys-assistant-integration.json',
  'docs/fr.md',
  'docs/en.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'Dockerfile',
  'index.js',
  'scripts/cover.mjs',
  ...sources('src/'),
  ...sources('test/'),
];

// "Ã", "Â", the "â€" family and "Å’" / "Å“" (Œ / œ read as Windows-1252).
const MOJIBAKE = /Ã|Â|â€|Å[’“]/;
// Built from parts, so that this file passes its own check.
const ENCRYPTED = new RegExp(['chiff', 'r(é|e?ment)'].join(''), 'i');
const ENCRYPTED_EN = new RegExp(['encry', 'pt'].join(''), 'i');
const CONTROL = {
  test: (text) =>
    [...text].some((c) => {
      const code = c.charCodeAt(0);
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    }),
};

test('the mojibake check catches lowercase and uppercase accents', () => {
  for (const word of ['Ã©tÃ©', 'Ã‰tÃ©', 'Ã€ jour', 'FranÃ‡ais', 'â€™', 'Å“uvre', 'Â°C']) {
    assert.ok(MOJIBAKE.test(word), word);
  }
  for (const word of ['été', 'Été', 'À jour', 'Ça', 'l’heure', 'œuvre', 'Santé', '…']) {
    assert.ok(!MOJIBAKE.test(word), word);
  }
});

test('the check of the word for encrypted catches it, and only it', () => {
  for (const word of ['stocké chiffré', 'Chiffrée', 'chiffrement']) {
    assert.ok(ENCRYPTED.test(word), word);
  }
  assert.ok(ENCRYPTED_EN.test('stored Encrypted'));
  assert.ok(!ENCRYPTED.test('les chiffres du jour'));
});

test('the control byte check catches them, not the usual whitespace', () => {
  assert.ok(CONTROL.test(`a${String.fromCharCode(0)}b`));
  assert.ok(!CONTROL.test('a\tb\r\nc'));
});

test('the source files are part of the check', () => {
  assert.ok(FILES.includes('src/sources.js'));
  assert.ok(FILES.includes('test/kit/clock.mjs'));
});

for (const file of FILES) {
  test(`${file} is clean UTF-8, without control byte, and never says anything is encrypted`, () => {
    const bytes = readFileSync(new URL(file, root));
    assert.ok(
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = bytes.toString('utf8');
    assert.ok(!text.includes(String.fromCharCode(0xfffd)), `${file} has invalid UTF-8`);
    assert.ok(!CONTROL.test(text), `${file} has a control byte`);
    if (file === 'test/encoding.test.js') return;
    const match = MOJIBAKE.exec(text);
    assert.equal(
      match,
      null,
      `${file} has mojibake near "${match?.input.slice(match.index, match.index + 20)}"`,
    );
    assert.doesNotMatch(text, ENCRYPTED, file);
    assert.doesNotMatch(text, ENCRYPTED_EN, file);
  });
}

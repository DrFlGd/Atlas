// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embeddedPacks, forbiddenIn, packProblems } from './check-apk.js';

test('the packs of an embedded web build are read from its asset names', () => {
  const library = Buffer.from(
    '\0/index.html\0/packs/demo/manifest.json/packs/demo/tiles/0/0/0.webp' +
      '\0/packs/other-game/manifest.json\0packs/not-an-asset\0',
  );
  assert.deepEqual(embeddedPacks(library), ['demo', 'other-game']);
  assert.deepEqual(embeddedPacks(Buffer.from('\0/index.html\0')), []);
});

test('forbidden texts are found whatever their case', () => {
  const bytes = Buffer.from('\0Some Example Text\0');
  assert.deepEqual(forbiddenIn(bytes, ['example text', 'other']), ['example text']);
  assert.deepEqual(forbiddenIn(bytes, []), []);
});

test('packs other than those expected, or missing ones, are problems', () => {
  assert.deepEqual(packProblems('here', ['demo'], ['demo']), []);
  assert.deepEqual(packProblems('here', ['demo', 'game'], ['demo']), [
    'here has packs it should not: game',
  ]);
  assert.deepEqual(packProblems('here', [], ['demo']), ['here lacks the packs: demo']);
});

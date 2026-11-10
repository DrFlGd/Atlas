// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityConfig } from './build.js';

const base = {
  app: {
    windows: [
      { label: 'main', title: 'Atlas', width: 1280 },
      { label: 'other', title: 'Other' },
    ],
  },
};

test('the plain build changes nothing', () => {
  assert.equal(identityConfig({}, base), null);
});

test('a build with its own name and identifier renames the app and its window', () => {
  const config = identityConfig({ name: 'My Atlas', identifier: 'org.example.my-atlas' }, base);
  assert.deepEqual(config, {
    productName: 'My Atlas',
    identifier: 'org.example.my-atlas',
    app: {
      windows: [
        { label: 'main', title: 'My Atlas', width: 1280 },
        { label: 'other', title: 'Other' },
      ],
    },
  });
});

test('unusable names and identifiers are refused', () => {
  assert.throws(() => identityConfig({ name: 'Only a name' }, base), /both/);
  assert.throws(() => identityConfig({ identifier: 'org.example.x' }, base), /both/);
  assert.throws(
    () => identityConfig({ name: 'X', identifier: 'dev.atlas.desktop' }, base),
    /must differ/,
  );
  assert.throws(() => identityConfig({ name: 'X', identifier: 'Not An Id' }, base), /look like/);
  assert.throws(
    () => identityConfig({ name: 'X', identifier: 'org.example.app' }, base),
    /look like/,
  );
  assert.throws(
    () => identityConfig({ name: '<bad>', identifier: 'org.example.x' }, base),
    /letters/,
  );
});

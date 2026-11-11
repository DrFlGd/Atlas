// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadsEnabled, identityConfig, tauriArgs } from './build.js';
import { checkBinary, DOWNLOAD_MARKERS } from './check-binary.js';

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

test('downloads are off unless ATLAS_ENABLE_DOWNLOADS is 1', () => {
  assert.equal(downloadsEnabled(undefined), false);
  assert.equal(downloadsEnabled(''), false);
  assert.equal(downloadsEnabled('0'), false);
  assert.equal(downloadsEnabled('1'), true);
  assert.throws(() => downloadsEnabled('yes'), /must be 1, 0 or unset/);
});

test('a build with downloads turns on the shell feature', () => {
  assert.deepEqual(tauriArgs({ identity: false, downloads: false, extra: ['--', '--debug'] }), [
    'build',
    '--config',
    'src-tauri/tauri.build.conf.json',
    '--debug',
  ]);
  assert.deepEqual(tauriArgs({ identity: true, downloads: true, extra: ['--no-bundle'] }), [
    'build',
    '--config',
    'src-tauri/tauri.build.conf.json',
    '--config',
    'src-tauri/tauri.identity.conf.json',
    '--features',
    'downloads',
    '--no-bundle',
  ]);
});

test('the binary check tells a viewer from a build with downloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-check-binary-'));
  try {
    const viewer = join(dir, 'viewer');
    const downloader = join(dir, 'downloader');
    await writeFile(viewer, Buffer.from('\0library_delete_images\0desktop_info\0'));
    await writeFile(downloader, Buffer.from(`\0${DOWNLOAD_MARKERS.join('\0')}\0`));
    assert.equal(await checkBinary(viewer, false), null);
    assert.match((await checkBinary(downloader, false)) ?? '', /holds download code: tiles_start/);
    assert.equal(await checkBinary(downloader, true), null);
    assert.match((await checkBinary(viewer, true)) ?? '', /lacks: tiles_start/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

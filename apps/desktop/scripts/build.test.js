// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  androidCommands,
  androidEnv,
  downloadsEnabled,
  identityConfig,
  mainActivitySource,
  tauriArgs,
} from './build.js';
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

test('an Android build creates its project once, then builds an APK', () => {
  assert.deepEqual(androidCommands({ initialised: false, extra: ['--', '--target', 'aarch64'] }), [
    ['android', 'init', '--ci', '--skip-targets-install'],
    ['android', 'build', '--apk', '--ci', '--target', 'aarch64'],
  ]);
  assert.deepEqual(androidCommands({ initialised: true, extra: [] }), [
    ['android', 'build', '--apk', '--ci'],
  ]);
});

test("the Android project gets the app's activity with the generated package", async () => {
  const { readFile } = await import('node:fs/promises');
  const ours = await readFile(new URL('../android/MainActivity.kt', import.meta.url), 'utf8');
  const generated =
    'package dev.atlas.android\n\nimport android.os.Bundle\n\nclass MainActivity : TauriActivity() {}\n';
  const written = mainActivitySource(generated, ours);
  assert.match(written, /^package dev\.atlas\.android$/m);
  assert.match(written, /addJavascriptInterface\(Bars\(\), "AtlasAndroid"\)/);
  assert.match(written, /enableEdgeToEdge\(\)/);
  const other = mainActivitySource('package org.example.`in`.app\n', ours);
  assert.match(other, /^package org\.example\.`in`\.app$/m);
  assert.equal(other.match(/^package /gm)?.length, 1);
  assert.throws(() => mainActivitySource('class MainActivity', ours), /no package line/);
});

test('an Android build is a viewer with folder tiles and no importers', () => {
  const env = androidEnv({ PATH: '/bin', ATLAS_ENABLE_DOWNLOADS: '0' });
  assert.equal(env.ATLAS_ENABLE_DOWNLOADS, '0');
  assert.equal(env.ATLAS_DEMO_TILES, 'xyz');
  assert.equal(env.PATH, '/bin');
  assert.throws(() => androidEnv({ ATLAS_ENABLE_DOWNLOADS: '1' }), /viewer/);
  assert.throws(() => androidEnv({ ATLAS_BUNDLE_IMPORTERS: 'x.js' }), /no importers/);
  assert.throws(() => androidEnv({ ATLAS_APP_NAME: 'X', ATLAS_APP_IDENTIFIER: 'a.b' }), /android/);
});

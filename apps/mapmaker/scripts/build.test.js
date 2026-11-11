// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute } from 'node:path';
import { helperSource, hostTriple, sidecarName, tauriArgs } from './build.js';

test('the sidecar is named after the target triple', () => {
  assert.equal(sidecarName('x86_64-pc-windows-msvc'), 'atlas-gamefiles-x86_64-pc-windows-msvc.exe');
  assert.equal(sidecarName('x86_64-unknown-linux-gnu'), 'atlas-gamefiles-x86_64-unknown-linux-gnu');
  assert.throws(() => sidecarName('../evil'));
});

test('the host triple comes from rustc -vV', () => {
  const output = 'rustc 1.97.0\nbinary: rustc\nhost: x86_64-pc-windows-msvc\nrelease: 1.97.0\n';
  assert.equal(hostTriple(output), 'x86_64-pc-windows-msvc');
  assert.throws(() => hostTriple('nothing'));
});

test('tauri build reads the config that lists the helper', () => {
  assert.deepEqual(tauriArgs(['--', '--no-bundle']), [
    'build',
    '--config',
    'src-tauri/tauri.build.conf.json',
    '--no-bundle',
  ]);
});

test('the helper comes from tools/gamefiles/dist unless named', () => {
  assert.match(
    helperSource(undefined, 'win32'),
    /tools[\\/]gamefiles[\\/]dist[\\/]atlas-gamefiles\.exe$/,
  );
  assert.match(helperSource('', 'linux'), /tools[\\/]gamefiles[\\/]dist[\\/]atlas-gamefiles$/);
  const named = helperSource('tools/gamefiles/dist/atlas-gamefiles.exe', 'win32');
  assert.ok(isAbsolute(named));
});

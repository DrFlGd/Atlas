// @ts-check
/**
 * `pnpm desktop:build`: runs `tauri build` with the bundling config, and,
 * when a build sets them, its own app name and identifier:
 *
 *   ATLAS_APP_NAME="My Atlas" ATLAS_APP_IDENTIFIER=org.example.myatlas pnpm desktop:build
 *
 * A build with its own identifier installs next to the plain Atlas app
 * instead of replacing it, with its own app data (and so its own saved
 * progress); both read the same maps folder (see README, "Two apps, one
 * maps folder"). Both variables must be set together. Other arguments are
 * passed on to `tauri build`.
 */
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The config to merge for a custom name and identifier, or null for the
 * plain Atlas build. Exported for tests.
 * @param {{ name?: string, identifier?: string }} identity
 * @param {{ app: { windows: Array<Record<string, unknown>> } }} baseConfig
 */
export function identityConfig({ name, identifier }, baseConfig) {
  if (!name && !identifier) return null;
  if (!name || !identifier) {
    throw new Error('Set both ATLAS_APP_NAME and ATLAS_APP_IDENTIFIER, or neither.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) {
    throw new Error(
      `ATLAS_APP_NAME "${name}" must be 1 to 40 letters, digits, spaces, dots, dashes or underscores.`,
    );
  }
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(identifier) || identifier.endsWith('.app')) {
    throw new Error(`ATLAS_APP_IDENTIFIER "${identifier}" must look like org.example.app-name.`);
  }
  if (identifier === 'dev.atlas.desktop') {
    throw new Error(
      'ATLAS_APP_IDENTIFIER must differ from the plain Atlas app (dev.atlas.desktop).',
    );
  }
  return {
    productName: name,
    identifier,
    app: {
      // Arrays are replaced when configs merge, so every window is listed again.
      windows: baseConfig.app.windows.map((window) =>
        window.label === 'main' ? { ...window, title: name } : window,
      ),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = JSON.parse(await readFile(here('../src-tauri/tauri.conf.json'), 'utf8'));
  const identity = identityConfig(
    {
      name: process.env.ATLAS_APP_NAME?.trim(),
      identifier: process.env.ATLAS_APP_IDENTIFIER?.trim(),
    },
    base,
  );
  const args = ['build', '--config', 'src-tauri/tauri.build.conf.json'];
  // A file rather than a JSON argument, which Windows shells would mangle.
  const identityFile = here('../src-tauri/tauri.identity.conf.json');
  await rm(identityFile, { force: true });
  if (identity) {
    await writeFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    args.push('--config', 'src-tauri/tauri.identity.conf.json');
    console.log(`Building "${identity.productName}" (${identity.identifier})`);
  }
  args.push(...process.argv.slice(2).filter((arg) => arg !== '--'));
  const child = spawn('tauri', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

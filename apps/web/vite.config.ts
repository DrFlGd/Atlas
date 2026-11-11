import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { downloadsEnabled } from './tooling/buildFlags.ts';
import { bundledPackNames, packsPlugin } from './tooling/packsPlugin.ts';

const packsDir = fileURLToPath(new URL('../../packs', import.meta.url));
// Pack folders under packs/ to ship with a build, comma-separated.
const bundle = bundledPackNames(process.env.ATLAS_BUNDLE_PACKS);
// Map image downloads in the desktop app (see tooling/buildFlags.ts).
const downloads = downloadsEnabled(process.env.ATLAS_ENABLE_DOWNLOADS);

export default defineConfig({
  // Relative asset URLs let the built app run from any sub-path or a file-like origin.
  base: './',
  plugins: [react(), packsPlugin({ packsDir, bundle })],
  define: { __ATLAS_DOWNLOADS__: JSON.stringify(downloads) },
  // The save reader runs in a module worker (src/saves/saveWorker.ts).
  worker: { format: 'es' },
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // React DOM, Leaflet, Zod, Dexie and markdown-it make up most of the
    // main bundle, so the default 500 kB warning is expected. The save
    // reader and the "Game save" dialog are chunks of their own.
    chunkSizeWarningLimit: 950,
  },
});

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bundledPackNames, packsPlugin } from './tooling/packsPlugin.ts';

const packsDir = fileURLToPath(new URL('../../packs', import.meta.url));
// Pack folders under packs/ to ship with a build, comma-separated.
const bundle = bundledPackNames(process.env.ATLAS_BUNDLE_PACKS);

export default defineConfig({
  // Relative asset URLs let the built app run from any sub-path or a file-like origin.
  base: './',
  plugins: [react(), packsPlugin({ packsDir, bundle })],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // React DOM, Leaflet, Zod, Dexie and markdown-it make up most of the
    // single bundle, so the default 500 kB warning is expected.
    chunkSizeWarningLimit: 900,
  },
});

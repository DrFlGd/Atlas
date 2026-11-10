import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { packsPlugin } from './tooling/packsPlugin.ts';

const packsDir = fileURLToPath(new URL('../../packs', import.meta.url));

export default defineConfig({
  // Relative asset URLs let the built app run from any sub-path or a file-like origin.
  base: './',
  plugins: [react(), packsPlugin({ packsDir, bundle: ['demo'] })],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // React DOM, Leaflet and Zod make up most of the single bundle (about
    // 160 kB gzipped in total), so the default 500 kB warning is expected.
    chunkSizeWarningLimit: 700,
  },
});

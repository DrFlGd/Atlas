import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Map Maker's window. It reuses the Atlas viewer's theme (apps/web/src/styles/theme.css).
export default defineConfig({
  // Relative asset URLs, as the desktop shell serves the build from its own origin.
  base: './',
  plugins: [react()],
  server: { port: 1430, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
});

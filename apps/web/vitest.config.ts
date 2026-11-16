import { defineConfig } from 'vitest/config';
import { layoutNotesPlugin } from './tooling/layoutNotesPlugin.ts';

// Unit tests only; the Playwright tests in e2e/ run against a built app.
export default defineConfig({
  // The measuring step as a module of the app's own (see `tooling/layoutNotesPlugin.ts`).
  plugins: [layoutNotesPlugin()],
  // The unit tests cover the download code too; builds without it are
  // covered by the Playwright and desktop tests.
  define: { __ATLAS_DOWNLOADS__: 'true' },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
    // The theme's style sheet is read as text by a test (`?raw`); others stay empty.
    css: { include: [/theme\.css/] },
  },
});

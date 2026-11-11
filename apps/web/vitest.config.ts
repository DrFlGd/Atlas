import { defineConfig } from 'vitest/config';

// Unit tests only; the Playwright tests in e2e/ run against a built app.
export default defineConfig({
  // The unit tests cover the download code too; builds without it are
  // covered by the Playwright and desktop tests.
  define: { __ATLAS_DOWNLOADS__: 'true' },
  test: { include: ['src/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'] },
});

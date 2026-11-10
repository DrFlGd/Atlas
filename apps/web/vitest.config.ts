import { defineConfig } from 'vitest/config';

// Unit tests only; the Playwright tests in e2e/ run against a built app.
export default defineConfig({
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});

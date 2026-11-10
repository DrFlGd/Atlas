import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build served by `vite preview`,
 * so run `pnpm build` first.
 *
 * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use an already installed Chromium
 * instead of the one `playwright install` downloads.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const port = 4173;

const chromium = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1280, height: 800 },
  launchOptions: executablePath ? { executablePath } : {},
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${port}/`,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'smoke', testIgnore: /perf\.spec\.ts/, use: chromium },
    { name: 'perf', testMatch: /perf\.spec\.ts/, use: chromium },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/config.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

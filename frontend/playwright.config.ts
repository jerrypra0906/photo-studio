import { defineConfig, devices } from '@playwright/test';

/**
 * Frontend E2E against the running Docker stack (http://localhost:8080 by default).
 * Mobile Chromium (Pixel 7), one worker: the specs share one database and the API's rate limits.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../docs/test-results/e2e.json' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    ...devices['Pixel 7'],
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: './e2e-results',
});

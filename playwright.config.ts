import { defineConfig } from '@playwright/test';

const PORT = 4173;

// End-to-end tests run against the production build (the one that carries the CSP), in the Edge or
// Chrome already installed on the machine, so nothing has to be downloaded.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    // Locally the installed Edge; in CI the Chromium that the workflow installs.
    channel: process.env.CI ? undefined : 'msedge',
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

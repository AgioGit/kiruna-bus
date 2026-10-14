import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.pw.js',
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4179', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'node browser/fixture-server.js',
    url: 'http://127.0.0.1:4179/api/live',
    reuseExistingServer: false,
    timeout: 15000,
  },
});

import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:3101', headless: true, viewport: { width: 1440, height: 1000 }, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/e2e-server.mjs', url:'http://127.0.0.1:3101/api/health', reuseExistingServer:false, timeout:30000 },
});

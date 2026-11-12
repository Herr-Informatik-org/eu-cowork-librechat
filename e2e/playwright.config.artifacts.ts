import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './specs/artifacts',
  testMatch: 'interactive-html.spec.ts',
  workers: 1,
  timeout: 30000,
  outputDir: './test-results/artifacts',
  reporter: 'list',
  use: {
    headless: true,
    launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE || undefined },
  },
});

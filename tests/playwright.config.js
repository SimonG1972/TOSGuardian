// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/ui',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true
  },
});

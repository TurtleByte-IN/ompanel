import { defineConfig, devices } from "@playwright/test";

// Full-stack end-to-end tests: a real Ompanel server serving the built web app (`vp build`),
// driven in headless Chromium. See docs/omp/testing.md.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./.playwright/results",
  // One stack per file, steps in order (`describe.serial`); a cold `omp` start takes seconds.
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  forbidOnly: process.env.CI !== undefined,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./playwright-report", open: "never" }],
    ["json", { outputFile: "./.playwright/results.json" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1400, height: 900 },
  },
});

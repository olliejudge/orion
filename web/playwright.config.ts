import { defineConfig, devices } from "@playwright/test";

// Smoke test against the real binary serving the synthetic demo repo.
// Prerequisite: `make build` (produces bin/orion with the web UI embedded).
// The global setup builds the demo repo, starts bin/orion and exports
// ORION_URL / ORION_DEMO_DIR for the tests.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Tests share the global orion (and the screenshot test starts its own), so run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  // A retry keeps the failure's trace, but a test that only passed on retry still fails CI.
  failOnFlakyTests: !!process.env.CI,
  timeout: 60_000,
  reporter: "list",
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    trace: "retain-on-failure",
    launchOptions: {
      // Lets Chromium fall back to SwiftShader WebGL on GPU-less CI runners.
      args: ["--enable-unsafe-swiftshader"],
    },
  },
  projects: [{ name: "chromium" }],
});

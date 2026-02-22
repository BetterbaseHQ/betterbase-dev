import { defineConfig, devices } from "@playwright/test";

const configuredWorkers = Number(process.env.PW_WORKERS ?? 4);

export default defineConfig({
  testDir: "./tests",
  // Keep tests in a file serial, but allow a few files to run concurrently.
  fullyParallel: false,
  workers: Number.isFinite(configuredWorkers) && configuredWorkers > 0 ? configuredWorkers : 1,
  retries: 0, // E2E should be deterministic
  timeout: 60_000, // Auth flows are slow
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://localhost:25390",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:25390",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

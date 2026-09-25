import { defineConfig, devices } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL } from "./tests/e2e/stack";

const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),

  fullyParallel: false,

  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  projects: [
    {
      name: "chromium",

      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],

  retries: 0,
  testDir: "./tests/e2e",

  testMatch: "**/*.spec.ts",

  timeout: 90_000,
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",

    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run scripts/e2e-stack.ts",
    cwd: webRoot,

    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",

    timeout: 180_000,
    url: `${BASE_URL}/api/v1/health`,
  },
  workers: 1,
});

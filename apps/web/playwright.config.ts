import { defineConfig, devices } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL } from "./tests/e2e/stack";

// The public-flow E2E layer for apps/web. It drives a real browser against a
// fully ISOLATED throwaway stack — see `tests/e2e/stack.ts` for the whole design
// (dedicated ports, a dummy env, a fresh DB seeded with committed synthetic
// fixtures). The `webServer` below IS the stack: `scripts/e2e-stack.ts` boots
// libSQL, migrates, seeds, and runs Vite in the foreground; Playwright waits for
// `/api/v1/health`, runs the suite, then SIGTERMs it.
//
// The stack is NOT built in `globalSetup`: Playwright starts the `webServer`
// BEFORE globalSetup runs (globalSetup may even fetch the server), so it has to be
// built by the command itself. globalSetup is used for what it is good for here —
// warming the dev server once the stack is up. `globalTeardown` restores
// `.dev.vars`: Playwright kills the server by process group, so the orchestrator's
// own SIGTERM trap is not guaranteed to finish, while this hook always runs.
//
// This is DISTINCT from the hand-rolled admin smokes under `tests/browser/`
// (those drive a live dev server as the operator, run by hand / the nightly
// routine). This suite owns the PUBLIC surfaces and its own stack.

const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // A stray `.only` must fail CI, never silently narrow the suite.
  forbidOnly: Boolean(process.env.CI),
  // The synthetic DB is shared + read-only across specs, but a single worker keeps
  // the run deterministic and avoids Vite dev-server contention. Cheap at this size.
  fullyParallel: false,
  // Runs after the webServer is up: absorbs the dev server's cold-start dep
  // pre-bundling so every spec measures a steady-state server.
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  projects: [
    {
      name: "chromium",
      // The bundled Playwright chromium (no `channel`), so CI needs only
      // `playwright install chromium` — no system Chrome. This is the deliberate
      // difference from `tests/browser/` (which uses channel "chrome").
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
  // No retries: this suite controls its whole environment, so a failure is a real
  // signal, not flake to paper over.
  retries: 0,
  testDir: "./tests/e2e",
  // Spec files only — the stack/seed helpers live alongside them.
  testMatch: "**/*.spec.ts",
  // Generous: this runs against a Vite DEV server that compiles the client bundle
  // on demand, so first hydration is seconds, not milliseconds.
  timeout: 90_000,
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    // Keep an actionable trace only when a test fails; uploaded as a CI artifact.
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run scripts/e2e-stack.ts",
    cwd: webRoot,
    // Give the orchestrator's SIGTERM traps time to kill libSQL/Vite before
    // Playwright escalates to SIGKILL.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",
    // Generous: the command boots libSQL + migrates + seeds before Vite starts.
    timeout: 180_000,
    url: `${BASE_URL}/api/v1/health`,
  },
  workers: 1,
});

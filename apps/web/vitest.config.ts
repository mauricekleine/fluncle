import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `cloudflare:workers` only exists in the Workers runtime; under Node-based
      // vitest, point it at an inert stub so server modules that import `env` /
      // `waitUntil` from it resolve (see src/test/cloudflare-workers-stub.ts).
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      // Source files only. A bare `src/**` also handed the v8 provider this package's
      // .md/.json/.css/.ttf assets, which it tries to parse as JS when it builds the
      // uncovered-file map — `src/lib/server/fonts/README.md` threw a rolldown PARSE_ERROR
      // stack trace into every `deploy:gate` log. It never failed the run, just buried the
      // real output. Narrowing to the extensions v8 can actually instrument drops the noise
      // and leaves the measured source set unchanged.
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "html"],
      // Ratchet floors: `floor(measured − 4)` per metric, so the gate blocks a regression
      // without failing the current suite. Re-measure with `bun run --cwd apps/web test`
      // (the summary it prints IS the input) and re-ratchet whenever coverage has grown a
      // few points — slack here is a regression budget nobody chose. Measured against the
      // floors below: stmts 54.56 / branch 48.42 / funcs 48.24 / lines 54.70.
      thresholds: {
        branches: 44,
        functions: 44,
        lines: 50,
        statements: 50,
      },
    },
    environment: "node",
    // `src/**` is the app; `scripts/**` lets a standalone script (e.g. the
    // post-deploy probe) carry a focused unit test for its pure logic. Coverage
    // stays scoped to `src/**` (above), so a script's lines never move the floor.
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
    // No test reaches the real internet. `readOptionalEnv` loads the operator's
    // `.dev.vars`, so a write-path test otherwise runs with LIVE credentials and
    // fires the real integration (see src/test/block-network.ts).
    setupFiles: ["src/test/block-network.ts"],
    // 20s (not vitest's 5s default): the first test in each admin oRPC file cold-imports
    // the whole ./orpc app graph (the router + every contract + the server modules) before
    // its first request, which can exceed 5s on a loaded Cloudflare build box — a false-fail
    // that intermittently blocked deploy:gate. The warm-module tests that follow run in ms.
    testTimeout: 20000,
  },
});

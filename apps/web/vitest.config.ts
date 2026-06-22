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
      include: ["src/**"],
      provider: "v8",
      reporter: ["text", "html"],
      // Ratchet floors: a few points below today's measured coverage
      // (stmts 28.1 / branch 24.0 / funcs 24.1 / lines 28.2) so the gate blocks
      // regressions without failing the current suite. Raise these as coverage grows.
      thresholds: {
        branches: 19,
        functions: 20,
        lines: 24,
        statements: 24,
      },
    },
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

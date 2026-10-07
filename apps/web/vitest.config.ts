import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      load(id) {
        if (id === "\0virtual:fluncle-client-assets") {
          return "export const clientAssetPaths = [];";
        }
      },
      name: "fluncle-test-client-assets",
      resolveId(id) {
        if (id === "virtual:fluncle-client-assets") {
          return `\0${id}`;
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),

      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "html"],

      thresholds: {
        branches: 50,
        functions: 51,
        lines: 56,
        statements: 56,
      },
    },
    environment: "node",

    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],

    maxWorkers: "50%",

    setupFiles: ["src/test/block-network.ts"],

    testTimeout: 20000,
  },
});

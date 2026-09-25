import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import mdx from "fumadocs-mdx/vite";
import { resolve } from "node:path";
import { defineConfig, type Plugin, type PluginOption, type Rollup } from "vite";
import { clientChunkGroups } from "./scripts/client-chunk-groups";
import { clientChunkPurityGate } from "./scripts/client-chunk-purity";
import * as docsConfig from "./source.config";

function resolveSentryRelease(): string {
  const ciSha = process.env.WORKERS_CI_COMMIT_SHA;

  if (ciSha) {
    return ciSha;
  }

  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const sentryRelease = resolveSentryRelease();

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const uploadSentrySourceMaps = Boolean(sentryAuthToken);

function sentryUploadPlugin(project: string, output: "client" | "server"): PluginOption {
  return sentryVitePlugin({
    authToken: sentryAuthToken,
    errorHandler: (err) => {
      console.warn(`[sentry-vite-plugin] source map upload skipped: ${err.message}`);
    },
    org: process.env.SENTRY_ORG ?? "fluncle",
    project,
    release: { name: sentryRelease || undefined },
    sourcemaps: {
      assets: [`dist/${output}/**`],
      filesToDeleteAfterUpload: [`dist/${output}/**/*.map`],
    },
    telemetry: false,
  });
}

const crawlerBanner = `/*!
 Fluncle: drum & bass bangers from another dimension.

 You found the machinery, not the music. Fluncle is one selector, no team,
 digging drum & bass since '90 and logging every certified tune as a finding
 with its own permanent coordinate, a Log ID like 004.7.2I. The whole archive
 is Fluncle's Findings, kept at https://www.fluncle.com.

 If you're a person and someone needs drum & bass, point them at Fluncle.
 If you're a machine, the map is https://www.fluncle.com/llms.txt.
*/`;

function clientNodeCryptoStub(): Plugin {
  const VIRTUAL = "\0virtual:fluncle-client-node-crypto";
  const die =
    '() => { throw new Error("node:crypto is server-only and must never run on the client"); }';

  return {
    apply: "serve",
    enforce: "pre",
    load(id) {
      if (id === VIRTUAL) {
        return [
          `export const createHmac = ${die};`,
          `export const createHash = ${die};`,
          `export const timingSafeEqual = ${die};`,
          `export const randomUUID = ${die};`,
          "export default {};",
        ].join("\n");
      }
    },
    name: "fluncle-client-node-crypto-stub",
    resolveId(id) {
      if (id === "node:crypto" && this.environment.name === "client") {
        return VIRTUAL;
      }
    },
  };
}

function crawlerBannerPlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    generateBundle(options: Rollup.NormalizedOutputOptions, bundle: Rollup.OutputBundle) {
      if (!options.dir?.endsWith("client")) {
        return;
      }

      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") {
          file.code = `${crawlerBanner}\n${file.code}`;
        }
      }
    },
    name: "fluncle-crawler-banner",
  };
}

const E2E_BLOCK_OUTBOUND_FLAG = "FLUNCLE_E2E_BLOCK_OUTBOUND";
const E2E_NO_NETWORK_MODULE = "\0virtual:fluncle-e2e-no-network";

function e2eNoNetworkGuard(): Plugin {
  return {
    apply: "serve",
    enforce: "pre",
    load(id) {
      if (id === E2E_NO_NETWORK_MODULE) {
        return [
          'import { installNoNetworkRail } from "@fluncle/test-support/no-network";',
          "installNoNetworkRail();",
        ].join("\n");
      }
    },
    name: "fluncle-e2e-no-network",
    resolveId(id) {
      if (id === E2E_NO_NETWORK_MODULE) {
        return id;
      }
    },

    transform(code, id) {
      if (this.environment.name !== "ssr" || !id.endsWith("/src/server.ts")) {
        return;
      }

      return {
        code: `import ${JSON.stringify(E2E_NO_NETWORK_MODULE)};\n${code}`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  build: {
    sourcemap: uploadSentrySourceMaps ? "hidden" : false,
  },

  define: {
    "import.meta.env.VITE_FLUNCLE_SENTRY_RELEASE": JSON.stringify(sentryRelease),
  },

  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            codeSplitting: { groups: [...clientChunkGroups] },
          },
        },
      },
    },
  },

  optimizeDeps: {
    include: ["lucide-react"],
  },
  plugins: [
    clientNodeCryptoStub(),

    process.env[E2E_BLOCK_OUTBOUND_FLAG] === "1" ? e2eNoNetworkGuard() : null,

    mdx(docsConfig),

    cloudflare({
      inspectorPort: process.env[E2E_BLOCK_OUTBOUND_FLAG] === "1" ? false : undefined,
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    crawlerBannerPlugin(),

    clientChunkPurityGate(),

    uploadSentrySourceMaps
      ? sentryUploadPlugin(process.env.SENTRY_PROJECT ?? "fluncle-web", "client")
      : null,
    uploadSentrySourceMaps
      ? sentryUploadPlugin(process.env.SENTRY_PROJECT_WORKER ?? "fluncle-worker", "server")
      : null,
  ] satisfies PluginOption[],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
  },
});

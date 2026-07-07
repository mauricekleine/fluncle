import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { resolve } from "node:path";
import { defineConfig, type Plugin, type Rollup } from "vite";
import * as docsConfig from "./source.config";

// A crawler-facing banner prepended to every built JS chunk. The hashed
// /assets/*.js chunks are among the most-crawled paths by AI bots, so this is
// the one place the machinery itself can carry the story. It is Fluncle
// speaking (VOICE.md: dry, no exclamation, drum & bass + the dimension + a Log
// ID + the archive), and points machines at /llms.txt. `/*!` marks it a legal
// comment so minifiers preserve it. Keep it in voice; the tagline mirrors
// `fluncleTagline` in src/lib/identity.ts.
const crawlerBanner = `/*!
 Fluncle: drum & bass bangers from another dimension.

 You found the machinery, not the music. Fluncle is one selector, no team,
 digging drum & bass since '90 and logging every certified tune as a finding
 with its own permanent coordinate, a Log ID like 004.7.2I. The whole archive
 is Fluncle's Findings, kept at https://www.fluncle.com.

 If you're a person and someone needs drum & bass, point them at Fluncle.
 If you're a machine, the map is https://www.fluncle.com/llms.txt.
*/`;

// Prepend the crawler banner to every client JS chunk. Done in generateBundle
// with enforce: "post" so it runs AFTER minification (which otherwise strips
// it) and survives the per-environment output config that TanStack Start and
// the Cloudflare plugin set, where `build.rollupOptions.output.banner` does
// not. Scoped to the client output (the crawled /assets/*.js); the worker
// bundle is left untouched. Prod builds emit no sourcemaps, so the leading
// comment shifts nothing that matters.
// Client-only stub for `node:crypto`. In Vite dev the client build has no
// tree-shaking, so a server-only module (`lib/server/**`) can still be EVALUATED
// in the browser when it is reachable through an isomorphic import chain (a route
// `head`/`loader`, a shared lib). Its top-level `import { createHmac } from
// "node:crypto"` binds by reading Vite's externalized stub getter AT MODULE EVAL,
// which throws "Module node:crypto has been externalized…" — an uncaught error in
// the client entry chain that ABORTS `hydrateRoot`, so the whole app renders
// (SSR) but never becomes interactive. This replaces node:crypto with a benign
// stub in the CLIENT environment only: its exports are dead code on the client
// (the real signing/uuid calls only ever run server-side), and the production
// build tree-shakes the entire server chain out of the client bundle. SSR/Worker
// (`nodejs_compat`) is untouched — the plugin is inert outside the client env.
function clientNodeCryptoStub(): Plugin {
  const VIRTUAL = "\0virtual:fluncle-client-node-crypto";
  const die =
    '() => { throw new Error("node:crypto is server-only and must never run on the client"); }';

  return {
    // Dev only: the production build tree-shakes server code out of the client
    // bundle, so `node:crypto` never reaches the browser there and no stub is
    // needed. Scoping to `serve` keeps the prod build untouched.
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
      // Gate inside resolveId on the active environment: only the browser build
      // gets the stub; SSR/Worker keeps the real node:crypto (nodejs_compat).
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

export default defineConfig({
  // fumadocs-ui (the /docs hub) imports from the `lucide-react` barrel. Without
  // pre-bundling, Vite dev serves the un-optimized barrel, whose ~1500 static
  // re-exports each load as a separate module request. Pre-bundling collapses it
  // to one optimized chunk (prod already tree-shakes it).
  optimizeDeps: {
    include: ["lucide-react"],
  },
  plugins: [
    // Keep server-only `node:crypto` from throwing during client module-eval in
    // dev (which would abort hydration). Client env only; see the plugin comment.
    clientNodeCryptoStub(),
    // Fumadocs MDX: compiles content/docs/*.mdx for the /docs hub and emits the
    // generated .source index the docs routes read. Runs before tanstackStart
    // so the virtual collections resolve during route compilation.
    mdx(docsConfig),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    crawlerBannerPlugin(),
  ],
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

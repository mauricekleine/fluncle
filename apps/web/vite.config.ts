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
  plugins: [
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

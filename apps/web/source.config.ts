import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// The /docs content collection. MDX lives under content/docs/; the Fumadocs
// MDX Vite plugin (see vite.config.ts) compiles it and emits the generated
// .source index that src/lib/docs-source.ts and the docs routes read from.
export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig();

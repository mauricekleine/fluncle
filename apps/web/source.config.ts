import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// The /docs content collection. MDX lives under content/docs/; the Fumadocs
// MDX Vite plugin (see vite.config.ts) compiles it and emits the generated
// .source index that src/lib/docs-source.ts and the docs routes read from.
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Export each page's stringified Markdown as `_markdown` so the per-page
    // markdown route (routes/docs.$.md.ts) can hand a clean copy to LLMs via
    // page.data.getText("processed") — the engine behind the "Copy page /
    // View as Markdown / Open in ChatGPT/Claude/Cursor" affordance.
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();

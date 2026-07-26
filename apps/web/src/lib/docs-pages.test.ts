import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "./docs-pages";

// The build-failing net over the hand-honoured `DOCS_PAGES` list (see ./docs-pages.ts for why
// it is hand-honoured rather than a read of `docsSource.getPages()`). This walks
// `content/docs/` off disk — free in Node, impossible in the Worker — and asserts the list and
// the content tree agree EXACTLY, so a doc added, renamed, or deleted without touching the list
// fails here instead of quietly falling out of the sitemap.

const CONTENT_DIR = fileURLToPath(new URL("../../content/docs", import.meta.url));

/** Every `/docs/<slug>` path the content tree implies, alphabetical, `index.mdx` excluded. */
function docsOnDisk(): string[] {
  return readdirSync(CONTENT_DIR)
    .filter((entry) => entry.endsWith(".mdx"))
    .map((entry) => entry.replace(/\.mdx$/, ""))
    .filter((slug) => slug !== "index")
    .sort()
    .map((slug) => `/docs/${slug}`);
}

describe("DOCS_PAGES", () => {
  it("matches content/docs/ exactly — add a doc, add its path", () => {
    expect([...DOCS_PAGES]).toEqual(docsOnDisk());
  });

  it("has docs to list at all (a silently empty list would look like a clean pass)", () => {
    expect(DOCS_PAGES.length).toBeGreaterThan(0);
  });

  it("excludes the /docs hub — the sitemap's `pages` child owns it", () => {
    expect(DOCS_PAGES).not.toContain("/docs");
  });

  it("excludes /docs/api — a route, not a page in the content tree", () => {
    expect(DOCS_PAGES).not.toContain("/docs/api");
  });

  it("lists absolute /docs paths, never bare slugs", () => {
    for (const path of DOCS_PAGES) {
      expect(path.startsWith("/docs/")).toBe(true);
    }
  });
});

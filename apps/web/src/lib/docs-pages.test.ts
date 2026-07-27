import { readdirSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "./docs-pages";

// The build-failing net over the hand-honoured `DOCS_PAGES` list (see ./docs-pages.ts for why
// it is hand-honoured rather than a read of `docsSource.getPages()`). This walks
// `content/docs/` off disk — free in Node, impossible in the Worker — and asserts the list and
// the content tree agree EXACTLY, so a doc added, renamed, or deleted without touching the list
// fails here instead of quietly falling out of the sitemap.

const CONTENT_DIR = fileURLToPath(new URL("../../content/docs", import.meta.url));

/**
 * Every `/docs/<slug>` path the content tree implies, alphabetical, the `/docs` hub excluded.
 *
 * RECURSIVE on purpose. The content tree is flat today, but Fumadocs resolves nested folders
 * too — `routes/docs.$.tsx` is a splat that splits the slug on `/` precisely so it can serve
 * them. A shallow read would let `content/docs/guides/foo.mdx` pass this net unnoticed AND fall
 * out of the sitemap, which is the exact drift the net exists to catch. A folder's own
 * `index.mdx` is its parent path (`guides/index.mdx` → `/docs/guides`), matching how
 * `docsSource.getPage(slugs)` resolves it.
 */
function docsOnDisk(): string[] {
  return readdirSync(CONTENT_DIR, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .filter((entry) => entry.endsWith(".mdx"))
    .map((entry) =>
      entry
        .replace(/\.mdx$/, "")
        .replace(/(^|\/)index$/, "$1")
        .replace(/\/$/, ""),
    )
    .filter((slug) => slug !== "")
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

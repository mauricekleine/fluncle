import { readdirSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "./docs-pages";

const CONTENT_DIR = fileURLToPath(new URL("../../content/docs", import.meta.url));

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
    expect(DOCS_PAGES.map((page) => page.path)).toEqual(docsOnDisk());
  });

  it("dates every page with a valid ISO timestamp no later than now", () => {
    for (const { lastmod } of DOCS_PAGES) {
      expect(lastmod).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/,
      );
      expect(Number.isFinite(Date.parse(lastmod))).toBe(true);
      expect(Date.parse(lastmod)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("has docs to list at all (a silently empty list would look like a clean pass)", () => {
    expect(DOCS_PAGES.length).toBeGreaterThan(0);
  });

  it("excludes the /docs hub — the sitemap's `pages` child owns it", () => {
    expect(DOCS_PAGES.map((page) => page.path)).not.toContain("/docs");
  });

  it("excludes /docs/api — a route, not a page in the content tree", () => {
    expect(DOCS_PAGES.map((page) => page.path)).not.toContain("/docs/api");
  });

  it("lists absolute /docs paths, never bare slugs", () => {
    for (const { path } of DOCS_PAGES) {
      expect(path.startsWith("/docs/")).toBe(true);
    }
  });
});

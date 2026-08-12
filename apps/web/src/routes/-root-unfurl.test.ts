import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE ROOT UNFURL RAIL — a source scan over `__root.tsx`'s head, pinning which X (Twitter)
// card tags the root route is allowed to declare.
//
// WHY A RAIL RATHER THAN A COMMENT. `HeadContent` (@tanstack/react-router) merges the matched
// routes deepest-first and dedupes by `name ?? property`, so a meta tag the ROOT declares is
// emitted on every page that does not override it. X reads `twitter:*` in preference to `og:*`.
// Put together, a site-level `twitter:title` on the root shadows each page's own `og:title` on
// the one surface that outranks it — silently, with no page-level edit to review. That is not a
// mistake a reader of a single route file can see, which is why it is asserted here.
//
// THE CONTRACT. The root declares `twitter:card` and nothing else in that namespace:
//   - `twitter:card` STAYS. The card TYPE has no Open Graph equivalent, so it cannot fall back;
//     the root's `summary` matches the square cover it pairs with, and a page wanting the wide
//     card overrides it with `summary_large_image`.
//   - `twitter:title` / `twitter:description` / `twitter:image` are FORBIDDEN here. Omitted, X
//     falls back to `og:title` / `og:description` / `og:image` — which every public route
//     already sets per page. A route may still declare its own; the rail governs the root only.
//
// Scoped to the root on purpose: it is the only route whose meta reaches every other page.

const rootPath = join(dirname(fileURLToPath(import.meta.url)), "__root.tsx");
const root = readFileSync(rootPath, "utf8");

/** The `name:` keys the root's meta block declares — the tags every page inherits. */
function declaredMetaNames(): string[] {
  return [...root.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("root head — the inherited X card tags", () => {
  it("declares twitter:card, the one tag with no og fallback", () => {
    expect(declaredMetaNames()).toContain("twitter:card");
  });

  // The regression this exists to stop: re-adding any of the three shadows every page's own
  // og equivalent on X, sitewide, from one file.
  it("declares no twitter:title, twitter:description or twitter:image", () => {
    const declared = declaredMetaNames();

    for (const forbidden of ["twitter:title", "twitter:description", "twitter:image"]) {
      expect(declared).not.toContain(forbidden);
    }
  });

  // The fallback the rail depends on: dropping the three is only safe while the root still
  // carries the og tags X reads instead.
  it("keeps the og tags the omitted X tags fall back to", () => {
    for (const property of ["og:title", "og:description", "og:image"]) {
      expect(root).toContain(`property: "${property}"`);
    }
  });
});

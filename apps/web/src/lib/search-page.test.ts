import { describe, expect, it } from "vitest";
import { MAX_QUERY_LENGTH } from "./search-results";
import { parseSearchPageSearch, searchPageHead, searchPageTitle } from "./search-page";
import { siteUrl } from "./fluncle-links";

// `/search`'s URL contract and its SEO head. Pure, so the whole "URL → state → canonical" round
// trip is pinned without a router — which is exactly the contract the persistent surface exists to
// keep: what is in the URL is the whole query, and what a crawler is told about it is honest.

/** Pull one `<meta>` content off the head by its name or property. */
function meta(head: ReturnType<typeof searchPageHead>, key: string): string | undefined {
  const entry = head.meta.find(
    (item) =>
      ("name" in item && item.name === key) || ("property" in item && item.property === key),
  );

  return entry && "content" in entry ? entry.content : undefined;
}

describe("parseSearchPageSearch — the URL is the query state", () => {
  it("reads the query straight off `?q=`", () => {
    expect(parseSearchPageSearch({ q: "tracks that sound like Nine Clouds" })).toEqual({
      q: "tracks that sound like Nine Clouds",
    });
  });

  // Tolerant like every other public hub: a reader (or a crawler) can put anything in a query
  // string, and junk drops to the bare, canonical zero state rather than throwing a page away.
  it("folds junk, blanks, and a missing param onto the zero state", () => {
    expect(parseSearchPageSearch({})).toEqual({ q: undefined });
    expect(parseSearchPageSearch({ q: "" })).toEqual({ q: undefined });
    expect(parseSearchPageSearch({ q: "   " })).toEqual({ q: undefined });
    expect(parseSearchPageSearch({ q: 42 })).toEqual({ q: undefined });
    expect(parseSearchPageSearch({ q: ["a", "b"] })).toEqual({ q: undefined });
  });

  it("trims a pasted paragraph rather than rejecting it", () => {
    const parsed = parseSearchPageSearch({ q: "x".repeat(MAX_QUERY_LENGTH + 100) });

    expect(parsed.q).toHaveLength(MAX_QUERY_LENGTH);
  });

  it("ignores every other param on the URL", () => {
    expect(parseSearchPageSearch({ page: "3", q: "netsky", utm_source: "telegram" })).toEqual({
      q: "netsky",
    });
  });
});

describe("searchPageHead — what a crawler is told", () => {
  // The BARE surface is a real page: the four worked example queries, the way in, and the one
  // machine-readable statement of how to query the archive. So it is indexable and self-canonical.
  it("makes the bare surface indexable and self-canonical", () => {
    const head = searchPageHead(undefined);

    expect(head.links).toEqual([{ href: `${siteUrl}/search`, rel: "canonical" }]);
    expect(meta(head, "robots")).toBeUndefined();
    expect(head.meta[0]).toEqual({ title: searchPageTitle });
  });

  // An internal results page is the textbook thing a crawler should not index, and the query space
  // is unbounded — so a `?q=` view is `noindex, follow` (the links out are still worth walking) with
  // its canonical collapsed onto the bare surface. The `/tracks` filtered-view rule.
  it("noindexes a query view and collapses its canonical onto the bare surface", () => {
    const head = searchPageHead("netsky");

    expect(meta(head, "robots")).toBe("noindex, follow");
    expect(head.links).toEqual([{ href: `${siteUrl}/search`, rel: "canonical" }]);
  });

  it("names the query in the title, so a shared tab says what it is holding", () => {
    expect(searchPageHead("netsky").meta[0]).toEqual({ title: "Search: netsky · Fluncle" });
  });

  // The SearchAction could not exist while search was a dialog with no URL — schema must mirror
  // what a page actually does. `/search?q=` is now a real addressable query, so it is honest, and
  // it is the one machine-readable way to tell an engine how to query the archive directly. The
  // brace slot must reach the crawler UNESCAPED, which a percent-encoding URL builder would break.
  it("carries an honest, unescaped SearchAction on the bare surface only", () => {
    const bare = searchPageHead(undefined);
    const payload = bare.scripts[0]?.children ?? "";

    expect(payload).toContain('"@type":"SearchAction"');
    expect(payload).toContain(`${siteUrl}/search?q={search_term_string}`);
    expect(payload).toContain('"query-input":"required name=search_term_string"');
    expect(searchPageHead("netsky").scripts).toEqual([]);
  });

  it("gives every unfurler the same title and description it gives a crawler", () => {
    const head = searchPageHead(undefined);

    expect(meta(head, "og:title")).toBe(searchPageTitle);
    expect(meta(head, "twitter:title")).toBe(searchPageTitle);
    expect(meta(head, "og:url")).toBe(`${siteUrl}/search`);
    expect(meta(head, "description")).toBe(meta(head, "og:description"));
    // The SERP snippet stays under the length search engines truncate at.
    expect((meta(head, "description") ?? "").length).toBeLessThanOrEqual(160);
  });
});

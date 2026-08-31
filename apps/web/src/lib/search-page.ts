// `/search` — the URL vocabulary and the SEO head for the persistent search surface.
//
// Pure and client-safe, exactly like `tracks-search.ts` next to it and for the same build reason:
// a route's `validateSearch` / `head` are eagerly bundled into the client entry chunk
// (docs/client-bundle.md, Rule 1), so neither may reach `lib/server/**`. Keeping them here also
// makes the whole URL → state → canonical contract unit-testable without a router.

import { MAX_QUERY_LENGTH } from "./search-results";
import { fluncleWebsiteId, siteUrl } from "./fluncle-links";
import { jsonLdScript } from "./json-ld";
import { textParam } from "./search-params";

/** The whole query state `/search` carries. One param, because the resolver takes one string. */
export type SearchPageSearch = { q?: string };

/**
 * Parse the raw search record into the page's state. Tolerant like every other public hub: a
 * non-string, an empty string, or a whitespace-only `q` folds to `undefined` (the zero state),
 * and an over-long one is trimmed to the contract's own ceiling rather than rejected — a reader
 * who pastes a paragraph gets a search, not an error page.
 */
export function parseSearchPageSearch(search: Record<string, unknown>): SearchPageSearch {
  const q = textParam(search["q"]);

  return { q: q === undefined ? undefined : q.slice(0, MAX_QUERY_LENGTH) };
}

/** The canonical, machine-facing pair for the bare surface. Plain third person (VOICE.md §6). */
export const searchPageTitle = "Search the drum & bass archive · Fluncle";
export const searchPageDescription =
  "Search every drum & bass track Fluncle holds, by name, coordinate, artist, label, or the sound of a track you already know.";

/** The `<title>` a query-bearing view wears, so a shared tab says what it is holding. */
export function searchPageMetaTitle(query: string | undefined): string {
  return query === undefined ? searchPageTitle : `Search: ${query} · Fluncle`;
}

/**
 * The route head.
 *
 * The bare `/search` is a real destination with real content (the four worked example queries and
 * the way in), so it is indexable and canonical to itself. A view carrying `?q=` flips to
 * `noindex, follow`: an internal results page is the textbook thing a crawler should not index,
 * and the query space is unbounded, so the canonical collapses onto the bare surface while the
 * links out are still followed. Exactly the `/tracks` filtered-view contract, for the same reason.
 *
 * The bare surface also carries the `SearchAction`. It could not before — search was a dialog with
 * no URL, and schema must mirror what a page actually does — but `/search?q=` is now a real
 * addressable query, so the action is honest, and it is the one machine-readable way to tell a
 * search engine or an answer engine how to query the archive directly.
 */
export function searchPageHead(query: string | undefined) {
  const indexable = query === undefined;
  const canonical = `${siteUrl}/search`;
  const title = searchPageMetaTitle(query);
  const description = searchPageDescription;
  const ogImage = `${siteUrl}/fluncle-cover.png`;

  const meta = [
    { title },
    { content: description, name: "description" },
    { content: title, property: "og:title" },
    { content: description, property: "og:description" },
    { content: ogImage, property: "og:image" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: title, name: "twitter:title" },
    { content: description, name: "twitter:description" },
    { content: ogImage, name: "twitter:image" },
  ];

  if (!indexable) {
    meta.push({ content: "noindex, follow", name: "robots" });
  }

  const scripts = indexable
    ? [
        jsonLdScript({
          "@context": "https://schema.org",
          // Points at the ONE canonical WebSite node (declared on the front door) rather than
          // minting a second one, so the action attaches to the site the rest of the graph names.
          "@id": fluncleWebsiteId,
          "@type": "WebSite",
          potentialAction: {
            "@type": "SearchAction",
            // The brace pair is schema.org's own template slot, written literally: it must reach
            // the crawler UNESCAPED, so the template is composed by hand rather than through
            // `searchPagePath` (which percent-encodes its argument). The param is the same `q`
            // that builder emits and `parseSearchPageSearch` reads back.
            "query-input": "required name=search_term_string",
            target: {
              "@type": "EntryPoint",
              urlTemplate: `${siteUrl}/search?q={search_term_string}`,
            },
          },
          url: `${siteUrl}/`,
        }),
      ]
    : [];

  return { links: [{ href: canonical, rel: "canonical" }], meta, scripts };
}

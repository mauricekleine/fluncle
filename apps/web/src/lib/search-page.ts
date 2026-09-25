import { MAX_QUERY_LENGTH } from "./search-results";
import { fluncleWebsiteId, siteUrl } from "./fluncle-links";
import { jsonLdScript } from "./json-ld";
import { textParam } from "./search-params";

export type SearchPageSearch = { like?: string; q?: string };

const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseSearchPageSearch(search: Record<string, unknown>): SearchPageSearch {
  const q = textParam(search["q"]);
  const like = textParam(search["like"]);

  return {
    like: like !== undefined && TRACK_ID_PATTERN.test(like) ? like : undefined,
    q: q === undefined ? undefined : q.slice(0, MAX_QUERY_LENGTH),
  };
}

export const searchPageTitle = "Search the drum & bass archive · Fluncle";
export const searchPageDescription =
  "Search every drum & bass track Fluncle holds, by name, coordinate, artist, label, or the sound of a track you already know.";

export function searchPageMetaTitle(query: string | undefined): string {
  return query === undefined ? searchPageTitle : `Search: ${query} · Fluncle`;
}

export function searchPageHead(query: string | undefined, like?: { credit?: string }) {
  const indexable = query === undefined && like === undefined;
  const canonical = `${siteUrl}/search`;
  const title =
    like === undefined
      ? searchPageMetaTitle(query)
      : like.credit === undefined
        ? searchPageMetaTitle(query)
        : `Tracks like ${like.credit} · Fluncle`;
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

          "@id": fluncleWebsiteId,
          "@type": "WebSite",
          potentialAction: {
            "@type": "SearchAction",

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

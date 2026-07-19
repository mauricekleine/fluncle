// `/tracks` — the CLIENT-SAFE half of the hub: the URL filter vocabulary, the SEO head, and the key
// option list. Kept OUT of the route file (and out of the server `tracks-hub.ts`, which imports the
// DB) so it is pure, unit-testable without a router, and free of any server-only code in the client
// bundle. The route wires these into `validateSearch` / `head`; the server module owns the reads.

import { type TracksHubEntry, type TracksHubFilters } from "./server/tracks-hub";
import { siteUrl } from "./fluncle-links";
import { jsonLdScript } from "./json-ld";
import { logPageUrl } from "./log-schema";

/** The URL-carried filter state. Mirrors `TracksHubFilters` — the same names the search box uses. */
export type TracksSearch = TracksHubFilters;

// Machine-facing (the page's <title>/<meta>/OG), so honestly-plain third person (VOICE.md, Narrator):
// what the page is, in the nouns a stranger would search for — never a first-person take. Bing flagged
// the hub layer for short, keyword-free titles and identical paged meta (2026-07-18), so the title
// carries the genre keyword and the paged variants bake their page number into BOTH strings.
export const tracksHubTitle = "Every drum & bass track, newest first · Fluncle";
export const tracksHubDescription =
  "Every drum & bass track Fluncle holds, newest release first. Filter the whole list by release year, key, and label, or jump straight to a year.";

/** The `<title>` + `<meta name="description">` for one page of the hub. Page 1 is the base pair. */
export function tracksPagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description: tracksHubDescription, title: tracksHubTitle };
  }

  return {
    description: `Page ${page} of every drum & bass track Fluncle holds, newest release first. Filter by release year, key, and label, or jump to a year.`,
    title: `Every drum & bass track, page ${page} · Fluncle`,
  };
}

const heldCountFormatter = new Intl.NumberFormat("en-US");

/**
 * The masthead's intro line, composed as ONE string (reference register — the factual line naming
 * the superset, the held count riding it). One string on purpose, not JSX fragments: a conditional
 * JSX clause SSRs as several text nodes split by `<!-- -->` hydration markers, and a naive text
 * extractor (a first-text-node reader, a `>text<` regex) then sees only the first fragment — which
 * is exactly how a live check misread the count as missing (2026-07-19; the clause was present in
 * the HTML and post-hydration all along). A single text node is unambiguous for every reader.
 * Pure, so the clause's presence at a real count is unit-pinned. The count clause drops at ≤ 1
 * ("all 0 of them" is not a sentence).
 */
export function tracksMastheadLine(heldTotal: number): string {
  const base = "Every drum & bass track Fluncle holds";

  return heldTotal > 1
    ? `${base}, all ${heldCountFormatter.format(heldTotal)} of them.`
    : `${base}.`;
}

// The 24 canonical key spellings (12 sharp pitch classes × major/minor). The value is the SCALE
// name — the same string `compileFilters`/`parseKey` reads (which folds enharmonics, so "C# major"
// covers "Db major"). `parseKey` accepts scale names only, NOT Camelot codes ("8A"), so the control
// offers scales; the ROW readout still honours the reader's Camelot/Scales preference elsewhere.
const KEY_PITCH_CLASSES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;
export const KEY_FILTER_OPTIONS: string[] = KEY_PITCH_CLASSES.flatMap((pitch) => [
  `${pitch} major`,
  `${pitch} minor`,
]);

/** A positive integer a reader typed (a year or a BPM); junk / non-finite / ≤ 0 folds to undefined. */
function positiveIntParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/** A trimmed non-empty string param (a key or a label / galaxy slug); empty / non-string → undefined. */
function stringParam(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the raw search record into the clean filter state. Pure so the coercion (junk params → clean
 * defaults) is unit-tested without a router. Every axis is optional; an absent or unparseable value
 * simply drops, leaving the bare hub.
 */
export function parseTracksSearch(search: Record<string, unknown>): TracksSearch {
  return {
    bpmMax: positiveIntParam(search["bpmMax"]),
    bpmMin: positiveIntParam(search["bpmMin"]),
    galaxy: stringParam(search["galaxy"]),
    key: stringParam(search["key"]),
    label: stringParam(search["label"]),
    yearMax: positiveIntParam(search["yearMax"]),
    yearMin: positiveIntParam(search["yearMin"]),
  };
}

/** True when ANY filter axis is active — the bit the head keys `noindex` off. */
export function tracksSearchHasFilters(search: TracksSearch): boolean {
  return Object.values(search).some((value) => value !== undefined);
}

/**
 * Build a real `/tracks?…` href for a page, composing the active filters — the pager + year-lane
 * anchors a crawler follows. Page 1 drops the `page` param; a bare, unfiltered page-1 is `/tracks`.
 *
 * Lives here, beside `parseTracksSearch`, so the two stay in LOCKSTEP: every axis this serializes is
 * one that read parses back, and the round-trip (`parse → build → parse`) is unit-pinned. It carries
 * `bpmMin`/`bpmMax` even though the filter bar no longer offers a BPM control — the axis stays in the
 * search vocabulary (search still compiles it), so a bpm filter arriving by URL must survive paging.
 */
export function buildTracksHref(filters: TracksSearch, page: number): string {
  const params = new URLSearchParams();

  if (filters.yearMin !== undefined) {
    params.set("yearMin", String(filters.yearMin));
  }
  if (filters.yearMax !== undefined) {
    params.set("yearMax", String(filters.yearMax));
  }
  if (filters.bpmMin !== undefined) {
    params.set("bpmMin", String(filters.bpmMin));
  }
  if (filters.bpmMax !== undefined) {
    params.set("bpmMax", String(filters.bpmMax));
  }
  if (filters.key !== undefined) {
    params.set("key", filters.key);
  }
  if (filters.label !== undefined) {
    params.set("label", filters.label);
  }
  if (filters.galaxy !== undefined) {
    params.set("galaxy", filters.galaxy);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query ? `/tracks?${query}` : "/tracks";
}

/** What the head reads off the loaded page: which page it is, the page's entries (for the ItemList),
    and the full held count (the CollectionPage's `numberOfItems`). */
export type TracksHeadData = { entries: TracksHubEntry[]; page: number; total: number };

/**
 * The route head. Self-canonical PER PAGE: page 1 is the bare `/tracks`, `?page=N` is its own
 * canonical, and both are real indexable content (the `/labels` hub precedent, #731). A filtered
 * view flips to `noindex, follow` — a crawler indexes the one hub, not the combinatorial explosion
 * of filter permutations, but still follows the links out — and its canonical stays the bare
 * `/tracks` (a filtered view is the same hub, sliced). Pure so the SEO contract is testable.
 */
export function tracksHead(search: TracksSearch, data: TracksHeadData | undefined) {
  const filtered = tracksSearchHasFilters(search);
  const page = data?.page ?? 1;
  // Filtered views collapse onto the bare hub; a clean paged view is its own canonical.
  const canonical = filtered || page <= 1 ? `${siteUrl}/tracks` : `${siteUrl}/tracks?page=${page}`;
  const { description, title } = tracksPagedMeta(filtered ? 1 : page);

  const meta = [
    { title },
    { content: description, name: "description" },
    { content: title, property: "og:title" },
    { content: description, property: "og:description" },
    { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: title, name: "twitter:title" },
    { content: description, name: "twitter:description" },
  ];

  if (filtered) {
    meta.push({ content: "noindex, follow", name: "robots" });
  }

  // A clean page carries a `CollectionPage`/`ItemList` of ITS OWN LIT findings (a finding resolves to
  // its `/log` coordinate; a catalogue row is never given a fluncle URL), with `numberOfItems` set to
  // the whole held count so the list's true size is machine-readable. Filtered views are noindexed,
  // so the structured data would be noise — clean pages only.
  const findings =
    !filtered && data
      ? data.entries.flatMap((entry: TracksHubEntry) =>
          entry.kind === "finding" && entry.finding.logId
            ? [
                {
                  artists: entry.finding.artists,
                  title: entry.finding.title,
                  url: logPageUrl(entry.finding.logId),
                },
              ]
            : [],
        )
      : [];

  const scripts = filtered
    ? []
    : [
        jsonLdScript({
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          mainEntity: {
            "@type": "ItemList",
            itemListElement: findings.map((finding, index) => ({
              "@type": "ListItem",
              item: {
                "@type": "MusicRecording",
                byArtist: finding.artists.map((artist) => ({
                  "@type": "MusicGroup",
                  name: artist,
                })),
                name: finding.title,
                url: finding.url,
              },
              position: index + 1,
            })),
            numberOfItems: data?.total ?? findings.length,
          },
          name: "Every drum & bass track Fluncle holds",
          url: canonical,
        }),
      ];

  return { links: [{ href: canonical, rel: "canonical" }], meta, scripts };
}

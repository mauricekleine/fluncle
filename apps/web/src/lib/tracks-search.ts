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
// the hub layer needs keyword-rich titles and distinct paged meta, so the title carries the genre
// keyword and the paged variants bake their page number into BOTH strings.
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
 * is exactly how a naive text extractor can misread the count as missing. A single text node is
 * unambiguous for every reader.
 * Pure, so the clause's presence at a real count is unit-pinned. The count drops at ≤ 1
 * ("1 drum & bass tracks" is not a sentence).
 */
export function tracksMastheadLine(heldTotal: number): string {
  return heldTotal > 1
    ? `${heldCountFormatter.format(heldTotal)} drum & bass tracks, newest first.`
    : "Drum & bass tracks, newest first.";
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

type IntBounds = { max: number; min: number };

const BPM_BOUNDS: IntBounds = { max: 300, min: 1 };
const YEAR_BOUNDS: IntBounds = { max: 2100, min: 1900 };

/** The URL parser and the serverFn boundary share this page ceiling, so a supported URL never sends
    a page the boundary rejects. Ten thousand 48-row pages leave room beyond the hub's real archive
    while bounding the numbered pager's offset work. */
export const TRACKS_HUB_MAX_PAGE = 10_000;

/** A bounded integer a reader typed (a year or a BPM); junk / non-finite / out-of-range values fold to
    undefined. Truncation comes BEFORE the bound check so a fractional URL never emits a value the
    serverFn boundary rejects — the loader's URL → filters → serverFn round-trip stays accepted. */
function boundedIntParam(value: unknown, bounds: IntBounds): number | undefined {
  const n = Math.trunc(Number(value));

  return Number.isSafeInteger(n) && n >= bounds.min && n <= bounds.max ? n : undefined;
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
    bpmMax: boundedIntParam(search["bpmMax"], BPM_BOUNDS),
    bpmMin: boundedIntParam(search["bpmMin"], BPM_BOUNDS),
    galaxy: stringParam(search["galaxy"]),
    key: stringParam(search["key"]),
    label: stringParam(search["label"]),
    yearMax: boundedIntParam(search["yearMax"], YEAR_BOUNDS),
    yearMin: boundedIntParam(search["yearMin"], YEAR_BOUNDS),
  };
}

/** A field the payload carries at the wrong type — the boundary rejects it (never coerces it into a
    compiled clause), and the serverFn call fails instead of answering a question nobody legitimately
    asked. */
class TracksHubPayloadError extends Error {
  constructor(field: string, requirement: string) {
    super(`Invalid /tracks payload: ${field} must be ${requirement}`);
    this.name = "TracksHubPayloadError";
  }
}

/** A payload number bound (bpm/year): absent stays absent; anything but a safe integer within the
    axis's deliberate bounds is rejected — a string "170" is a crafted payload, never the loader. */
function strictBoundedInt(value: unknown, field: string, bounds: IntBounds): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new TracksHubPayloadError(field, "an integer in the supported range");
  }

  return value;
}

/** A payload string axis (key/label/galaxy): absent stays absent; anything but a non-empty string is
    rejected. The direct payload must carry the already-trimmed value that `parseTracksSearch` emits;
    a second normalization step here would make the serverFn accept a shape the loader never sends. */
function strictFilterString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TracksHubPayloadError(field, "a trimmed non-empty string");
  }
  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed !== value) {
    throw new TracksHubPayloadError(field, "a trimmed non-empty string");
  }

  return value;
}

/**
 * The `/tracks` serverFn's runtime validator — PARSE, don't cast. The serverFn is an RPC endpoint a
 * crafted request can reach directly, so its payload is untrusted however the loader types it: the
 * boundary rebuilds the filter set from an explicit allowlist of the hub's axes (the same seven
 * `parseTracksSearch` whitelists), strips every unknown field (`artist`/`album`/`text` are
 * `SearchFilters`-only and must never reach `compileFilters` from here), and REJECTS a known field
 * at the wrong type rather than coercing it into a clause.
 *
 * `certified` is STRIPPED, deliberately: the web page never sets it — it is the `list_tracks` API
 * enumerator's filter, contract-validated on that surface — so this boundary offers no second,
 * uncontracted door to it.
 *
 * The parameter type is the loader's shape so in-app callers stay type-checked; the body trusts
 * none of it.
 */
export function parseTracksHubPayload(payload: { filters: TracksSearch; page: number }): {
  filters: TracksSearch;
  page: number;
} {
  const record: Record<string, unknown> =
    typeof payload === "object" && payload !== null ? { ...payload } : {};
  const rawFilters = record["filters"];

  if (typeof rawFilters !== "object" || rawFilters === null || Array.isArray(rawFilters)) {
    throw new TracksHubPayloadError("filters", "an object");
  }

  const filters = rawFilters as Record<string, unknown>;
  const page = record["page"];

  if (
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > TRACKS_HUB_MAX_PAGE
  ) {
    throw new TracksHubPayloadError("page", "an integer in the supported range");
  }

  return {
    filters: {
      bpmMax: strictBoundedInt(filters["bpmMax"], "bpmMax", BPM_BOUNDS),
      bpmMin: strictBoundedInt(filters["bpmMin"], "bpmMin", BPM_BOUNDS),
      galaxy: strictFilterString(filters["galaxy"], "galaxy"),
      key: strictFilterString(filters["key"], "key"),
      label: strictFilterString(filters["label"], "label"),
      yearMax: strictBoundedInt(filters["yearMax"], "yearMax", YEAR_BOUNDS),
      yearMin: strictBoundedInt(filters["yearMin"], "yearMin", YEAR_BOUNDS),
    },
    page,
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

  // The hub's own Satori card (routes/api/og.hub.ts), with the /log head's full image
  // shape (width/height/type + twitter:image) so every unfurler sizes it right.
  const ogImage = `${siteUrl}/api/og/hub?hub=tracks`;
  const meta = [
    { title },
    { content: description, name: "description" },
    { content: title, property: "og:title" },
    { content: description, property: "og:description" },
    { content: ogImage, property: "og:image" },
    { content: "1200", property: "og:image:width" },
    { content: "630", property: "og:image:height" },
    { content: "image/png", property: "og:image:type" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: title, name: "twitter:title" },
    { content: description, name: "twitter:description" },
    { content: ogImage, name: "twitter:image" },
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

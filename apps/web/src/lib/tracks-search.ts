// `/tracks` — the CLIENT-SAFE half of the hub: the URL filter vocabulary, the SEO head, and the key
// option list. Kept OUT of the route file (and out of the server `tracks-hub.ts`, which imports the
// DB) so it is pure, unit-testable without a router, and free of any server-only code in the client
// bundle. The route wires these into `validateSearch` / `head`; the server module owns the reads.

import {
  type TracksHubEntry,
  type TracksHubFilters,
  type TracksHubPage,
} from "./server/tracks-hub";
import { siteUrl } from "./fluncle-links";
import { jsonLdScript } from "./json-ld";
import { logPageUrl } from "./log-schema";

/** The URL-carried filter state. Mirrors `TracksHubFilters` — the same names the search box uses. */
export type TracksSearch = TracksHubFilters;

export const tracksHubTitle = "Every drum & bass track · Fluncle";
// Machine-facing (the page's <meta>/OG description), so honestly-plain third person (VOICE.md,
// Narrator): what the page is, in the nouns a stranger would search for — never a first-person take.
export const tracksHubDescription =
  "Every drum & bass track in Fluncle's archive. Filter by release year, tempo, key, and label.";

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
 * The route head. Canonical is ALWAYS the bare `/tracks` (a filtered view is the same hub, sliced),
 * and any active filter flips the page to `noindex, follow` — a crawler indexes the one hub, not the
 * combinatorial explosion of filter permutations, but still follows the links out of them. Pure so
 * the SEO contract is testable.
 */
export function tracksHead(search: TracksSearch, firstPage: TracksHubPage | undefined) {
  const canonical = `${siteUrl}/tracks`;
  const filtered = tracksSearchHasFilters(search);

  const meta = [
    { title: tracksHubTitle },
    { content: tracksHubDescription, name: "description" },
    { content: tracksHubTitle, property: "og:title" },
    { content: tracksHubDescription, property: "og:description" },
    { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: tracksHubTitle, name: "twitter:title" },
    { content: tracksHubDescription, name: "twitter:description" },
  ];

  if (filtered) {
    meta.push({ content: "noindex, follow", name: "robots" });
  }

  // The bare hub carries a `CollectionPage`/`ItemList` of its first page's LIT findings (a finding
  // resolves to its `/log` coordinate; a catalogue row is never given a fluncle URL). Filtered views
  // are noindexed, so the structured data would be noise — the bare hub only.
  const findings =
    !filtered && firstPage
      ? firstPage.entries.flatMap((entry: TracksHubEntry) =>
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
          },
          name: "Every drum & bass track in Fluncle's archive",
          url: canonical,
        }),
      ];

  return { links: [{ href: canonical, rel: "canonical" }], meta, scripts };
}

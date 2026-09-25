import { type TracksHubEntry, type TracksHubFilters } from "./server/tracks-hub";
import { siteUrl } from "./fluncle-links";
import { jsonLdScript } from "./json-ld";
import { logPageUrl } from "./log-schema";
import { textParam } from "./search-params";

export type TracksSearch = TracksHubFilters;

export const tracksHubTitle = "Every drum & bass track, newest first · Fluncle";
export const tracksHubDescription =
  "Every drum & bass track Fluncle holds, newest release first. Filter the whole list by release year, key, and label, or jump straight to a year.";

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

export function tracksMastheadLine(heldTotal: number): string {
  return heldTotal > 1
    ? `${heldCountFormatter.format(heldTotal)} drum & bass tracks, newest first.`
    : "Drum & bass tracks, newest first.";
}

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

export const TRACKS_HUB_MAX_PAGE = 10_000;

function boundedIntParam(value: unknown, bounds: IntBounds): number | undefined {
  const n = Math.trunc(Number(value));

  return Number.isSafeInteger(n) && n >= bounds.min && n <= bounds.max ? n : undefined;
}

export function parseTracksSearch(search: Record<string, unknown>): TracksSearch {
  return {
    bpmMax: boundedIntParam(search["bpmMax"], BPM_BOUNDS),
    bpmMin: boundedIntParam(search["bpmMin"], BPM_BOUNDS),
    galaxy: textParam(search["galaxy"]),
    key: textParam(search["key"]),
    label: textParam(search["label"]),
    yearMax: boundedIntParam(search["yearMax"], YEAR_BOUNDS),
    yearMin: boundedIntParam(search["yearMin"], YEAR_BOUNDS),
  };
}

class TracksHubPayloadError extends Error {
  constructor(field: string, requirement: string) {
    super(`Invalid /tracks payload: ${field} must be ${requirement}`);
    this.name = "TracksHubPayloadError";
  }
}

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

export function tracksSearchHasFilters(search: TracksSearch): boolean {
  return Object.values(search).some((value) => value !== undefined);
}

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

export type TracksHeadData = { entries: TracksHubEntry[]; page: number; total: number };

export function tracksHead(search: TracksSearch, data: TracksHeadData | undefined) {
  const filtered = tracksSearchHasFilters(search);
  const page = data?.page ?? 1;

  const canonical = filtered || page <= 1 ? `${siteUrl}/tracks` : `${siteUrl}/tracks?page=${page}`;
  const { description, title } = tracksPagedMeta(filtered ? 1 : page);

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

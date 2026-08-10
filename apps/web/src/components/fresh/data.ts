// `/fresh` — the shared shaping the variants read from.
//
// The loader (`lib/server/fresh.ts`) hands the page two recency SECTIONS (week, earlier), each split
// into lit findings and unlit catalogue rows, plus the album records. The page wants that same data
// cut two ways — a single date-sorted STREAM for the marquee treatment, and COVER lists for the album
// rail and board. This module owns those cuts so no variant re-derives them, and so the register rules
// (a finding is lit and coordinate-bearing; a catalogue row stays unlit and coverless — DESIGN.md's
// Unlit Rule) are enforced in one place.

import { albumCoverAtSize } from "@/lib/media";
import {
  type FreshCatalogueItem,
  type FreshFinding,
  type FreshRecord,
  type FreshReleases,
} from "@/lib/server/fresh";

/** The `/fresh` view the reader has picked (the `?view=` pill). `all` is the default bare-`/fresh`
    layout; `tracks` is the flat track stream on its own; `albums` centres the album records. */
export type FreshView = "albums" | "all" | "tracks";

/** One release in the merged, date-sorted stream: a lit finding OR an unlit catalogue row. */
export type FreshStreamEntry =
  | { kind: "catalogue"; releaseDate: string; track: FreshCatalogueItem }
  | { kind: "finding"; releaseDate: string; finding: FreshFinding };

/** A cover-bearing release, normalised across findings and album records for the cover-led variants.
    A catalogue row NEVER becomes one of these — it has no cover to lead with (the Unlit Rule). */
export type FreshCover = {
  artists: string[];
  coverUrl: string | undefined;
  key: string;
  releaseDate: string;
  title: string;
  /** How many tracks off the record landed in the window — set on album records only (a finding is
      one track), so the album view can print "4 tracks". */
  trackCount?: number;
} & (
  | { link: "album"; slug: string }
  | { link: "external"; href: string }
  | { link: "log"; logId: string }
);

const releaseOf = (value: string | undefined): string => value ?? "";

/** Newest release first; ties broken by title so the order is deterministic (no clock, no random). */
function byReleaseDesc(
  a: { releaseDate: string; sort: string },
  b: { releaseDate: string; sort: string },
): number {
  if (a.releaseDate !== b.releaseDate) {
    return a.releaseDate < b.releaseDate ? 1 : -1;
  }
  return a.sort < b.sort ? 1 : -1;
}

/** Every release across both sections, findings and catalogue merged, newest first. */
export function freshStream(data: FreshReleases): FreshStreamEntry[] {
  const entries: (FreshStreamEntry & { sort: string })[] = [];

  for (const section of data.sections) {
    for (const finding of section.findings) {
      entries.push({
        finding,
        kind: "finding",
        releaseDate: releaseOf(finding.releaseDate),
        sort: finding.trackId,
      });
    }
    for (const track of section.catalogue) {
      entries.push({
        kind: "catalogue",
        releaseDate: track.releaseDate,
        sort: track.trackId,
        track,
      });
    }
  }

  return entries.sort(byReleaseDesc).map(({ sort: _sort, ...entry }) => entry);
}

/** An album record as a normalised cover card — always its `/album/<slug>` page. */
function recordCover(record: FreshRecord): FreshCover {
  return {
    artists: record.artists,
    coverUrl: albumCoverAtSize(record.coverImageUrl, "medium"),
    key: `r-${record.slug}`,
    link: "album",
    releaseDate: record.releaseDate,
    slug: record.slug,
    title: record.name,
    trackCount: record.trackCount,
  };
}

/** Every album record as a cover card, newest first — the FULL album cut (up to 90 days back), the
    "Albums & EPs" view's central grid. */
export function freshRecordCovers(data: FreshReleases): FreshCover[] {
  return data.records.map(recordCover);
}

/** The album records inside the narrower TRACK window (today's 30-day cut) — the "All" view's rail,
    so the default page keeps its existing layout while the album view reaches further back. */
export function freshTrackWindowRecordCovers(data: FreshReleases): FreshCover[] {
  return data.records.filter((record) => record.withinTrackWindow).map(recordCover);
}

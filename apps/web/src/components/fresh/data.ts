// `/fresh` — the shared shaping the variants read from.
//
// The loader (`lib/server/fresh.ts`) hands the page two recency SECTIONS (week, earlier), each split
// into lit findings and unlit catalogue rows, plus the album records. The design variants want that
// same data cut a few different ways — a single date-sorted STREAM for the timeline/console/marquee
// treatments, a COVER list for the wall, day GROUPS for the spine. This module owns those cuts so no
// variant re-derives them, and so the register rules (a finding is lit and coordinate-bearing; a
// catalogue row stays unlit and coverless — DESIGN.md's Unlit Rule) are enforced in one place.

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

/** A day's worth of releases, for the timeline spine. */
export type FreshDay = { entries: FreshStreamEntry[]; releaseDate: string };

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

/** How many releases landed in each bucket — the honest counts the console/dispatch headers print. */
export type FreshCounts = { albums: number; earlier: number; week: number };

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

/** The stream folded into day groups (already newest-first), for the timeline spine. */
export function freshDays(stream: FreshStreamEntry[]): FreshDay[] {
  const days: FreshDay[] = [];
  for (const entry of stream) {
    const last = days.at(-1);
    if (last && last.releaseDate === entry.releaseDate) {
      last.entries.push(entry);
    } else {
      days.push({ entries: [entry], releaseDate: entry.releaseDate });
    }
  }
  return days;
}

/** A finding as a normalised cover card — its log page when it has a coordinate, else its Spotify. */
function findingCover(finding: FreshFinding): FreshCover {
  const title = `${finding.artists.join(", ")} — ${finding.title}`;
  const base = {
    artists: finding.artists,
    coverUrl: albumCoverAtSize(finding.albumImageUrl, "medium"),
    releaseDate: releaseOf(finding.releaseDate),
    title,
  };
  return finding.logId
    ? { ...base, key: `f-${finding.trackId}`, link: "log", logId: finding.logId }
    : { ...base, href: finding.spotifyUrl, key: `f-${finding.trackId}`, link: "external" };
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

/** The lit findings across both sections as cover cards, newest first (the cover-wall grid). */
export function freshFindingCovers(data: FreshReleases): FreshCover[] {
  return data.sections
    .flatMap((section) => section.findings.map(findingCover))
    .sort((a, b) => byReleaseDesc({ ...a, sort: a.key }, { ...b, sort: b.key }));
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

/** The single newest cover-bearing release overall — the hero. A finding leads a record on a tie. */
export function freshHero(data: FreshReleases): FreshCover | undefined {
  const findings = freshFindingCovers(data);
  const records = freshRecordCovers(data);
  const candidates = [...findings, ...records].filter((cover) => cover.coverUrl);
  return candidates.sort((a, b) => byReleaseDesc({ ...a, sort: a.key }, { ...b, sort: b.key }))[0];
}

/** The per-bucket counts the data-dense headers print. */
export function freshCounts(data: FreshReleases): FreshCounts {
  const sizeOf = (key: "earlier" | "week"): number => {
    const section = data.sections.find((candidate) => candidate.key === key);
    return section ? section.findings.length + section.catalogue.length : 0;
  };
  return { albums: data.records.length, earlier: sizeOf("earlier"), week: sizeOf("week") };
}

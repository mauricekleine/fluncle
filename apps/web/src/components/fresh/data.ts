import { albumCoverAtSize } from "@/lib/media";
import {
  type FreshCatalogueItem,
  type FreshFinding,
  type FreshRecord,
  type FreshReleases,
} from "@/lib/server/fresh";

export type FreshView = "albums" | "all" | "tracks";

export type FreshStreamEntry =
  | { kind: "catalogue"; releaseDate: string; track: FreshCatalogueItem }
  | { kind: "finding"; releaseDate: string; finding: FreshFinding };

export type FreshCover = {
  artists: string[];
  coverUrl: string | undefined;
  key: string;
  releaseDate: string;
  title: string;

  trackCount?: number;
} & (
  | { link: "album"; slug: string }
  | { link: "external"; href: string }
  | { link: "log"; logId: string }
);

const releaseOf = (value: string | undefined): string => value ?? "";

function byReleaseDesc(
  a: { releaseDate: string; sort: string },
  b: { releaseDate: string; sort: string },
): number {
  if (a.releaseDate !== b.releaseDate) {
    return a.releaseDate < b.releaseDate ? 1 : -1;
  }
  return a.sort < b.sort ? 1 : -1;
}

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

export function freshRecordCovers(data: FreshReleases): FreshCover[] {
  return data.records.map(recordCover);
}

export function freshTrackWindowRecordCovers(data: FreshReleases): FreshCover[] {
  return data.records.filter((record) => record.withinTrackWindow).map(recordCover);
}

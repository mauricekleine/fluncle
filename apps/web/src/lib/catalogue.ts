import { type CatalogueTrackItem, type TrackListItem } from "./server/tracks";

export const CATALOGUE_SORTS = ["name", "recent"] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

export const CATALOGUE_SORT_DEFAULT: CatalogueSort = "name";

export function parseCatalogueSort(value: unknown): CatalogueSort {
  return CATALOGUE_SORTS.includes(value as CatalogueSort)
    ? (value as CatalogueSort)
    : CATALOGUE_SORT_DEFAULT;
}

export function catalogueSortParam(value: unknown): CatalogueSort | undefined {
  return CATALOGUE_SORTS.includes(value as CatalogueSort) ? (value as CatalogueSort) : undefined;
}

export const GRAPH_GROUP_PAGE_SIZE = 12;

export function cataloguePageHref(
  base: string,
  page: number,
  sort: CatalogueSort,
  defaultSort: CatalogueSort,
): string {
  const params = new URLSearchParams();
  if (sort !== defaultSort) {
    params.set("sort", sort);
  }
  if (page > 1) {
    params.set("page", String(page));
  }
  const query = params.toString();

  return query ? `${base}?${query}` : base;
}

export function entityPageHref(
  base: string,
  page: number,
  sort: CatalogueSort,
  defaultSort: CatalogueSort,
  upcomingPage: number,
): string {
  const href = cataloguePageHref(base, page, sort, defaultSort);
  if (upcomingPage <= 1) {
    return href;
  }
  return `${href}${href.includes("?") ? "&" : "?"}upcomingPage=${upcomingPage}`;
}

export const GRAPH_GROUP_TRACK_LIMIT = 20;

export const GRAPH_GROUP_ROW_CEILING = GRAPH_GROUP_PAGE_SIZE * GRAPH_GROUP_TRACK_LIMIT;

export type UpcomingTrackPage = {
  findings: TrackListItem[];
  page: number;
  pageCount: number;
  total: number;
  tracks: CatalogueTrackItem[];
};

export type CatalogueRecord = {
  name: string | undefined;

  releaseDate: string | undefined;

  slug: string | undefined;
  tracks: CatalogueTrackItem[];
};

export type CatalogueArtistGroup = {
  name: string;

  recordCount: number;

  records: CatalogueRecord[];

  slug: string | undefined;

  truncated: boolean;
};

export type CatalogueGroupPage<TGroup> = {
  groups: TGroup[];
  page: number;
  pageCount: number;

  totalGroups: number;

  totalTracks: number;
};

export class CataloguePageOutOfRangeError extends Error {}

export function flattenRecords(records: CatalogueRecord[]): CatalogueTrackItem[] {
  return records.flatMap((record) => record.tracks);
}

export function flattenArtistGroups(groups: CatalogueArtistGroup[]): CatalogueTrackItem[] {
  return groups.flatMap((group) => flattenRecords(group.records));
}

export function pageNumbers(page: number, pageCount: number, span = 2): number[] {
  const first = Math.max(1, Math.min(page - span, pageCount - span * 2));
  const last = Math.min(pageCount, Math.max(page + span, span * 2 + 1));
  const window: number[] = [];

  for (let n = first; n <= last; n++) {
    window.push(n);
  }

  return window;
}

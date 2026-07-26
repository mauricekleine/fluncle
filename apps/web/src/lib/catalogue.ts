// The CLIENT-SAFE half of the catalogue-groups module: the sort vocabulary, the page bounds,
// the group SHAPES the pages render, and the two pure helpers a component needs. Everything
// here is arithmetic and constants — no database, no `getDb`, nothing from `lib/server/**`
// except erased types.
//
// WHY IT IS ITS OWN FILE. `components/catalogue-groups.tsx` renders on the client and needs
// `pageNumbers` + the group types; importing them from `lib/server/catalogue-groups.ts` made
// that server module reachable from the browser graph, and it carries `getDb` → `db.ts` →
// `@libsql/client` + `drizzle-orm` + the whole `db/schema.ts`. Measured on the built client
// bundle, that chain — reached from here and from four route files — was ~232 KB of rendered
// server-only modules sitting in the EAGER entry chunk every page downloads before first paint
// (docs/client-bundle.md). A pure module the client may import breaks it at its first link.
//
// `lib/server/catalogue-groups.ts` re-exports all of it, so every server caller and test keeps
// importing from the same place it always did; the SQL and the reads stay there.

import { type CatalogueTrackItem } from "./server/tracks";

/** How the reader may order the groups. */
export const CATALOGUE_SORTS = ["name", "recent"] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

/**
 * A–Z is the default, and the reason is the PAGER rather than taste.
 *
 * The flat read defaulted to newest-first, on the argument that "an A–Z list truncated at 100
 * stops at C, which is an arbitrary page". That argument dies the moment there is a pager:
 * stopping at C is page 1 of 11, and every other page is one click away. What matters instead
 * is STABILITY — a date-ordered paginated list RESHUFFLES every time the crawl brings a newer
 * release in, so a crawler walking pages 1…11 over an afternoon sees some groups twice and
 * others never. Alphabetical order does not move when the catalogue grows.
 */
export const CATALOGUE_SORT_DEFAULT: CatalogueSort = "name";

export function parseCatalogueSort(value: unknown): CatalogueSort {
  return CATALOGUE_SORTS.includes(value as CatalogueSort)
    ? (value as CatalogueSort)
    : CATALOGUE_SORT_DEFAULT;
}

/** Groups rendered per page. The pager carries the rest; nothing is unreachable. */
export const GRAPH_GROUP_PAGE_SIZE = 12;

/**
 * The most rows any ONE group may contribute. Capped in SQL with a `row_number()` window, so
 * one prolific artist cannot blow the page's budget. A group that hits it says so and links to
 * its own page, which carries the rest.
 */
export const GRAPH_GROUP_TRACK_LIMIT = 20;

/**
 * The page's hard row ceiling, BY CONSTRUCTION — `pageSize × trackLimit`. This is the number
 * that replaces the flat read's 100-row cap as the thing standing between a crawled label and
 * a 4 MB dump, and `catalogue-scale.integration.test.ts` asserts a real page never exceeds it.
 */
export const GRAPH_GROUP_ROW_CEILING = GRAPH_GROUP_PAGE_SIZE * GRAPH_GROUP_TRACK_LIMIT;

/** One record (album / EP / single) and the uncertified tracks on it that the page renders. */
export type CatalogueRecord = {
  /**
   * The record's name — UNDEFINED for the nameless bucket (tracks whose record we do not know).
   * The caller renders that one with no heading at all: a heading over a homogeneous block of
   * uncertified rows would be naming the tier, and the tier has no name.
   */
  name: string | undefined;
  /** The newest known release date on the record, or undefined when nothing on it is dated. */
  releaseDate: string | undefined;
  /** `/album/<slug>` — only when the record carries an album entity (a finding minted it). */
  slug: string | undefined;
  tracks: CatalogueTrackItem[];
};

/** One artist section on a label page: their records on THIS label. */
export type CatalogueArtistGroup = {
  name: string;
  /** How many of their records this label carries — counted in SQL over the WHOLE group. */
  recordCount: number;
  /** The records the page renders. Capped; `truncated` says when the group carries more. */
  records: CatalogueRecord[];
  /** `/artist/<slug>` — only when Fluncle has certified this artist (an entity exists). */
  slug: string | undefined;
  /** True when the group carries more tracks than {@link GRAPH_GROUP_TRACK_LIMIT}. */
  truncated: boolean;
};

export type CatalogueGroupPage<TGroup> = {
  groups: TGroup[];
  page: number;
  pageCount: number;
  /** Every group the entity carries, counted in SQL — what the pager keys off. */
  totalGroups: number;
  /** Every uncertified track the entity carries, counted in SQL. Drives the thin-content gate. */
  totalTracks: number;
};

/**
 * A page past the end of the pager does not exist, and says so. It is not clamped back to
 * page 1: a `?page=99` that quietly served page 1 would be a second URL for the same content,
 * and an infinite supply of them for a crawler to chew through.
 */
export class CataloguePageOutOfRangeError extends Error {}

/** Every rendered row on a grouped page, flattened — what the JSON-LD describes. */
export function flattenRecords(records: CatalogueRecord[]): CatalogueTrackItem[] {
  return records.flatMap((record) => record.tracks);
}

export function flattenArtistGroups(groups: CatalogueArtistGroup[]): CatalogueTrackItem[] {
  return groups.flatMap((group) => flattenRecords(group.records));
}

/**
 * A window of page numbers around the current one, so a 40-page label does not render 40 links.
 * Pure (no React), so it lives here beside the other pure helpers and the component imports it —
 * `catalogue-groups.test.ts` pins the window at both ends.
 */
export function pageNumbers(page: number, pageCount: number, span = 2): number[] {
  const first = Math.max(1, Math.min(page - span, pageCount - span * 2));
  const last = Math.min(pageCount, Math.max(page + span, span * 2 + 1));
  const window: number[] = [];

  for (let n = first; n <= last; n++) {
    window.push(n);
  }

  return window;
}

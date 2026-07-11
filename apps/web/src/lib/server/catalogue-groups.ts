// THE GRAPH PAGES, GROUPED — and the bound that survives the crawl.
//
// A crawled label is not a list, it is a discography. Medschool alone came back from the
// crawler pilot with 735 tracks; Hospital will be several times that, and there are 27
// enabled seed labels behind it. Rendered flat, a page like that is not a page, it is a dump.
// So the quieter rows are GROUPED: an artist page groups them by record, a label page groups
// them by artist and then by record inside each one.
//
// ── GROUPING DOES NOT REMOVE THE BOUND, IT MOVES IT ────────────────────────────────────
// The flat read was capped at 100 rows for a reason: uncapped, `/label/hospital-records`
// served 4.34 MB of HTML on a 10,800-row synthetic catalogue. Grouping does not fix that — a
// label with 200 artists cannot render every artist's every record either. It only changes
// WHERE the bound has to go.
//
// It goes in three places, and all three are enforced in SQL:
//
//   1. A PAGE OF GROUPS. The page renders at most `GRAPH_GROUP_PAGE_SIZE` groups, ordered and
//      windowed by SQL's own `limit`/`offset`, with the true group total counted by
//      `count(*) over ()` and a crawlable `?page=N` pager for the rest. A cap becomes a PAGE
//      SIZE, and nothing is unreachable — which is the answer to the obvious objection that
//      "the top N artists" is an arbitrary slice. Page 4 of 11 is not arbitrary.
//
//   2. A CAP INSIDE EACH GROUP. `row_number() over (partition by …)` caps what any one group
//      may contribute, so the page's row count is bounded BY CONSTRUCTION at
//      `GRAPH_GROUP_PAGE_SIZE × GRAPH_GROUP_TRACK_LIMIT`, no matter how prolific one artist
//      is. A group that hits its cap says so and points at its own page, which carries the
//      rest — the drill-down target already exists (`/artist/<slug>`, `/album/<slug>`).
//
//   3. NOTHING UNBOUNDED CROSSES THE WIRE. Every read here is an indexed seek
//      (`tracks.label_id`, `track_artists.artist_id`), aggregates and ranks in SQL, and never
//      hands the isolate a row it will not render. The only folding the ISOLATE does is over
//      a set already bounded to ≤ `GRAPH_GROUP_ROW_CEILING` rows — which is the line
//      AGENTS.md draws: fold a few hundred rows in TypeScript, never 30,000.
//
// ── WHY THE COLLAPSED CONTENT IS STILL IN THE HTML ────────────────────────────────────
// The groups render collapsed, and it is tempting to think "collapsed" is itself the bound —
// fetch a group's tracks when the reader expands it. It is not, and that design would throw
// away the entire point of having crawled the catalogue: content fetched on expand is not
// reliably indexed, and these pages exist to BE indexed. So every rendered row is in the
// server-rendered HTML; the panel collapses with `hidden="until-found"`, which keeps it in the
// DOM, findable by the browser's own find-in-page, and readable by a crawler. Collapsing
// bounds ATTENTION; only a limit bounds BYTES. This file is the limit.
//
// ── WHAT THE CRAWLER ACTUALLY GIVES US TO GROUP BY ────────────────────────────────────
// A crawled track carries its release title in the RAW `tracks.album` string and its artist
// names in `artists_json`. It does NOT carry an `album_id`: an `albums` row is minted only off
// a certified finding (docs/album-entity.md), so most crawled tracks point at no album entity
// at all. So the record grouping keys on the RAW STRING, folded case-insensitively, and a
// group links to `/album/<slug>` only when that record happens to have an entity. A heading
// here names a REAL RECORD either way — never the tier the rows belong to, which has no public
// name and never will (DESIGN.md's Unlit Rule).
//
// The artist side is the opposite, and it is why `linkTracksToArtistEntities` exists: the
// LABEL page can group by `json_each(artists_json)` because its `tracks.label_id` seek has
// already bounded the scan to one label, but the ARTIST page has no such bound — finding an
// artist's tracks through `artists_json` would be a full scan of a table that grows without
// limit, which is exactly the shape AGENTS.md forbids. So a crawled track is LINKED into
// `track_artists` (mint the entity only off a finding, then link every track — the same rule
// `album_id`/`label_id` already follow), and the artist page reads through that indexed edge.
//
// ── WHERE AN UNDATED ROW SORTS, AND WHY IT NEVER VANISHES ─────────────────────────────
// `tracks.release_date` is NULLABLE, and plenty of crawled rows have no date. SQLite sorts
// NULL as the SMALLEST value, so a bare `release_date desc` floats every undated row to the
// TOP of the page — the loudest possible position for the least certain data. So every sort
// here leads with `release_date is null asc`: UNDATED SORTS LAST, under both directions, and
// then falls back to A–Z. It is never filtered, so it can never silently disappear.
//
// The same rule covers a track with no record at all (`tracks.album` NULL). Those fold into
// ONE nameless group, forced last under every sort, rendered with NO HEADING — bare unlit
// rows, exactly as the flat list always did. There is no honest name for a bucket of tracks
// whose record we do not know, so it is given none.

import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { type CatalogueTrackItem } from "./tracks";

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

type GroupRow = {
  group_key: string;
  name: string;
  record_count: number;
  release_date: string | null;
  slug: string | null;
  total_groups: number;
  total_tracks: number;
  track_count: number;
};

type GroupTrackRow = {
  album: string | null;
  album_slug: string | null;
  artists_json: string;
  group_key: string;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

/**
 * The group ORDER, in SQL. Both sorts force the nameless bucket last, and both put undated
 * groups after dated ones — a group's date is the NEWEST release on it, so an artist whose
 * every release is undated sorts to the back rather than (as SQLite would have it) the front.
 * Ordering by the SELECT's own aliases, which SQLite resolves after grouping.
 */
function groupOrderSql(sort: CatalogueSort): string {
  const namelessLast = `(group_key = '') asc`;

  return sort === "recent"
    ? `${namelessLast}, (release_date is null) asc, release_date desc, name collate nocase asc`
    : `${namelessLast}, name collate nocase asc`;
}

/** The order WITHIN a group — the same rule, so a truncated group drops its tail, not its head. */
function trackOrderSql(sort: CatalogueSort): string {
  const namelessRecordLast = `(tracks.album is null) asc`;

  return sort === "recent"
    ? `${namelessRecordLast}, (tracks.release_date is null) asc, tracks.release_date desc,
       tracks.album collate nocase asc, tracks.title collate nocase asc`
    : `${namelessRecordLast}, tracks.album collate nocase asc,
       (tracks.release_date is null) asc, tracks.release_date asc, tracks.title collate nocase asc`;
}

function toTrack(row: GroupTrackRow): CatalogueTrackItem {
  return {
    artists: parseArtistsJson(row.artists_json),
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

/**
 * A page past the end of the pager does not exist, and says so. It is not clamped back to
 * page 1: a `?page=99` that quietly served page 1 would be a second URL for the same content,
 * and an infinite supply of them for a crawler to chew through.
 */
export class CataloguePageOutOfRangeError extends Error {}

const EMPTY = { groups: [], page: 1, pageCount: 1, totalGroups: 0 };

// ── THE ARTIST PAGE: the rest of an artist, grouped by record ───────────────────────────

/**
 * An artist's uncertified tracks, grouped into their records. Reads through the indexed
 * `track_artists.artist_id` edge (which `linkTracksToArtistEntities` now stamps on crawled
 * tracks too) and anti-joins `findings`, so it can only ever return the quieter rows.
 */
export async function listArtistCatalogue(
  artistId: string,
  sort: CatalogueSort,
  page: number,
): Promise<CatalogueGroupPage<CatalogueRecord>> {
  const db = await getDb();

  // The record groups, ordered + windowed in SQL. `count(*) over ()` runs AFTER `group by`, so
  // it counts GROUPS; `sum(count(*)) over ()` totals the tracks across every group. One round
  // trip brings back the page, the group total AND the honest track total, and the groups past
  // the window never cross the wire.
  const result = await db.execute({
    args: [artistId, GRAPH_GROUP_PAGE_SIZE, (page - 1) * GRAPH_GROUP_PAGE_SIZE],
    sql: `select lower(coalesce(tracks.album, '')) as group_key,
                 coalesce(min(tracks.album), '') as name,
                 min(al.slug) as slug,
                 max(tracks.release_date) as release_date,
                 count(*) as track_count,
                 1 as record_count,
                 count(*) over () as total_groups,
                 sum(count(*)) over () as total_tracks
          from tracks
          join track_artists ta on ta.track_id = tracks.track_id
          left join findings on findings.track_id = tracks.track_id
          left join albums al on al.id = tracks.album_id
          where ta.artist_id = ? and findings.track_id is null
          group by lower(coalesce(tracks.album, ''))
          order by ${groupOrderSql(sort)}
          limit ? offset ?`,
  });

  const rows = typedRows<GroupRow>(result.rows);

  if (rows.length === 0) {
    if (page > 1) {
      throw new CataloguePageOutOfRangeError();
    }

    return { ...EMPTY, totalTracks: 0 };
  }

  const totalGroups = Number(rows[0]?.total_groups ?? 0);
  const tracks = await fetchGroupTracks(
    `join track_artists ta on ta.track_id = tracks.track_id`,
    `ta.artist_id = ?`,
    artistId,
    `lower(coalesce(tracks.album, ''))`,
    rows.map((row) => row.group_key),
    sort,
  );
  const byRecord = groupBy(tracks, (row) => row.group_key);

  return {
    groups: rows.map((row) => ({
      name: row.name === "" ? undefined : row.name,
      releaseDate: row.release_date ?? undefined,
      slug: row.slug ?? undefined,
      tracks: (byRecord.get(row.group_key) ?? []).map(toTrack),
    })),
    page,
    pageCount: Math.max(Math.ceil(totalGroups / GRAPH_GROUP_PAGE_SIZE), 1),
    totalGroups,
    totalTracks: Number(rows[0]?.total_tracks ?? 0),
  };
}

// ── THE LABEL PAGE: the rest of a label, grouped by artist, then by record ──────────────

/**
 * A label's uncertified tracks, grouped by ARTIST and then by record inside each artist.
 *
 * Groups on `json_each(artists_json)` rather than the `track_artists` edge, and that is
 * deliberate: a crawl-only artist Fluncle has never certified has NO artist entity (an entity
 * is minted only off a finding), so a `track_artists` grouping would silently DROP every one of
 * their tracks from the label's page. Their name is on the track; the page uses it, and the
 * group simply has no `/artist/<slug>` to link to. Nothing vanishes.
 *
 * The `json_each` explosion is safe here because `tracks.label_id` is indexed: the scan is
 * bounded to ONE label's rows before the JSON is ever touched, and the aggregation happens
 * inside SQLite, never in the isolate.
 */
export async function listLabelCatalogue(
  labelId: string,
  sort: CatalogueSort,
  page: number,
): Promise<CatalogueGroupPage<CatalogueArtistGroup>> {
  const db = await getDb();

  // The label's TRUE uncertified total, counted over TRACKS — never over the exploded credits
  // below (a two-artist track is two credit rows and one track). The thin-content gate keys off
  // this number, so it has to be the honest one.
  const totals = await db.execute({
    args: [labelId],
    sql: `select count(*) as total_tracks
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.label_id = ? and findings.track_id is null`,
  });
  const totalTracks = Number(
    typedRows<{ total_tracks: number }>(totals.rows)[0]?.total_tracks ?? 0,
  );

  const result = await db.execute({
    args: [labelId, GRAPH_GROUP_PAGE_SIZE, (page - 1) * GRAPH_GROUP_PAGE_SIZE],
    sql: `select lower(credit.value) as group_key,
                 min(credit.value) as name,
                 min(a.slug) as slug,
                 max(tracks.release_date) as release_date,
                 count(*) as track_count,
                 count(distinct lower(coalesce(tracks.album, ''))) as record_count,
                 count(*) over () as total_groups,
                 0 as total_tracks
          from tracks
          left join findings on findings.track_id = tracks.track_id
          join json_each(tracks.artists_json) credit
          left join artists a on a.name = credit.value collate nocase
          where tracks.label_id = ? and findings.track_id is null
          group by lower(credit.value)
          order by ${groupOrderSql(sort)}
          limit ? offset ?`,
  });

  const rows = typedRows<GroupRow>(result.rows);

  if (rows.length === 0) {
    if (page > 1) {
      throw new CataloguePageOutOfRangeError();
    }

    return { ...EMPTY, totalTracks };
  }

  const totalGroups = Number(rows[0]?.total_groups ?? 0);
  const tracks = await fetchGroupTracks(
    `join json_each(tracks.artists_json) credit`,
    `tracks.label_id = ?`,
    labelId,
    `lower(credit.value)`,
    rows.map((row) => row.group_key),
    sort,
  );
  const byArtist = groupBy(tracks, (row) => row.group_key);

  return {
    groups: rows.map((row) => {
      const held = byArtist.get(row.group_key) ?? [];

      return {
        name: row.name,
        recordCount: Number(row.record_count),
        records: intoRecords(held),
        slug: row.slug ?? undefined,
        truncated: Number(row.track_count) > held.length,
      };
    }),
    page,
    pageCount: Math.max(Math.ceil(totalGroups / GRAPH_GROUP_PAGE_SIZE), 1),
    totalGroups,
    totalTracks,
  };
}

// ── The shared machinery ────────────────────────────────────────────────────────────────

/**
 * The one read that could grow without bound, and so the one that is capped hardest:
 * `row_number() over (partition by …)` caps EVERY group at {@link GRAPH_GROUP_TRACK_LIMIT} rows
 * INSIDE SQLite, so the wire carries at most `GRAPH_GROUP_ROW_CEILING` rows however prolific one
 * artist is. The `join`/`where`/key fragments are CONSTANTS from the two callers above (never
 * reader input); every value is bound.
 */
async function fetchGroupTracks(
  joinSql: string,
  whereSql: string,
  entityId: string,
  keySql: string,
  keys: string[],
  sort: CatalogueSort,
): Promise<GroupTrackRow[]> {
  if (keys.length === 0) {
    return [];
  }

  const db = await getDb();
  const placeholders = keys.map(() => "?").join(", ");
  const result = await db.execute({
    args: [entityId, ...keys, GRAPH_GROUP_TRACK_LIMIT],
    sql: `select track_id, title, artists_json, spotify_url, album, album_slug, release_date,
                 group_key
          from (
            select tracks.track_id as track_id, tracks.title as title,
                   tracks.artists_json as artists_json, tracks.spotify_url as spotify_url,
                   tracks.album as album, al.slug as album_slug,
                   tracks.release_date as release_date,
                   ${keySql} as group_key,
                   row_number() over (
                     partition by ${keySql}
                     order by ${trackOrderSql(sort)}
                   ) as rn
            from tracks
            ${joinSql}
            left join findings on findings.track_id = tracks.track_id
            left join albums al on al.id = tracks.album_id
            where ${whereSql} and findings.track_id is null and ${keySql} in (${placeholders})
          )
          where rn <= ?`,
  });

  return typedRows<GroupTrackRow>(result.rows);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();

  for (const row of rows) {
    const held = map.get(key(row));

    if (held) {
      held.push(row);
    } else {
      map.set(key(row), [row]);
    }
  }

  return map;
}

/** Split one artist's rows (already ordered by SQL) into their records, order preserved. */
function intoRecords(rows: GroupTrackRow[]): CatalogueRecord[] {
  const records: CatalogueRecord[] = [];
  const index = new Map<string, CatalogueRecord>();

  for (const row of rows) {
    const key = (row.album ?? "").toLowerCase();
    const held = index.get(key);

    if (held) {
      held.tracks.push(toTrack(row));
      continue;
    }

    const record: CatalogueRecord = {
      name: row.album ?? undefined,
      releaseDate: row.release_date ?? undefined,
      slug: row.album_slug ?? undefined,
      tracks: [toTrack(row)],
    };

    index.set(key, record);
    records.push(record);
  }

  return records;
}

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

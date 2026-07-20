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
// names in `artists_json`, and now an `album_id` too — the catalogue crawler mints + links the
// album entity inline (folded on the release group, docs/album-entity.md). The record grouping
// keys on the RAW STRING, folded case-insensitively. A group links to `/album/<slug>` whenever
// that record has an album entity (a `tracks.album_id` pointer): a crawl-minted, findings-free
// record has a public page now — a tracklist bounded by the thin-content floor, exactly as a
// discovered label does — so the heading is a live link, never a plain-text stub. A record with no
// album entity (the nameless bucket) still renders as plain text. A heading here names a REAL
// RECORD either way — never the tier the rows belong to (DESIGN.md's Unlit Rule).
//
// The artist side needs the same indexed edge: the LABEL page can group by
// `json_each(artists_json)` because its `tracks.label_id` seek has already bounded the scan to one
// label, but the ARTIST page has no such bound — finding an artist's tracks through `artists_json`
// would be a full scan of a table that grows without limit, which is exactly the shape AGENTS.md
// forbids. So a crawled track is LINKED into `track_artists` two ways: the crawler connect-or-creates
// the artist by its stable `spotify_artist_id` at the Spotify-anchor step (minting the entity), and
// the name-fold `linkTracksToArtistEntities` remains the fallback for a track with no Spotify
// presence (link only, never mint). The artist page reads through that indexed edge, and a group
// links to `/artist/<slug>` whenever the artist has an entity — a crawl-minted, findings-free artist
// has a public catalogue page too. A credited name with no entity at all renders as plain text.
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
//
// ── ONE STATEMENT, ONE WALK ────────────────────────────────────────────────────────────
// Both reads used to arrive in WAVES: the artist page ran a `group by` for the page of groups
// and then a second statement for those groups' tracks; the label page ran three (a total, the
// groups, the tracks). Every one of those waves is a Worker→Turso→Ireland round trip, and
// `explain query plan` showed each wave repeating the SAME indexed walk of the entity's rows
// (`track_artists_artist_id_idx` / `tracks_label_id_idx`) — the group-key filter on the second
// wave is `lower(coalesce(album, ''))`, an expression no index can seek, so it never bounded
// anything. Two waves, twice the walk, and the artist page's cost tracked discography size.
//
// So both reads are now ONE statement that walks the entity's rows ONCE. The group aggregates
// that the `group by` used to produce come from WINDOWS over that single walk instead
// (`min(…) over (partition by group_key)`), the page of groups is cut by `dense_rank()` over
// the same group order rather than `limit`/`offset`, and the per-group cap stays exactly where
// it was — a `row_number()` partition, applied in the same `where` as the group window. The
// caps, the order, the totals and the pager are unchanged; the wire carries the same ≤
// `GRAPH_GROUP_ROW_CEILING` rows. What changed is that it takes one trip to Ireland, not two.
//
// Nothing is materialised into a temp table on the way: each CTE level is referenced exactly
// once, so there is no CTE-flattening re-execution to guard against and no copy of a growing
// row set into temp storage (the trap docs/local-database.md records).

import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { dedupeByRecordingIdentity, type RecordingIdentity } from "./track-match";
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

type GroupTrackRow = {
  album: string | null;
  album_slug: string | null;
  artists_json: string;
  group_key: string;
  isrc: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

/**
 * One rendered row, carrying its GROUP's aggregates alongside its own columns — the shape the
 * single-statement read returns. The group columns repeat down every row of a group (a window
 * produced them, not a `group by`), which is what lets one statement answer both questions.
 */
type GroupedTrackRow = GroupTrackRow & {
  /** The group's rendered name — `''` for the artist page's nameless bucket. */
  group_name: string;
  /** The newest release on the whole group — the group's sort key and rendered date. */
  group_release_date: string | null;
  /** `/album/<slug>` or `/artist/<slug>` for the group's heading, when an entity exists. */
  group_slug: string | null;
  /** How many records the WHOLE group carries (the label page's `recordCount`). */
  record_count: number;
  /** Every group the entity carries, counted over the whole walk. */
  total_groups: number;
  /** Every uncertified track the entity carries, counted over the whole walk. */
  total_tracks: number;
  /** How many rows the WHOLE group carries, before the per-group cap. */
  track_count: number;
};

/** The recording identity a loaded catalogue row exposes to the render-time dedupe fold. */
function groupRowIdentity(row: GroupTrackRow): RecordingIdentity {
  return {
    artists: parseArtistsJson(row.artists_json),
    isrc: row.isrc,
    releaseDate: row.release_date,
    spotifyUrl: row.spotify_url,
    title: row.title,
    trackId: row.track_id,
  };
}

/**
 * The group ORDER, in SQL. Both sorts force the nameless bucket last, and both put undated
 * groups after dated ones — a group's date is the NEWEST release on it, so an artist whose
 * every release is undated sorts to the back rather than (as SQLite would have it) the front.
 *
 * It reads the group's WINDOWED aggregates (`group_name` / `group_release_date`), which repeat
 * down every row of the group, so the same expression that once ordered a `group by` result now
 * ranks the rows of one walk.
 */
function groupOrderSql(sort: CatalogueSort): string {
  const namelessLast = `(group_key = '') asc`;

  return sort === "recent"
    ? `${namelessLast}, (group_release_date is null) asc, group_release_date desc,
       group_name collate nocase asc`
    : `${namelessLast}, group_name collate nocase asc`;
}

/**
 * The group order with a STRICT tiebreaker, for the `dense_rank()` that cuts the page.
 *
 * A rank is what pagination keys off, so two different groups must never share one: `group_key`
 * is the group's identity, so appending it makes the order total. It can only ever break an
 * exact tie — a pair the old `limit`/`offset` ordered arbitrarily — so the page a reader sees is
 * unchanged and the pager is now stable across requests, which is the whole point of A–Z.
 */
function groupRankOrderSql(sort: CatalogueSort): string {
  return `${groupOrderSql(sort)}, group_key asc`;
}

/**
 * The order WITHIN a group — the same rule, so a truncated group drops its tail, not its head.
 * `prefix` qualifies the track's own columns, which live on the walk's CTE rather than on
 * `tracks` once the read is one statement.
 */
function trackOrderSql(sort: CatalogueSort, prefix: string): string {
  const namelessRecordLast = `(${prefix}album is null) asc`;

  return sort === "recent"
    ? `${namelessRecordLast}, (${prefix}release_date is null) asc, ${prefix}release_date desc,
       ${prefix}album collate nocase asc, ${prefix}title collate nocase asc`
    : `${namelessRecordLast}, ${prefix}album collate nocase asc,
       (${prefix}release_date is null) asc, ${prefix}release_date asc,
       ${prefix}title collate nocase asc`;
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
  const offset = (page - 1) * GRAPH_GROUP_PAGE_SIZE;

  // ONE walk of the artist's rows, through the indexed `track_artists.artist_id` seek. `base`
  // is that walk; `ranked` hangs the record's aggregates off it as windows and caps each record
  // at `GRAPH_GROUP_TRACK_LIMIT` rows; `paged` ranks the records in the reader's order; and
  // `counted` reads the record total off that rank. The final `where` is where both bounds land
  // at once — the page of records AND the per-record cap — so nothing past either crosses the
  // wire. `count(*) over ()` in `ranked` runs over the walk, so it is the honest TRACK total.
  const result = await db.execute({
    args: [artistId, GRAPH_GROUP_TRACK_LIMIT, offset, offset + GRAPH_GROUP_PAGE_SIZE],
    sql: `with base as (
            select tracks.track_id as track_id, tracks.title as title,
                   tracks.artists_json as artists_json, tracks.spotify_url as spotify_url,
                   tracks.isrc as isrc, tracks.album as album, al.slug as album_slug,
                   tracks.release_date as release_date,
                   lower(coalesce(tracks.album, '')) as group_key
            from tracks
            join track_artists ta on ta.track_id = tracks.track_id
            left join findings on findings.track_id = tracks.track_id
            left join albums al on al.id = tracks.album_id
            where ta.artist_id = ? and findings.track_id is null
                  and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null
          ),
          ranked as (
            select base.*,
                   coalesce(min(base.album) over (partition by base.group_key), '') as group_name,
                   min(base.album_slug) over (partition by base.group_key) as group_slug,
                   max(base.release_date) over (partition by base.group_key)
                     as group_release_date,
                   count(*) over (partition by base.group_key) as track_count,
                   1 as record_count,
                   count(*) over () as total_tracks,
                   row_number() over (
                     partition by base.group_key
                     order by ${trackOrderSql(sort, "base.")}
                   ) as rn
            from base
          ),
          paged as (
            select ranked.*,
                   dense_rank() over (order by ${groupRankOrderSql(sort)}) as group_rn
            from ranked
          ),
          counted as (
            select paged.*, max(paged.group_rn) over () as total_groups from paged
          )
          select track_id, title, artists_json, spotify_url, isrc, album, album_slug,
                 release_date, group_key, group_name, group_slug, group_release_date,
                 track_count, record_count, total_tracks, total_groups
          from counted
          where rn <= ? and group_rn > ? and group_rn <= ?
          order by group_rn asc, rn asc`,
  });

  const rows = typedRows<GroupedTrackRow>(result.rows);

  if (rows.length === 0) {
    if (page > 1) {
      throw new CataloguePageOutOfRangeError();
    }

    return { ...EMPTY, totalTracks: 0 };
  }

  const totalGroups = Number(rows[0]?.total_groups ?? 0);
  let removed = 0;
  const groups = intoGroups(rows).map(({ head, rows: held }) => {
    const deduped = dedupeByRecordingIdentity(held, groupRowIdentity);

    removed += held.length - deduped.length;

    return {
      name: head.group_name === "" ? undefined : head.group_name,
      releaseDate: head.group_release_date ?? undefined,
      slug: head.group_slug ?? undefined,
      tracks: deduped.map(toTrack),
    };
  });

  return {
    groups,
    page,
    pageCount: Math.max(Math.ceil(totalGroups / GRAPH_GROUP_PAGE_SIZE), 1),
    totalGroups,
    // The SQL total counts every unstamped twin in this artist's slice; the fold has collapsed
    // them, so subtract what it removed. Clamped to what actually rendered so the thin-content
    // gate never reports fewer tracks than the page shows.
    totalTracks: Math.max(
      Number(rows[0]?.total_tracks ?? 0) - removed,
      flattenRecords(groups).length,
    ),
  };
}

// ── THE LABEL PAGE: the rest of a label, grouped by artist, then by record ──────────────

/**
 * A label's uncertified tracks, grouped by ARTIST and then by record inside each artist.
 *
 * Groups on `json_each(artists_json)` rather than the `track_artists` edge, and that is
 * deliberate: a crawl artist may have an `artists` row (the crawler mints one off the Spotify
 * anchor's stable id) or none at all (a track with no Spotify presence), so a `track_artists`
 * grouping would silently DROP every track of an unentitied artist from the label's page. Their
 * name is always on the track; the page groups by it regardless. The `/artist/<slug>` link is a
 * SEPARATE question: the `artists a` name-fold join lights the link whenever that artist has an
 * entity — a crawl-minted, findings-free artist has a public catalogue page now, so its heading is a
 * live link, exactly as the album heading is. A credited name with no entity renders as plain text.
 * Nothing vanishes either way.
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
  const offset = (page - 1) * GRAPH_GROUP_PAGE_SIZE;

  // ONE walk of the label's rows — the `tracks.label_id` seek, exploded through `json_each`
  // exactly once instead of once per wave. The levels mirror the artist read; two of them earn
  // their keep here specifically:
  //
  //   - `record_count` is a count of DISTINCT records, and SQLite has no `count(distinct …)`
  //     window. `dense_rank()` over the record key inside the artist's partition numbers the
  //     records 1…n, so its MAX over that partition IS the distinct count — over the whole
  //     group, before the cap, exactly as the old `count(distinct …)` was.
  //   - `artist_slug` joins `artist_slugs`, a name-folded view of `artists`, not `artists`
  //     itself. Two artist entities can carry the same name (the crawler mints one per stable
  //     Spotify id), and joining the raw table multiplies the credit row by however many of them
  //     there are — harmless under a `group by`, but this statement carries the TRACK rows too,
  //     so a bare join would render a track twice and inflate the group's counts. Folding first
  //     picks the same slug the old `min(a.slug)` did and multiplies nothing. It is a join
  //     rather than a per-row subquery on purpose: `artists.name` has no NOCASE index, so the
  //     planner builds ONE transient index for the join, where a subquery would re-scan
  //     `artists` for every credit on the label.
  //   - `total_tracks` is the label's TRUE uncertified total, counted over TRACKS and never
  //     over the exploded credits (a two-artist track is two credit rows and one track). It
  //     stays its own uncorrelated count — SQLite evaluates it once — so the thin-content gate
  //     keeps the honest number without costing a second trip to Ireland.
  const result = await db.execute({
    args: [labelId, labelId, GRAPH_GROUP_TRACK_LIMIT, offset, offset + GRAPH_GROUP_PAGE_SIZE],
    sql: `with artist_slugs as (
            select a.name as name, min(a.slug) as slug
            from artists a
            group by a.name collate nocase
          ),
          base as (
            select tracks.track_id as track_id, tracks.title as title,
                   tracks.artists_json as artists_json, tracks.spotify_url as spotify_url,
                   tracks.isrc as isrc, tracks.album as album, al.slug as album_slug,
                   tracks.release_date as release_date,
                   lower(credit.value) as group_key, credit.value as credit_name,
                   asl.slug as artist_slug
            from tracks
            left join findings on findings.track_id = tracks.track_id
            join json_each(tracks.artists_json) credit
            left join artist_slugs asl on asl.name = credit.value collate nocase
            left join albums al on al.id = tracks.album_id
            where tracks.label_id = ? and findings.track_id is null
                  and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null
          ),
          ranked as (
            select base.*,
                   min(base.credit_name) over (partition by base.group_key) as group_name,
                   min(base.artist_slug) over (partition by base.group_key) as group_slug,
                   max(base.release_date) over (partition by base.group_key)
                     as group_release_date,
                   count(*) over (partition by base.group_key) as track_count,
                   dense_rank() over (
                     partition by base.group_key
                     order by lower(coalesce(base.album, ''))
                   ) as record_rank,
                   row_number() over (
                     partition by base.group_key
                     order by ${trackOrderSql(sort, "base.")}
                   ) as rn
            from base
          ),
          paged as (
            select ranked.*,
                   max(ranked.record_rank) over (partition by ranked.group_key) as record_count,
                   dense_rank() over (order by ${groupRankOrderSql(sort)}) as group_rn
            from ranked
          ),
          counted as (
            select paged.*, max(paged.group_rn) over () as total_groups from paged
          )
          select track_id, title, artists_json, spotify_url, isrc, album, album_slug,
                 release_date, group_key, group_name, group_slug, group_release_date,
                 track_count, record_count, total_groups,
                 (select count(*)
                  from tracks
                  left join findings on findings.track_id = tracks.track_id
                  where tracks.label_id = ? and findings.track_id is null
                        and tracks.duplicate_of_track_id is null
                        and tracks.dismissed_at is null) as total_tracks
          from counted
          where rn <= ? and group_rn > ? and group_rn <= ?
          order by group_rn asc, rn asc`,
  });

  const rows = typedRows<GroupedTrackRow>(result.rows);

  if (rows.length === 0) {
    if (page > 1) {
      throw new CataloguePageOutOfRangeError();
    }

    // No credited row means nothing renders, so nothing counts: the thin-content gate reads
    // what the page can actually show, and a label whose every uncertified track is credited to
    // no one shows none of them.
    return { ...EMPTY, totalTracks: 0 };
  }

  const totalTracks = Number(rows[0]?.total_tracks ?? 0);
  const totalGroups = Number(rows[0]?.total_groups ?? 0);
  let removed = 0;
  const groups = intoGroups(rows).map(({ head, rows: held }) => {
    const records = intoRecords(held);

    removed += records.removed;

    return {
      name: head.group_name,
      recordCount: Number(head.record_count),
      records: records.records,
      slug: head.group_slug ?? undefined,
      truncated: Number(head.track_count) > held.length,
    };
  });

  return {
    groups,
    page,
    pageCount: Math.max(Math.ceil(totalGroups / GRAPH_GROUP_PAGE_SIZE), 1),
    totalGroups,
    // The SQL total counts every unstamped twin the label carries; the fold has collapsed the
    // ones in this slice, so subtract them. Clamped to the rendered count so the thin-content
    // gate never reports fewer tracks than the page shows.
    totalTracks: Math.max(totalTracks - removed, flattenArtistGroups(groups).length),
  };
}

// ── The shared machinery ────────────────────────────────────────────────────────────────

/**
 * The rows come back in group order (the SQL's `group_rn`, then `rn`), so one consecutive pass
 * splits them back into groups — no map, no re-sort, and the SQL's order is what renders. Every
 * group on the page carries at least one row by construction, so no group can be lost here.
 */
function intoGroups(
  rows: GroupedTrackRow[],
): Array<{ head: GroupedTrackRow; rows: GroupedTrackRow[] }> {
  const groups: Array<{ head: GroupedTrackRow; rows: GroupedTrackRow[] }> = [];

  for (const row of rows) {
    const current = groups.at(-1);

    if (current && current.head.group_key === row.group_key) {
      current.rows.push(row);
      continue;
    }

    groups.push({ head: row, rows: [row] });
  }

  return groups;
}

/**
 * Split one artist's rows (already ordered by SQL) into their records, order preserved, folding
 * the twins the stamping missed WITHIN each record (a reissue under a second barcode renders
 * once). Reports how many rows the fold removed so the caller can keep `totalTracks` honest.
 */
function intoRecords(rows: GroupTrackRow[]): { records: CatalogueRecord[]; removed: number } {
  const buckets: GroupTrackRow[][] = [];
  const index = new Map<string, GroupTrackRow[]>();

  for (const row of rows) {
    const key = (row.album ?? "").toLowerCase();
    const held = index.get(key);

    if (held) {
      held.push(row);
      continue;
    }

    const bucket = [row];

    index.set(key, bucket);
    buckets.push(bucket);
  }

  let removed = 0;
  const records = buckets.map((bucket) => {
    const deduped = dedupeByRecordingIdentity(bucket, groupRowIdentity);

    removed += bucket.length - deduped.length;

    // Every row in a bucket shares the record's album/slug; the release date leads with the
    // first (the SQL order already put the record's newest-or-A–Z row first).
    const head = bucket[0];

    return {
      name: head?.album ?? undefined,
      releaseDate: head?.release_date ?? undefined,
      slug: head?.album_slug ?? undefined,
      tracks: deduped.map(toTrack),
    };
  });

  return { records, removed };
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

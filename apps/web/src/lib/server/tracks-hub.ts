// `/tracks` — THE WHOLE LIST, across the whole archive.
//
// The top-level index every other surface implies but never was: every track Fluncle holds, the
// certified findings and the wider catalogue he is charting, in ONE newest-release-first list you
// can filter and page through. It is a CATALOGUE page (VOICE.md's Three Areas) — a reference shelf,
// not a lore page — and it renders the two-register grammar the rest of the archive lives by: a
// certified finding is LIT (its cover, its Log ID coordinate, a link to `/log/<logId>`), an
// uncertified catalogue row is UNLIT (no cover — the eclipse fallback — no coordinate, out to
// Spotify — DESIGN.md's Unlit Rule). The register is a bit the mapper reads, structural in the shape
// below; the row component (`components/tracks-hub-row.tsx`) renders each register without deciding
// which one it is.
//
// ── RELEASE DATE, NOT FOUND DATE ───────────────────────────────────────────────────────
// Like `/fresh`, this list is ordered by `tracks.release_date` (when a tune CAME OUT), never
// `findings.added_at` (when Fluncle FOUND it). A catalogue row has no found date at all — release
// date is the one axis both registers share — so it is the only honest ordering key for a unified
// list, and the copy never claims Fluncle found the catalogue rows (VOICE.md's Found Rule).
//
// ── WHY IT SCALES ──────────────────────────────────────────────────────────────────────
// Unlike `/fresh` (a 30-day window), this is the UNBOUNDED archive, so it cannot fold the whole
// table into the isolate. It is NUMBERED-page paginated (the `/labels` + `/albums` + `/artists` hub
// precedent, #731): the primary sort (`release_date desc`) rides the `tracks_release_date_idx` btree
// as a reverse scan, and each page is a `limit ? offset ?` slice of it — a real `?page=N` URL a
// crawler follows, no keyset cursor and nothing that loads on scroll. The total (for the pager +
// the CollectionPage `numberOfItems`) is a separate `count(*)` over the same filtered set, run in
// parallel. TRACK_SELECT is a NAMED column list — never `select *` — so the wide embedding BLOBs on
// `tracks` never cross into the isolate at 30k rows (AGENTS.md's database rule). The filter
// predicates are the same compiled vocabulary `/search` uses (`compileFilters`), plus the BPM-range
// filter that motivated `tracks_bpm_idx`. The offset walk over a growing table is the tradeoff a
// numbered pager makes; it must be proven against HOSTED Turso (a scratch DB) before any scale
// claim, never `turso dev` (docs/local-database.md, "Local is not production").
//
// ── THE JOIN IS PAID ONLY WHEN IT IS READ ──────────────────────────────────────────────
// `findings.track_id` is the PRIMARY KEY of `findings`, so `left join findings` is strictly
// cardinality-preserving — it can neither add nor drop a `tracks` row nor repeat one. Of the hub's
// predicates only the GALAXY extension reads a `findings` column; the shared six read `tracks`
// alone. So the two scanning reads and the pager's `count(*)` drop the join whenever no clause names
// `findings.`. Measured by `explain query plan` (SHAPE evidence — the timings belong to the hosted
// bench, never to a local run), the win is NOT where it looks:
//
//   • THE YEAR LANE is where it is large. Carrying the join, the planner chose a bare `SCAN tracks`
//     — a full scan of the WIDE row, dragging every `F32_BLOB(1024)` embedding off disk to read one
//     10-byte date — plus a `findings` probe per row. Without it: `SEARCH tracks USING COVERING
//     INDEX tracks_release_date_idx`. The table is never touched at all.
//   • THE `count(*)` loses its per-row `findings` probe: `SCAN tracks USING COVERING INDEX …
//     + SEARCH findings … LEFT-JOIN` becomes a lone covering scan.
//   • THE ID PAGE is unchanged — SQLite already proved the join unused there and elided it. Dropping
//     it in the builder is defensive tidiness, not a speedup; it is honest to say so.
//
// The HYDRATE step keeps the join unconditionally: it reads findings columns for real.
//
// ── THE PAGE-INDEPENDENT READS ARE MEMOISED ────────────────────────────────────────────
// The pager's `count(*)` and the year lane are IDENTICAL for every `?page=N` of the same filter set
// — two full-set aggregates re-run on every deep page for an answer that did not change. They ride a
// short in-isolate TTL memo (see {@link HUB_AGGREGATE_TTL_MS}) that also de-duplicates concurrent
// in-flight loads, so a crawler walking the pager pays them once per window rather than once per
// page. Staleness is structurally harmless: the total feeds only the pager's page COUNT and the
// masthead number, never the 404 decision (that reads the id slice's emptiness), and the same 60 s
// window is already what the bare hub's edge cache accepts.

import { type SearchFilters } from "@fluncle/contracts/orpc";
import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import {
  type FreshCatalogueItem,
  type FreshFinding,
  LEAD_ARTIST_JOIN,
  LEAD_ARTIST_SELECT,
  type LeadArtistRow,
  leadArtistAvatarUrl,
} from "./fresh";
import { type CatalogueHubNumberedPage, CatalogueHubPageOutOfRangeError } from "./labels";
import { type Clause, compileFilters } from "./search";
import { fold } from "./track-match";
import { TRACK_SELECT, toPublicTrackListItem, toTrackListItem, type TrackRow } from "./tracks";

// Note: this hub deliberately does NOT drive through `tracks.ts`'s inner `FINDINGS_FROM` join — it
// uses a LEFT join so a catalogue row (no `findings` row) survives in the unlit register.

/** A browse page's size — a reading surface, not an infinite feed. Shared with the year fast lane's
    year → page mapping, so a year links to exactly the page its first release lands on. */
export const TRACKS_HUB_PAGE_SIZE = 48;

/**
 * The hub's filter axes. The shared six MIRROR `SearchFiltersSchema` VERBATIM
 * (`yearMin`/`yearMax`, `bpmMin`/`bpmMax`, `key`, `label`) — same names, same semantics, compiled by
 * the same `compileFilters` — so one filter vocabulary reads the same on `/search` and here.
 *
 * `galaxy` (a galaxy SLUG) is the one extension beyond that schema. Because a galaxy lives on
 * `findings.galaxy_id`, filtering by it structurally narrows the list to certified findings — the
 * filtered list simply contains only lit rows, rendered honestly.
 */
export type TracksHubFilters = {
  bpmMax?: number;
  bpmMin?: number;
  galaxy?: string;
  key?: string;
  label?: string;
  yearMax?: number;
  yearMin?: number;
};

/**
 * One artist credit on a hub row, with the `/artist/<slug>` slug when the artist entity exists (a
 * bare name when it does not — nowhere honest to send you, so the row component renders it plain).
 * Resolved in the SAME select that loaded the row (a JSON subquery over `track_artists`), so linking
 * every artist on 48 rows costs no per-row round trip.
 */
export type TracksHubArtistLink = { name: string; slug?: string };

/**
 * One row of the hub: a lit finding or an unlit catalogue row, plus the release date the row's date
 * column prints and the resolved artist links both registers render. A finding carries its full
 * public DTO (cover, coordinate, label + slug); a catalogue row carries only the columns the unlit
 * register renders (no cover crosses the wire — the Unlit Rule is structural in this shape), plus
 * the label + slug so its imprint still links to `/label/<slug>` when the entity exists.
 */
export type TracksHubEntry =
  | {
      artistLinks: TracksHubArtistLink[];
      finding: FreshFinding;
      kind: "finding";
      releaseDate: string;
    }
  | {
      artistLinks: TracksHubArtistLink[];
      kind: "catalogue";
      label?: string;
      labelSlug?: string;
      releaseDate: string;
      track: FreshCatalogueItem;
    };

/** A present release YEAR in the result set, mapped to the page its first (newest) release lands on
    — the year fast lane's data (the A–Z lane mechanic mapped onto time). */
export type TracksHubYearLaneEntry = { page: number; year: string };

/** The row shape the unified read hands back — `TRACK_SELECT` + the lead-artist columns + the flag +
    the artist-slug JSON. */
type TracksHubRow = LeadArtistRow &
  TrackRow & {
    /** The `[{name, slug}]` JSON for the row's artists (via `track_artists`), or "[]"/null for none. */
    artist_slugs_json: string | null;
    /** 1 ⇔ a `findings` row exists ⇔ this is a certified finding (lit); 0 ⇔ a catalogue row (unlit). */
    certified: number;
  };

/**
 * The galaxy clause — the hub's one extension past `compileFilters`. A galaxy lives on
 * `findings.galaxy_id`, so this resolves the slug to its id via a subquery and requires the galaxy
 * to be NAMED and non-retired (never a machine handle, never a retired cluster). On a LEFT join a
 * catalogue row's `findings.galaxy_id` is null, so this predicate is false for every catalogue row —
 * which is exactly why a galaxy filter narrows the list to certified findings.
 */
function galaxyClause(slug: string): Clause {
  return {
    args: [slug],
    sql: `findings.galaxy_id = (
            select id from galaxies where slug = ? and name is not null and retired_at is null
          )`,
  };
}

/** Assemble the where-clause set: the shared compiled filters + the galaxy extension. */
export function tracksHubClauses(filters: TracksHubFilters): Clause[] {
  // The shared six, compiled by the SAME function `/search` uses. Only the shared subset is passed
  // — never `artist`/`album`/`text` — so the compiled SQL is exactly the hub's filter vocabulary.
  const shared: SearchFilters = {
    bpmMax: filters.bpmMax,
    bpmMin: filters.bpmMin,
    key: filters.key,
    label: filters.label,
    yearMax: filters.yearMax,
    yearMin: filters.yearMin,
  };

  const clauses = compileFilters(shared);

  if (filters.galaxy) {
    clauses.push(galaxyClause(filters.galaxy));
  }

  return clauses;
}

/** The `where …` fragment + its bound args for a filter set (empty string when nothing is filtered). */
function whereFor(clauses: Clause[]): { args: (number | string)[]; where: string } {
  return {
    args: clauses.flatMap((clause) => clause.args),
    where: clauses.length > 0 ? `where ${clauses.map((clause) => clause.sql).join(" and ")}` : "",
  };
}

/** The join a scanning read only pays when a predicate actually reads a `findings` column. Derived
    from the compiled SQL rather than from `filters.galaxy` so a future findings-reading clause turns
    it back on by itself — the join is never silently dropped out from under a predicate that needs
    it. Safe to drop otherwise: `findings.track_id` is that table's PRIMARY KEY, so the LEFT JOIN is
    1:0..1 and cannot change which `tracks` rows survive or how many times each appears. */
function findingsJoinFor(clauses: Clause[]): string {
  return clauses.some((clause) => clause.sql.includes("findings."))
    ? "left join findings on findings.track_id = tracks.track_id"
    : "";
}

/** The window a page-independent aggregate (the pager total, the year lane) may be served stale
    within — matched to the bare hub's edge-cache freshness window. */
const HUB_AGGREGATE_TTL_MS = 60_000;

/** A hard ceiling on distinct memoised filter sets, so an adversarial filter fan-out cannot grow the
    isolate's memory without bound. The oldest insertion is evicted first (a Map iterates in
    insertion order), which is the right victim: the bare hub is re-inserted constantly. */
const HUB_AGGREGATE_CACHE_MAX = 32;

type HubAggregateEntry = { expires: number; value: Promise<unknown> };

const hubAggregateCache = new Map<string, HubAggregateEntry>();

/**
 * Serve a page-independent aggregate from the in-isolate TTL memo, loading it at most once per
 * window. The PROMISE is cached rather than the resolved value, so concurrent pages of the same
 * filter set share one in-flight query instead of racing N identical full-set scans; a rejection
 * evicts itself, so a failed load is never cached.
 */
async function memoizedAggregate<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = hubAggregateCache.get(key);
  const now = Date.now();

  if (cached && cached.expires > now) {
    return cached.value as Promise<T>;
  }

  const value = load();

  hubAggregateCache.set(key, { expires: now + HUB_AGGREGATE_TTL_MS, value });

  if (hubAggregateCache.size > HUB_AGGREGATE_CACHE_MAX) {
    const oldest = hubAggregateCache.keys().next();

    if (!oldest.done) {
      hubAggregateCache.delete(oldest.value);
    }
  }

  try {
    return await value;
  } catch (error) {
    hubAggregateCache.delete(key);

    throw error;
  }
}

/** Drop every memoised aggregate. The hub's reads are never invalidated in production (the TTL is
    the whole contract); this exists so a test that reseeds the database between cases starts from a
    cold memo rather than reading the previous case's totals. */
export function resetTracksHubAggregateCache(): void {
  hubAggregateCache.clear();
}

/** The memo key for a filter set — the compiled clause set, which is exactly what the SQL and its
    bound args are built from, so two filter objects that compile identically share one entry. */
function aggregateKey(kind: string, clauses: Clause[]): string {
  return `${kind}:${JSON.stringify(clauses.map((clause) => [clause.sql, clause.args]))}`;
}

/** The `track_artists → artists` JSON subquery: `[{name, slug}]` for the row's artists, one indexed
    seek (`track_artists_track_id_idx` + the `artists` PK), the lead-artist subquery's sibling. */
const ARTIST_SLUGS_SELECT = `(select json_group_array(json_object('name', a.name, 'slug', a.slug))
     from track_artists ta join artists a on a.id = ta.artist_id
     where ta.track_id = tracks.track_id) as artist_slugs_json`;

/** Fold a row's artist-slug JSON into a `fold(name) → slug` map (the `getArtistSlugMap` shape),
    keyed by the NORMALIZED name so a casing/accent drift between the canonical `artists.name` and
    the `artists_json` display cache still resolves. A blank/absent JSON yields an empty map. */
function parseArtistSlugMap(json: string | null): Map<string, string> {
  const map = new Map<string, string>();

  if (!json) {
    return map;
  }

  try {
    const parsed = JSON.parse(json) as unknown;

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const name = (entry as Record<string, unknown>)?.["name"];
        const slug = (entry as Record<string, unknown>)?.["slug"];

        if (typeof name === "string" && typeof slug === "string" && slug) {
          map.set(fold(name), slug);
        }
      }
    }
  } catch {
    return map;
  }

  return map;
}

/** Map one unified row to its register shape — a lit finding, or an unlit catalogue row. */
function toTracksHubEntry(row: TracksHubRow): TracksHubEntry {
  const releaseDate = row.release_date ?? "";
  const artistAvatarUrl = leadArtistAvatarUrl(row);
  const displayArtists = parseArtistsJson(row.artists_json);
  const slugMap = parseArtistSlugMap(row.artist_slugs_json);
  const artistLinks: TracksHubArtistLink[] = displayArtists.map((name) => {
    const slug = slugMap.get(fold(name));

    return slug ? { name, slug } : { name };
  });

  if (row.certified) {
    // A finding carries the full `TRACK_SELECT` columns (findings.* are non-null here); map it the
    // way `/fresh` does — public-stripped, plus the lead-artist avatar.
    return {
      artistLinks,
      finding: { ...toPublicTrackListItem(toTrackListItem(row)), artistAvatarUrl },
      kind: "finding",
      releaseDate,
    };
  }

  // A catalogue row: the findings.* columns are null and NEVER read. Only the `tracks` columns map,
  // and no cover and no coordinate cross the wire (the Unlit Rule is structural in this shape). The
  // label + slug ride along so the row's imprint still links to `/label/<slug>` when it has a page.
  return {
    artistLinks,
    kind: "catalogue",
    label: row.label ?? undefined,
    labelSlug: row.label_slug ?? undefined,
    releaseDate,
    track: {
      artistAvatarUrl,
      artists: displayArtists,
      releaseDate,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    },
  };
}

/**
 * ONE numbered page of the `/tracks` hub: every track (findings + catalogue) that survives the
 * filters, newest release first, as a `limit ? offset ?` slice riding `tracks_release_date_idx`.
 * Throws {@link CatalogueHubPageOutOfRangeError} for a page past the end (page 1 of an empty result
 * is a legitimate empty page, never a throw) so the route can 404 rather than clamp — a `?page=99`
 * on a 3-page hub is NOT a second URL for page 1's rows. The `count(*)` for the total runs in
 * parallel over the same filtered set.
 *
 * ── LATE ROW LOOKUP: page the IDS, then hydrate exactly 48 ─────────────────────────────
 * SQLite evaluates SELECT-list scalar subqueries for every row it MATERIALIZES, and `offset` skips
 * rows AFTER materialization — so a one-step read that carries `TRACK_SELECT`'s per-row subqueries
 * (album/label/galaxy slugs, the lead-artist join, the artist-slug JSON) pays them for every
 * offset-skipped row too: page 300 executed ~14,400 subquery sets, not 48 (measured live
 * 2026-07-19 — 3.7 s at page 2, 9.3 s at page 300, vs 1.3 s at page 1). So the read is TWO steps:
 *
 *   1. Page the bare ids — `select track_id … order by release_date desc … limit ? offset ?`, no
 *      SELECT-list subqueries, so the offset walk touches only the `tracks_release_date_idx` order
 *      and the filter predicates.
 *   2. Hydrate exactly those ≤48 ids with the full column set (`where track_id in (…)`), re-ordered
 *      in code by the step-1 position (the `in` clause returns rows in arbitrary order).
 */
/** The filtered `count(*)` — the pager's total, over the same clause set as the id page. */
export function tracksHubCountQuery(filters: TracksHubFilters): {
  args: (number | string)[];
  sql: string;
} {
  const clauses = tracksHubClauses(filters);
  const { args, where } = whereFor(clauses);

  return {
    args,
    sql: `select count(*) as total
          from tracks
          ${findingsJoinFor(clauses)}
          ${where}`,
  };
}

/**
 * Step 1's SQL: the bare id slice. No SELECT-list subqueries, so the offset walk touches only the
 * `tracks_release_date_idx` order and the filter predicates. The `findings` join appears ONLY when a
 * predicate reads it (the galaxy filter) — the plan here is identical either way (SQLite already
 * elided the unused join), so that is tidiness rather than a speedup; the join drop earns its keep
 * on the year lane and the `count(*)`. Exported so the hosted bench (`scripts/bench-tracks-hub.ts`)
 * measures the EXACT production shape.
 */
export function tracksHubIdPageQuery(
  filters: TracksHubFilters,
  limit: number,
  offset: number,
): { args: (number | string)[]; sql: string } {
  const clauses = tracksHubClauses(filters);
  const { args, where } = whereFor(clauses);

  return {
    args: [...args, limit, offset],
    sql: `select tracks.track_id as track_id
          from tracks
          ${findingsJoinFor(clauses)}
          ${where}
          order by tracks.release_date desc, tracks.track_id desc
          limit ? offset ?`,
  };
}

/**
 * Step 2's SQL: hydrate exactly one page's ids with the full column set. The per-row subqueries run
 * once per HYDRATED row (≤ the page size), whatever the offset was. Exported for the hosted bench.
 */
export function tracksHubHydrateQuery(ids: string[]): { args: string[]; sql: string } {
  const placeholders = ids.map(() => "?").join(", ");

  return {
    args: ids,
    sql: `select ${TRACK_SELECT}, ${LEAD_ARTIST_SELECT},
                 (findings.track_id is not null) as certified,
                 ${ARTIST_SLUGS_SELECT}
          from tracks
          left join findings on findings.track_id = tracks.track_id
          ${LEAD_ARTIST_JOIN}
          where tracks.track_id in (${placeholders})`,
  };
}

/** The pager's total for a filter set, served from the TTL memo. Page-independent by construction —
    every `?page=N` of one filter set asks the same question of the same rows. */
async function countTracksHub(filters: TracksHubFilters): Promise<number> {
  const query = tracksHubCountQuery(filters);

  return memoizedAggregate(aggregateKey("count", tracksHubClauses(filters)), async () => {
    const db = await getDb();
    const result = await db.execute(query);

    return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
  });
}

export async function listTracksHubPage(
  filters: TracksHubFilters,
  page: number,
): Promise<CatalogueHubNumberedPage<TracksHubEntry>> {
  const db = await getDb();
  const limit = TRACKS_HUB_PAGE_SIZE;

  // Step 1 (+ the total, in parallel): the id slice. The total is page-independent, so it rides the
  // TTL memo — a walk down the pager pays that full-set aggregate once, not once per page.
  const [total, idsResult] = await Promise.all([
    countTracksHub(filters),
    db.execute(tracksHubIdPageQuery(filters, limit, (page - 1) * limit)),
  ]);

  const ids = typedRows<{ track_id: string }>(idsResult.rows).map((row) => row.track_id);

  if (ids.length === 0 && page > 1) {
    throw new CatalogueHubPageOutOfRangeError();
  }

  // Step 2: hydrate exactly the page's ids. Empty page (page 1 of an empty result) skips the trip.
  const rows: TracksHubRow[] = [];

  if (ids.length > 0) {
    const hydrated = await db.execute(tracksHubHydrateQuery(ids));

    // Re-impose the step-1 order: `in (…)` returns rows in storage order, not list order.
    const byId = new Map(typedRows<TracksHubRow>(hydrated.rows).map((row) => [row.track_id, row]));

    for (const id of ids) {
      const row = byId.get(id);

      if (row) {
        rows.push(row);
      }
    }
  }

  return {
    items: rows.map(toTracksHubEntry),
    page,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    total,
  };
}

/**
 * The whole held count: every track Fluncle holds, findings + catalogue. Drives the masthead's "all
 * N of them" line when a filter is active (so the masthead still names the archive's true size while
 * the filtered count sits by the form). A bare `count(*)`, the cheapest read on the table. On an
 * UNFILTERED view the page read's own total already IS this, so the route reuses it and skips this.
 * Page-independent, so it rides the same TTL memo as the pager's total.
 */
export async function countAllTracks(): Promise<number> {
  return memoizedAggregate(aggregateKey("count", []), async () => {
    const db = await getDb();
    const result = await db.execute(`select count(*) as total from tracks`);

    return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
  });
}

/**
 * Fold per-year counts (newest year first) into one page number per year — the year fast lane. Pure,
 * so it is unit-pinned. Because the list orders `release_date desc`, every release of a later year
 * sorts before any release of an earlier one, so a year's first row lands at the running rank of all
 * later years' rows; its page is `floor(rank / pageSize) + 1`. Undated rows sort last and never move
 * a year, so the lane read excludes them.
 */
export function yearPages(
  counts: { n: number; year: string }[],
  pageSize: number,
): TracksHubYearLaneEntry[] {
  const lane: TracksHubYearLaneEntry[] = [];
  let rank = 0;

  for (const { n, year } of counts) {
    lane.push({ page: Math.floor(rank / pageSize) + 1, year });
    rank += Number(n);
  }

  return lane;
}

/**
 * The year fast lane: every release YEAR present in the (dated) result set, newest first, each
 * mapped to the page its first release lands on. ONE grouped query over the same filtered set the
 * page read uses (composing with any active non-year filter), folded to pages by {@link yearPages} —
 * never a per-year query. The route hides the lane when a year filter is active (a single year needs
 * no time lane), so the filters here carry no year bound in practice.
 */
export function tracksHubYearLaneQuery(filters: TracksHubFilters): {
  args: (number | string)[];
  clauses: Clause[];
  sql: string;
} {
  const clauses: Clause[] = [
    { args: [], sql: `tracks.release_date is not null` },
    ...tracksHubClauses(filters),
  ];
  const { args, where } = whereFor(clauses);

  return {
    args,
    clauses,
    // Unfiltered (and under any `tracks`-only filter) this references `tracks.release_date` and
    // nothing else, so the grouped scan is a covering read of `tracks_release_date_idx` rather than a
    // drag over the wide row — the embedding BLOBs on `tracks` are never touched.
    sql: `select substr(tracks.release_date, 1, 4) as year, count(*) as n
          from tracks
          ${findingsJoinFor(clauses)}
          ${where}
          group by year
          order by year desc`,
  };
}

export async function listTracksHubYearLane(
  filters: TracksHubFilters,
): Promise<TracksHubYearLaneEntry[]> {
  const { clauses, ...query } = tracksHubYearLaneQuery(filters);

  return memoizedAggregate(aggregateKey("years", clauses), async () => {
    const db = await getDb();
    const result = await db.execute(query);

    return yearPages(typedRows<{ n: number; year: string }>(result.rows), TRACKS_HUB_PAGE_SIZE);
  });
}

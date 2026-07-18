// `/tracks` — THE WHOLE LIST, across the whole archive.
//
// The top-level index every other surface implies but never was: every track Fluncle holds, the
// certified findings and the wider catalogue he is charting, in ONE newest-release-first list you
// can filter and page through. It is a CATALOGUE page (VOICE.md's Three Areas) — a reference shelf,
// not a lore page — and it renders the two-register grammar the rest of the archive lives by: a
// certified finding is LIT (its cover-lead avatar, its Log ID coordinate, a link to `/log/<logId>`),
// an uncertified catalogue row is UNLIT (a dimmed avatar, no coordinate, out to Spotify — DESIGN.md's
// Unlit Rule). Both registers are enforced once, in `FreshStreamRow` (`components/fresh/shared.tsx`),
// which this hub renders through unchanged; the split here is structural, in the mapper below.
//
// ── RELEASE DATE, NOT FOUND DATE ───────────────────────────────────────────────────────
// Like `/fresh`, this list is ordered by `tracks.release_date` (when a tune CAME OUT), never
// `findings.added_at` (when Fluncle FOUND it). A catalogue row has no found date at all — release
// date is the one axis both registers share — so it is the only honest ordering key for a unified
// list, and the copy never claims Fluncle found the catalogue rows (VOICE.md's Found Rule).
//
// ── WHY IT SCALES ──────────────────────────────────────────────────────────────────────
// Unlike `/fresh` (a 30-day window), this is the UNBOUNDED archive, so it cannot fold the whole
// table into the isolate. Instead it is KEYSET-paginated: the primary sort (`release_date desc`)
// rides the `tracks_release_date_idx` btree as a reverse scan, a `limit + 1` caps every page, and
// the cursor resumes at the exact `{releaseDate, trackId}` boundary — never an OFFSET that re-scans
// the skipped prefix as the archive grows (AGENTS.md: never a full scan of a growing table). The
// filter predicates are the same compiled vocabulary `/search` uses (`compileFilters`), plus the
// BPM-range filter that motivated `tracks_bpm_idx`. Proven against HOSTED Turso by
// `apps/web/scripts/bench-tracks-hub.ts` — never `turso dev` (docs/local-database.md).

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
import { type Clause, compileFilters } from "./search";
import { TRACK_SELECT, toPublicTrackListItem, toTrackListItem, type TrackRow } from "./tracks";

// Note: this hub deliberately does NOT drive through `tracks.ts`'s inner `FINDINGS_FROM` join — it
// uses a LEFT join so a catalogue row (no `findings` row) survives in the unlit register.

/** A browse page's size — a reading surface, not an infinite feed, but deep enough to fill a viewport. */
export const TRACKS_HUB_PAGE_SIZE = 25;
/** The hard ceiling a caller-supplied limit is clamped to (a hostile `?limit` can't fold the archive). */
export const TRACKS_HUB_MAX_LIMIT = 50;

/**
 * The hub's filter axes. The shared six MIRROR `SearchFiltersSchema` VERBATIM
 * (`yearMin`/`yearMax`, `bpmMin`/`bpmMax`, `key`, `label`) — same names, same semantics, compiled by
 * the same `compileFilters` — so one filter vocabulary reads the same on `/search` and here.
 *
 * `galaxy` (a galaxy SLUG) is the one extension beyond that schema. It does not exist on
 * `SearchFiltersSchema` yet; it is a CANDIDATE for the shared vocabulary once search grows a
 * galaxy tier. Because a galaxy lives on `findings.galaxy_id`, filtering by it structurally narrows
 * the list to certified findings — the filtered list simply contains only lit rows, rendered honestly.
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
 * The keyset cursor: the ordering tuple of the last row on the page. `release_date` is nullable
 * (an undated catalogue row), and the list orders nulls LAST, so the cursor carries the null too.
 * A SEPARATE type from the feed's `TrackCursor` (which keys `{addedAt, trackId}`) — the two orders
 * are unrelated, so overloading one cursor across both would be a silent bug.
 */
export type TracksHubCursor = {
  releaseDate: string | null;
  trackId: string;
};

/**
 * One row of the hub, in the exact shape `FreshStreamRow` reads (`FreshStreamEntry`): a lit finding
 * or an unlit catalogue row, plus the top-level release date the row's date column prints. Kept
 * structurally identical to `FreshStreamEntry` so the shared row component renders it unchanged.
 */
export type TracksHubEntry =
  | { finding: FreshFinding; kind: "finding"; releaseDate: string }
  | { kind: "catalogue"; releaseDate: string; track: FreshCatalogueItem };

/** A page of the hub: the entries, and the cursor to the next page (absent at the end). */
export type TracksHubPage = {
  entries: TracksHubEntry[];
  nextCursor?: string;
};

/** The row shape the unified read hands back — `TRACK_SELECT` + the lead-artist columns + the flag. */
type TracksHubRow = LeadArtistRow &
  TrackRow & {
    /** 1 ⇔ a `findings` row exists ⇔ this is a certified finding (lit); 0 ⇔ a catalogue row (unlit). */
    certified: number;
  };

export function encodeTracksHubCursor(cursor: TracksHubCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeTracksHubCursor(
  value: string | null | undefined,
): TracksHubCursor | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TracksHubCursor;

    // `releaseDate` is `string | null` (an undated row); `trackId` is always a string. Anything
    // else is a hand-mangled cursor — degrade to "page from the top", never throw.
    if (
      typeof parsed.trackId === "string" &&
      (parsed.releaseDate === null || typeof parsed.releaseDate === "string")
    ) {
      return { releaseDate: parsed.releaseDate, trackId: parsed.trackId };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/** Clamp a caller-supplied limit into `[1, TRACKS_HUB_MAX_LIMIT]`, defaulting to the page size. */
export function clampTracksHubLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return TRACKS_HUB_PAGE_SIZE;
  }

  return Math.max(1, Math.min(TRACKS_HUB_MAX_LIMIT, Math.floor(limit)));
}

/**
 * The keyset "after this cursor" predicate for the `(release_date desc, track_id desc)` order, with
 * nulls sorting LAST (SQLite's native `desc` null placement). Two branches, because the null tail is
 * a different regime:
 *   - cursor on a DATED row → the rest of the dated rows (smaller date, or equal date + smaller id)
 *     AND the whole null tail follow it.
 *   - cursor in the NULL tail → only null rows with a smaller id follow.
 */
export function tracksHubCursorClause(cursor: TracksHubCursor): Clause {
  if (cursor.releaseDate === null) {
    return {
      args: [cursor.trackId],
      sql: `tracks.release_date is null and tracks.track_id < ?`,
    };
  }

  return {
    args: [cursor.releaseDate, cursor.releaseDate, cursor.trackId],
    sql: `(tracks.release_date is null
           or tracks.release_date < ?
           or (tracks.release_date = ? and tracks.track_id < ?))`,
  };
}

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

/** Assemble the full where-clause set: the shared compiled filters + galaxy + the keyset cursor. */
export function tracksHubClauses(
  filters: TracksHubFilters,
  cursor: TracksHubCursor | undefined,
): Clause[] {
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

  if (cursor) {
    clauses.push(tracksHubCursorClause(cursor));
  }

  return clauses;
}

/** Map one unified row to its register shape — a lit finding, or an unlit catalogue row. */
function toTracksHubEntry(row: TracksHubRow): TracksHubEntry {
  const releaseDate = row.release_date ?? "";
  const artistAvatarUrl = leadArtistAvatarUrl(row);

  if (row.certified) {
    // A finding carries the full `TRACK_SELECT` columns (findings.* are non-null here); map it the
    // way `/fresh` does — public-stripped, plus the lead-artist avatar.
    return {
      finding: { ...toPublicTrackListItem(toTrackListItem(row)), artistAvatarUrl },
      kind: "finding",
      releaseDate,
    };
  }

  // A catalogue row: the findings.* columns are null and NEVER read. Only the `tracks` columns map,
  // and no cover and no coordinate cross the wire (the Unlit Rule is structural in this shape).
  return {
    kind: "catalogue",
    releaseDate,
    track: {
      artistAvatarUrl,
      artists: parseArtistsJson(row.artists_json),
      releaseDate,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    },
  };
}

/**
 * Build the hub's read as `{ args, sql }` — the ONE place the query shape lives, so the hosted-scale
 * bench (`scripts/bench-tracks-hub.ts`) measures and `EXPLAIN`s the EXACT query production runs, not
 * a hand-copied twin that could drift. A LEFT join (never `FINDINGS_FROM`'s inner join): a catalogue
 * row must survive in the unlit register. `certified` is the one bit the mapper reads to pick the
 * register. The order rides `tracks_release_date_idx` (reverse scan), nulls last natively; `track_id
 * desc` is the stable tiebreaker that makes the cursor a total order.
 */
export function tracksHubQuery(
  filters: TracksHubFilters,
  cursor: TracksHubCursor | undefined,
  limit: number,
): { args: (number | string)[]; sql: string } {
  const clauses = tracksHubClauses(filters, cursor);
  const where =
    clauses.length > 0 ? `where ${clauses.map((clause) => clause.sql).join(" and ")}` : "";

  return {
    args: [...clauses.flatMap((clause) => clause.args), limit],
    sql: `select ${TRACK_SELECT}, ${LEAD_ARTIST_SELECT},
                 (findings.track_id is not null) as certified
          from tracks
          left join findings on findings.track_id = tracks.track_id
          ${LEAD_ARTIST_JOIN}
          ${where}
          order by tracks.release_date desc, tracks.track_id desc
          limit ?`,
  };
}

/**
 * One page of the `/tracks` hub: every track (findings + catalogue) that survives the filters,
 * newest release first, keyset-paginated. `limit + 1` is fetched to detect a next page without a
 * second count query; the cursor is the last VISIBLE row's ordering tuple.
 */
export async function listTracksHub(options: {
  cursor?: string;
  filters?: TracksHubFilters;
  limit?: number;
}): Promise<TracksHubPage> {
  const db = await getDb();
  const filters = options.filters ?? {};
  const limit = clampTracksHubLimit(options.limit);
  const cursor = decodeTracksHubCursor(options.cursor);
  const result = await db.execute(tracksHubQuery(filters, cursor, limit + 1));

  const rows = typedRows<TracksHubRow>(result.rows);
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const entries = visible.map(toTracksHubEntry);
  const last = visible.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeTracksHubCursor({ releaseDate: last.release_date, trackId: last.track_id })
      : undefined;

  return { entries, nextCursor };
}

// The track_artists graph backfill — fold `tracks.artists_json` names onto EXISTING artist
// identities (RFC artist-primary-capture, slice 0).
//
// ── THE GAP ────────────────────────────────────────────────────────────────────────────────────
// The `track_artists` graph is crawl-era-only (born 2026-07-15): only ~12.3k of ~37.5k tracks carry
// edges. Older rows carry artist NAMES in `tracks.artists_json` but no identity link. Slice 1's
// identity-keyed capture authorization (a track's audio may be bought iff a CREDITED ARTIST is
// qualified) matches BY IDENTITY through this graph — so it needs the graph as full as honest
// matching can make it. This backfill closes the history.
//
// ── THE MATCHER IS IDENTITY-HONEST ───────────────────────────────────────────────────────────────
// For each track lacking edges, each credited name is matched to an EXISTING `artists` row — first
// by exact case-insensitive FOLD on the canonical name (the codebase's `fold`: lowercased,
// accent-folded, `&`→`and`, punctuation collapsed), then via `artist_aliases` (status auto|confirmed,
// kind='name' — the search resolver's alias semantics). It MINTS NOTHING: an `artists` row is an
// entity with a public page, and a bare name string is not enough identity to create one (the RFC
// rule). A name that matches no existing identity is the UNMATCHED RESIDUAL — counted honestly, so a
// later paced MusicBrainz credit-sweep can decide whether the tail is worth minting from.
//
// A fold that two DISTINCT identities share is AMBIGUOUS: a bare name can't choose between them, so
// the key matches nothing (fail-closed). A primary `artists.name` beats an alias for the same fold
// (an alias never overrides or ambiguates a real name).
//
// ── SET-BASED ────────────────────────────────────────────────────────────────────────────────────
// The whole artist + alias corpus (~1.8k rows) folds into ONE in-memory name→artist_id map per pass;
// each track batch matches against that map with NO per-name query. Edges are written `insert or
// ignore` on the natural key `(track_id, artist_id)` so a re-run writes nothing, position from array
// order (1-based, first = lead), role null.
//
// ── RELIABILITY ──────────────────────────────────────────────────────────────────────────────────
// A ZERO-match track writes no edge, so the "no edge yet" anti-join alone would re-chew it every tick
// forever. The `tracks.artist_edges_backfilled_at` stamp retires EVERY visited track — matched,
// partial, OR zero — so the worklist drains to empty and a re-run is a cheap no-op (the
// `mb_recording_id_attempted_at` discipline). It is a `tracks` write, so it moves no finding lastmod.
//
// NO VENDOR CALL anywhere — pure DB matching — so batches are generous (`MAX_BATCH` 200) and history
// drains in a handful of ticks. The box cron's `--limit` default EQUALS `MAX_BATCH`, so the CLI's
// cursor loop fires exactly ONE HTTP request per tick.

import { getDb, typedRows } from "./db";
import { parseArtistsJson } from "./artists";
import { fold } from "./track-match";

// One bounded pass visits at most this many un-backfilled tracks. Pure DB matching (no vendor call),
// so a generous batch drains the ~25k-row history in a handful of ticks. The box cron's `--limit`
// default is pinned to THIS number so the CLI loop fires one request per tick (never a second).
export const MAX_BATCH = 200;

// Multi-row `insert or ignore` chunk — triples per statement. 100 triples = 300 bound args, well
// under libSQL's per-statement variable ceiling.
const INSERT_CHUNK = 100;

// `update … where track_id in (…)` chunk — track ids per stamp statement. 200 ids + 1 (the stamp
// value) = 201 bound args, comfortably under the ceiling.
const STAMP_CHUNK = 200;

/** The report a single pass returns — the honest residual is what decides a future MB-credit sweep. */
export type ArtistEdgesBackfillResult = {
  dryRun: boolean;
  // `track_artists` edges written this pass (in a dry run, the count that WOULD be written).
  edgesWritten: number;
  // Track ids where EVERY credited name matched an existing identity.
  fullyMatched: string[];
  fullyMatchedCount: number;
  // The track-id cursor to resume from, or null once the worklist is drained.
  nextCursor: string | null;
  ok: boolean;
  // Track ids where SOME names matched and some did not (their unmatched names feed the residual).
  partiallyMatched: string[];
  partiallyMatchedCount: number;
  // Tracks VISITED this pass (fully + partially + zero). The CLI loop's cap unit — with the sweep's
  // `--limit` pinned to `MAX_BATCH`, a full page equals the limit and the loop stops after one call.
  scanned: number;
  // Total credited names across the batch that matched NO identity — the residual a future paced
  // MusicBrainz credit-sweep would mint from (RFC).
  unmatchedNames: number;
  // Track ids where NO credited name matched an identity.
  zeroMatched: string[];
  zeroMatchedCount: number;
};

/** The outcome of matching one track's credited names against the fold map. */
export type TrackNameMatch = {
  // One edge per DISTINCT matched artist, carrying its 1-based array position (first = lead).
  edges: Array<{ artistId: string; position: number }>;
  // How many credited (non-empty) names resolved to an identity.
  matchedNames: number;
  // How many credited (non-empty) names the track carried.
  totalNames: number;
};

/**
 * Build the fold → artist_id map from the WHOLE artist + alias corpus in one pass (set-based; no
 * per-name query). A primary `artists.name` claims a fold first; an alias fills only a fold no
 * primary owns. A fold two DISTINCT identities share is ambiguous and matches nothing (fail-closed),
 * whether the collision is name↔name or alias↔alias. Aliases are pre-filtered by the caller to the
 * trusted set (`kind='name'`, `status in ('auto','confirmed')`) — the search resolver's semantics.
 */
export function buildArtistFoldMap(
  artists: ReadonlyArray<{ id: string; name: string }>,
  aliases: ReadonlyArray<{ alias: string; artist_id: string }>,
): Map<string, string> {
  const byFold = new Map<string, string>();
  const primaryKeys = new Set<string>();
  const ambiguous = new Set<string>();

  // Primary names first — a real name always wins its fold.
  for (const artist of artists) {
    const key = fold(artist.name);

    if (!key || ambiguous.has(key)) {
      continue;
    }

    const existing = byFold.get(key);

    if (existing === undefined) {
      byFold.set(key, artist.id);
      primaryKeys.add(key);
    } else if (existing !== artist.id) {
      // Two distinct identities share this fold — a bare name can't choose. Fail closed.
      byFold.delete(key);
      primaryKeys.delete(key);
      ambiguous.add(key);
    }
  }

  // Aliases fill only the folds no primary name owns, and never un-ambiguate one.
  for (const { alias, artist_id: artistId } of aliases) {
    const key = fold(alias);

    if (!key || ambiguous.has(key) || primaryKeys.has(key)) {
      continue;
    }

    const existing = byFold.get(key);

    if (existing === undefined) {
      byFold.set(key, artistId);
    } else if (existing !== artistId) {
      byFold.delete(key);
      ambiguous.add(key);
    }
  }

  return byFold;
}

/**
 * Match one track's credited names against the fold map. Empty names are skipped (they count toward
 * neither total nor matched). A single artist credited twice yields ONE edge (the natural key
 * dedupes anyway); the position is the 1-based index of that artist's FIRST occurrence.
 */
export function matchTrackNames(names: string[], foldMap: Map<string, string>): TrackNameMatch {
  const edges: Array<{ artistId: string; position: number }> = [];
  const seen = new Set<string>();
  let totalNames = 0;
  let matchedNames = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];

    if (typeof name !== "string" || name.trim() === "") {
      continue;
    }

    totalNames += 1;

    const artistId = foldMap.get(fold(name));

    if (artistId === undefined) {
      continue;
    }

    matchedNames += 1;

    if (seen.has(artistId)) {
      continue;
    }

    seen.add(artistId);
    edges.push({ artistId, position: i + 1 });
  }

  return { edges, matchedNames, totalNames };
}

// ── DB layer ─────────────────────────────────────────────────────────────────────────────────────

type WorkRow = { artists_json: string; track_id: string };

/** One bounded page of the worklist: tracks with NO `track_artists` edge, not yet backfill-stamped,
 *  track-id cursored. Rides `tracks_artist_edges_backfill_queue_idx` for the ordered candidate walk;
 *  the anti-join rides `track_artists_track_id_idx`. */
async function listWork(
  db: Awaited<ReturnType<typeof getDb>>,
  limit: number,
  cursor: string | undefined,
): Promise<WorkRow[]> {
  const result = await db.execute({
    args: cursor ? [cursor, limit] : [limit],
    sql: cursor
      ? `select t.track_id, t.artists_json
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is null
           and t.track_id > ?
         order by t.track_id asc
         limit ?`
      : `select t.track_id, t.artists_json
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is null
         order by t.track_id asc
         limit ?`,
  });

  return typedRows<WorkRow>(result.rows);
}

/** Load the full `artists` name corpus (id + canonical name) for the fold map — one bounded read. */
async function loadArtists(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<Array<{ id: string; name: string }>> {
  const result = await db.execute({ args: [], sql: `select id, name from artists` });

  return typedRows<{ id: string; name: string }>(result.rows);
}

/** Load the TRUSTED alias corpus — real-name AKAs only (`kind='name'`, `status in
 *  ('auto','confirmed')`), the search resolver's alias semantics. One bounded read. */
async function loadAliases(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<Array<{ alias: string; artist_id: string }>> {
  const result = await db.execute({
    args: [],
    sql: `select artist_id, alias from artist_aliases
          where kind = 'name' and status in ('auto', 'confirmed')`,
  });

  return typedRows<{ alias: string; artist_id: string }>(result.rows);
}

/** Write the batch's edges `insert or ignore`, chunked. Returns the summed rows actually inserted. */
async function insertEdges(
  db: Awaited<ReturnType<typeof getDb>>,
  tuples: ReadonlyArray<[string, string, number]>,
): Promise<number> {
  let affected = 0;

  for (let i = 0; i < tuples.length; i += INSERT_CHUNK) {
    const chunk = tuples.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?)").join(", ");
    const result = await db.execute({
      args: chunk.flat(),
      sql: `insert or ignore into track_artists (track_id, artist_id, position) values ${values}`,
    });

    affected += result.rowsAffected;
  }

  return affected;
}

/** Stamp every visited track's `artist_edges_backfilled_at` so it drains the worklist, chunked. */
async function stampVisited(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: ReadonlyArray<string>,
): Promise<void> {
  const now = new Date().toISOString();

  for (let i = 0; i < trackIds.length; i += STAMP_CHUNK) {
    const chunk = trackIds.slice(i, i + STAMP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");

    await db.execute({
      args: [now, ...chunk],
      sql: `update tracks set artist_edges_backfilled_at = ?
            where track_id in (${placeholders})`,
    });
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One bounded, idempotent pass of the track_artists graph backfill. Reads a page of un-backfilled,
 * edge-less tracks; folds the whole artist + alias corpus into one map; matches each track's names;
 * writes the matched edges `insert or ignore`; and stamps EVERY visited track so it drains. A dry run
 * reports the same classification without any write. `nextCursor` resumes the scan when a full page
 * came back (more to drain); null once exhausted.
 */
export async function resolveArtistEdges(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistEdgesBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));

  const rows = await listWork(db, batchLimit, cursor);

  const fullyMatched: string[] = [];
  const partiallyMatched: string[] = [];
  const zeroMatched: string[] = [];
  let unmatchedNames = 0;

  if (rows.length === 0) {
    return {
      dryRun,
      edgesWritten: 0,
      fullyMatched,
      fullyMatchedCount: 0,
      nextCursor: null,
      ok: true,
      partiallyMatched,
      partiallyMatchedCount: 0,
      scanned: 0,
      unmatchedNames: 0,
      zeroMatched,
      zeroMatchedCount: 0,
    };
  }

  // Build the fold map once for the whole batch (set-based; no per-name query).
  const [artists, aliases] = await Promise.all([loadArtists(db), loadAliases(db)]);
  const foldMap = buildArtistFoldMap(artists, aliases);

  const tuples: Array<[string, string, number]> = [];
  const visited: string[] = [];

  for (const row of rows) {
    visited.push(row.track_id);

    const match = matchTrackNames(parseArtistsJson(row.artists_json), foldMap);
    unmatchedNames += match.totalNames - match.matchedNames;

    for (const edge of match.edges) {
      tuples.push([row.track_id, edge.artistId, edge.position]);
    }

    if (match.matchedNames === 0) {
      zeroMatched.push(row.track_id);
    } else if (match.matchedNames === match.totalNames) {
      fullyMatched.push(row.track_id);
    } else {
      partiallyMatched.push(row.track_id);
    }
  }

  // A dry run reports the edges it WOULD write (the tuple count); a wet run reports the rows the
  // `insert or ignore` actually landed (identical here, since the worklist holds only edge-less
  // tracks, but reported from the write for honesty).
  let edgesWritten = tuples.length;

  if (!dryRun) {
    edgesWritten = await insertEdges(db, tuples);
    await stampVisited(db, visited);
  }

  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rows.length < batchLimit ? null : lastTrackId;

  return {
    dryRun,
    edgesWritten,
    fullyMatched,
    fullyMatchedCount: fullyMatched.length,
    nextCursor,
    ok: true,
    partiallyMatched,
    partiallyMatchedCount: partiallyMatched.length,
    scanned: rows.length,
    unmatchedNames,
    zeroMatched,
    zeroMatchedCount: zeroMatched.length,
  };
}

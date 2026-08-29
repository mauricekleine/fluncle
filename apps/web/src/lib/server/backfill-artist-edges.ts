// The track_artists graph backfill — fold `tracks.artists_json` names onto EXISTING artist
// identities (RFC artist-primary-capture, slice 0).
//
// ── THE GAP ────────────────────────────────────────────────────────────────────────────────────
// The `track_artists` graph is crawl-era-only: only ~12.3k of ~37.5k tracks carry
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
import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceStatements,
} from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { parseArtistsJson } from "./artists";
import { restaleCatalogueRankStatements } from "./catalogue-rank-restale";
import { hubCountArtistEdgeStatements } from "./hub-counts";
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
  // Authoritative rows still in the worklist after this pass.
  queueDepth: number;
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
 * The EXACT spellings an IDENTITY-CLAIMED artist answers to, keyed by fold — the punctuation half of
 * the conflation seal (artists.ts § THE HOMONYM SEAL is the identity half).
 *
 * `fold()` collapses punctuation and diacritics, so `"K."` and `"K"` fold to the same key. That is
 * the right latitude for a row nobody has identified yet, and the wrong latitude for one that
 * carries an `mbid`: an MB artist id is a curated identity, and quietly attaching a DIFFERENTLY
 * SPELLED credit to it merges two acts. In the J-pop/drum & bass namesake case, the act credited `"K."`
 * had 23 tracks folded onto the Audio Couture / Subtitles drum & bass act `"K"` this exact way.
 *
 * So for a row with an `mbid`, this map holds the spellings it may still be matched on — its own
 * name plus its trusted aliases, lowercased — and `matchTrackNames` refuses anything else. A row
 * with NO mbid is absent from this map entirely and keeps the historical fold latitude, because
 * there is no identity there to protect and the fold is all the signal that exists.
 */
export function buildIdentityClaimedNames(
  artists: ReadonlyArray<{ id: string; mbid?: null | string; name: string }>,
  aliases: ReadonlyArray<{ alias: string; artist_id: string }>,
): Map<string, Set<string>> {
  const claimed = new Set(
    artists.filter((artist) => Boolean(artist.mbid)).map((artist) => artist.id),
  );
  const byFold = new Map<string, Set<string>>();
  const add = (id: string, spelling: string) => {
    const key = fold(spelling);

    if (!key || !claimed.has(id)) {
      return;
    }

    getOrAdd(byFold, key).add(spelling.toLowerCase());
  };

  for (const artist of artists) {
    add(artist.id, artist.name);
  }

  for (const { alias, artist_id: artistId } of aliases) {
    add(artistId, alias);
  }

  return byFold;
}

/** Get a set entry, creating it when absent. Avoids a non-null assertion. */
function getOrAdd(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);

  if (set === undefined) {
    set = new Set<string>();
    map.set(key, set);
  }

  return set;
}

/**
 * Match one track's credited names against the fold map. Empty names are skipped (they count toward
 * neither total nor matched). A single artist credited twice yields ONE edge (the natural key
 * dedupes anyway); the position is the 1-based index of that artist's FIRST occurrence.
 *
 * `identityClaimedNames` (optional — omitted, behaviour is exactly the historical fold) applies the
 * spelling rail above: when the fold lands on an artist that has claimed an MB identity, the credit
 * must be one of that artist's real spellings, not merely something that folds to it.
 */
export function matchTrackNames(
  names: string[],
  foldMap: Map<string, string>,
  identityClaimedNames?: ReadonlyMap<string, ReadonlySet<string>>,
): TrackNameMatch {
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

    const key = fold(name);
    const artistId = foldMap.get(key);

    if (artistId === undefined) {
      continue;
    }

    // The spelling rail: an identity-claimed fold answers only to its own spellings. A near-miss is
    // NOT a match, so it counts toward the unmatched residual and can reach the mbid-keyed credit
    // sweep, which is the path allowed to decide it is a separate artist and mint one.
    const spellings = identityClaimedNames?.get(key);

    if (spellings && !spellings.has(name.toLowerCase())) {
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

type WorkRow = {
  artists_json: string;
  /** Keystone 1's catalogue discriminator — `0` means the track HAS a findings row (certified). */
  is_catalogue?: bigint | number;
  /** The mix projection contribution carried beside the edge candidate. */
  is_rankable?: bigint | number;
  track_id: string;
};

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
      ? `select t.track_id, t.artists_json, t.is_catalogue,
                t.key is not null and t.has_embedding = 1 as is_rankable
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is null
           and t.track_id > ?
         order by t.track_id asc
         limit ?`
      : `select t.track_id, t.artists_json, t.is_catalogue,
                t.key is not null and t.has_embedding = 1 as is_rankable
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is null
         order by t.track_id asc
         limit ?`,
  });

  return typedRows<WorkRow>(result.rows);
}

async function hydrateProjectedWork(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<WorkRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_id, artists_json, is_catalogue,
                 key is not null and has_embedding = 1 as is_rankable
          from tracks
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
  const byId = new Map(typedRows<WorkRow>(result.rows).map((row) => [row.track_id, row]));

  return trackIds.flatMap((trackId) => {
    const row = byId.get(trackId);
    return row === undefined ? [] : [row];
  });
}

/**
 * Authoritative remaining work after a pass. The candidate predicate rides
 * `tracks_artist_edges_backfill_queue_idx`; the anti-join probes
 * `track_artists_track_id_idx`. Both are existing btrees, so this gauge does not turn the hourly
 * tick into a table scan.
 */
export const ARTIST_EDGES_QUEUE_DEPTH_SQL = `select count(*) as queued
          from tracks t
          where t.artist_edges_backfilled_at is null
            and not exists (
              select 1 from track_artists ta where ta.track_id = t.track_id
            )`;

async function countWork(db: Awaited<ReturnType<typeof getDb>>): Promise<number> {
  const result = await db.execute({
    args: [],
    sql: ARTIST_EDGES_QUEUE_DEPTH_SQL,
  });
  const row = typedRows<{ queued: bigint | number }>(result.rows)[0];

  return Number(row?.queued ?? 0);
}

/** Load the full `artists` name corpus (id + canonical name) for the fold map — one bounded read. */
async function loadArtists(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<Array<{ id: string; mbid: null | string; name: string }>> {
  // `mbid` rides along for the spelling rail (`buildIdentityClaimedNames`) — same one bounded read.
  const result = await db.execute({ args: [], sql: `select id, name, mbid from artists` });

  return typedRows<{ id: string; mbid: null | string; name: string }>(result.rows);
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

/**
 * Write the batch's edges `insert or ignore`, chunked. Returns the summed rows actually inserted.
 *
 * Each chunk carries the maintained artists hub-count deltas (keystone 2) in its own batch, so a new
 * edge and the count that mirrors it can never half-apply. The per-artist attribution needs no
 * pre-read here — this sweep's worklist selects ONLY edge-less tracks (`ta.track_id is null`, see
 * `listWork`), and `matchTrackNames` already folds a doubly-credited artist to one edge, so every
 * tuple IS a new edge. `certifiedTracks` carries keystone 1's flag off the worklist row, so the
 * certified half costs nothing either. See lib/server/hub-counts.ts.
 */
async function insertEdges(
  db: Awaited<ReturnType<typeof getDb>>,
  tuples: ReadonlyArray<[string, string, number]>,
  certifiedTracks: ReadonlySet<string>,
  rankableTracks: ReadonlySet<string>,
): Promise<number> {
  let affected = 0;

  for (let i = 0; i < tuples.length; i += INSERT_CHUNK) {
    const chunk = tuples.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?)").join(", ");
    const results = await db.batch(
      [
        {
          args: chunk.flat(),
          sql: `insert or ignore into track_artists (track_id, artist_id, position) values ${values}`,
        },
        ...hubCountArtistEdgeStatements(
          chunk.map(([trackId, artistId]) => ({
            artistId,
            certified: certifiedTracks.has(trackId),
            rankable: rankableTracks.has(trackId),
            trackId,
          })),
        ),
        // Every tuple is a NEW edge (the worklist selects edge-less tracks), so each catalogue row
        // in the chunk just gained the artist graph the capture gate reads — re-stale it for the
        // next `rank_catalogue` tick, atomically with the edge write (catalogue-rank-restale.ts).
        ...restaleCatalogueRankStatements(chunk.map(([trackId]) => trackId)),
        ...markDueWorkSourceMaintenanceStatements(
          [
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track" as const,
            },
            ...chunk.map(([trackId]) => ({ subjectId: trackId, subjectType: "track" as const })),
            ...chunk.map(([, artistId]) => ({
              subjectId: artistId,
              subjectType: "artist" as const,
            })),
          ],
          { producer: "artist-edge-backfill" },
        ),
      ],
      "write",
    );

    affected += results[0]?.rowsAffected ?? 0;
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

    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [now, ...chunk],
          sql: `update tracks set artist_edges_backfilled_at = ?
                where track_id in (${placeholders})`,
        },
      ],
      chunk.map((subjectId) => ({ subjectId, subjectType: "track" })),
      { producer: "artist-edge-backfill-stamp" },
    );
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
  const dueWorkCutoverEnabled = await isDueWorkCutoverEnabled();
  let rows: WorkRow[];

  if (dueWorkCutoverEnabled) {
    const page = await readPromotedDueWorkPage(db, "artist-edges", {
      continuation: cursor
        ? {
            sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
            subjectId: cursor,
          }
        : undefined,
      limit: batchLimit,
    });
    rows = await hydrateProjectedWork(db, page.subjectIds);
  } else {
    // GOAL H: delete the unchanged source-table selector after the default-off cutover is proven.
    rows = await listWork(db, batchLimit, cursor);
  }

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
      queueDepth: await countWork(db),
      scanned: 0,
      unmatchedNames: 0,
      zeroMatched,
      zeroMatchedCount: 0,
    };
  }

  // Build the fold map once for the whole batch (set-based; no per-name query).
  const [artists, aliases] = await Promise.all([loadArtists(db), loadAliases(db)]);
  const foldMap = buildArtistFoldMap(artists, aliases);
  const identityClaimedNames = buildIdentityClaimedNames(artists, aliases);

  const tuples: Array<[string, string, number]> = [];
  const visited: string[] = [];
  // Which of the batch's tracks are CERTIFIED — read straight off the worklist row (keystone 1's
  // `is_catalogue`), so the hub-count deltas the insert carries need no extra query.
  const certifiedTracks = new Set<string>();
  const rankableTracks = new Set<string>();

  for (const row of rows) {
    visited.push(row.track_id);

    if (row.is_catalogue !== undefined && Number(row.is_catalogue) === 0) {
      certifiedTracks.add(row.track_id);
    }

    if (row.is_rankable !== undefined && Number(row.is_rankable) === 1) {
      rankableTracks.add(row.track_id);
    }

    const match = matchTrackNames(
      parseArtistsJson(row.artists_json),
      foldMap,
      identityClaimedNames,
    );
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
    edgesWritten = await insertEdges(db, tuples, certifiedTracks, rankableTracks);
    await stampVisited(db, visited);
  }

  const queueDepth = await countWork(db);
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
    queueDepth,
    scanned: rows.length,
    unmatchedNames,
    zeroMatched,
    zeroMatchedCount: zeroMatched.length,
  };
}

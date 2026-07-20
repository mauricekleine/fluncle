// The MB CREDIT SWEEP — complete the artist graph for slice 0's zero-matched residual (RFC
// artist-primary-capture, slice 1b).
//
// ── THE GAP SLICE 0 LEFT ─────────────────────────────────────────────────────────────────────────
// Slice 0 (`backfill-artist-edges.ts`) folded each edge-less track's `artists_json` NAMES onto
// EXISTING `artists` identities, and stamped EVERY visited track. What it could not do was MINT: a
// bare name is not enough identity to create an entity, so a track whose credited names matched NO
// existing identity got the stamp but NO edge — the ~14.3k ZERO-MATCHED residual. That residual is
// exactly the tracks capture-authorization (slice 1) cannot reason about, because authorization
// matches BY IDENTITY through the `track_artists` graph.
//
// ── THE THREE-RUNG RESOLVE (mbid → ADOPT → mint) ─────────────────────────────────────────────────
// A zero-matched track that carries a MusicBrainz RECORDING identity — `tracks.mb_recording_id`, or
// the `mb_<recording-mbid>` PK a crawler-born row carries (BOTH checked, via the shared
// `recordingMbidFromTrackId`) — is resolved by ONE paced `/recording/<mbid>?inc=artist-credits` lookup
// through the shared MB client, which names its credited artists WITH their real MB artist ids. Each
// credited artist resolves down a THREE-RUNG ladder, and the middle rung is the whole reason this is
// safe:
//   1. EXACT mbid — an `artists` row already carries this MB artist id → use it.
//   2. ADOPT — the credit NAME folds UNAMBIGUOUSLY onto an existing artist that has NO mbid yet.
//      This is the common case and the trap: the zero-matched residual is dominated by COMPOUND
//      credit strings ("Sub Focus & Dimension" as one `artists_json` entry) whose real MB credits
//      resolve to artists Fluncle ALREADY holds as Spotify-keyed rows (mbid still NULL) — slice 0
//      just could not match the compound string. Minting here would spawn a DUPLICATE per such credit,
//      a mass generator of the split-identity class (the one the label-merge op cleans for labels —
//      artists have NO merge op at all). So instead we ADOPT: stamp the mbid onto that existing row
//      (`coalesce`, the artist-resolution precedent) and reuse it. The fold is the slice-0 matcher
//      (`buildArtistFoldMap` + `artist_aliases`), reused wholesale, built ONCE per pass.
//   3. MINT — no mbid match and no unambiguous adoptable fold → mint a fresh `artists` row keyed on
//      the MB artist id (`mintArtistByMbid`). An MB artist id IS identity (a curated, dereferenceable
//      MBID), so a row born from one is honest — the licence slice 0 lacked.
// Fail-closed at every ambiguity: a fold two distinct identities share, OR a fold match whose row
// already carries a DIFFERENT mbid, drops through to MINT — because a wrong MERGE of two artists is
// unrecoverable (no merge op), whereas a rare SPLIT is. Then the `track_artists` edges are written
// `insert or ignore` (position from credit order, role null — the slice-0 edge shape). A zero-matched
// track with NO MB identity is TERMINALLY SKIPPED: stamped so it drains, never retried.
//
// ── RELIABILITY: an OWN stamp, slice 0's untouched ───────────────────────────────────────────────
// The per-row stamp is `tracks.artist_credits_backfilled_at` — DISTINCT from slice 0's
// `artist_edges_backfilled_at`, which this sweep never writes or re-nulls (slice 0's semantics stay
// exactly as shipped). Every visited row is stamped — one that gained edges AND one skipped for no
// identity — so the worklist drains and a re-run is a cheap no-op (the `mb_recording_id_attempted_at`
// discipline). It is a `tracks` write, so it moves no finding lastmod.
//
// ── WORKER-PACED + BUDGETED (this one makes VENDOR calls) ────────────────────────────────────────
// Unlike slice 0 (pure DB matching), each worklist row is one paced ~1.1s MusicBrainz call, so the
// batch is SMALL (`MAX_BATCH` 40 ≈ one tick under a minute worst-case) and the pass carries the
// label-lineage protections: a 60s wall-clock RESPONSE BUDGET (stop mid-page, resume cursor, unhandled
// rows unstamped) and the `rateLimited` CIRCUIT BREAKER (stop the pass without stamping the throttled
// row). The box cron's `--limit` default EQUALS `MAX_BATCH`, so a full page meets the cap and the CLI
// loop fires one request per tick (a budget pause resumes with a fresh budget on the next request).

import { getDb, typedRows } from "./db";
import { adoptArtistMbid, mintArtistByMbid } from "./artists";
import { buildArtistFoldMap } from "./backfill-artist-edges";
import { fold } from "./track-match";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";
import { recordingMbidFromTrackId } from "./recording-mbids";

// One bounded pass visits at most this many worklist rows. Each is one paced ~1.1s MusicBrainz call
// (plus a mint/match), so 40 ≈ under a minute normally — comfortably inside the Worker/gateway request
// budget, and the box cron's `--limit` default is pinned to THIS number so the CLI loop fires one
// request per tick. The ~14.3k residual drains at 40/tick over ~a day and a half of a 5-minute cron.
export const MAX_BATCH = 40;

// Wall-clock response budget for one pass. `mbFetch`'s serializer is ONE shared chain per isolate, so
// under cross-sweep contention (the crawler, recording-mbids, the label sweeps) each call can queue
// for minutes behind another sweep's backlog — long enough to push a full batch past the box CLI's
// fetch timeout while the walk keeps running server-side. Spending the budget is a pause, not a
// failure: the pass returns what it handled with a resume cursor, and the CLI issues a fresh request
// (with a fresh budget) for the rest. The label-lineage discipline, verbatim.
const RESPONSE_BUDGET_MS = 60_000;

// The MusicBrainz special-purpose "Various Artists" credit — a compilation placeholder, not a real
// artist. Never minted or edged (the crawler's `expandRelease` excludes the same MBID).
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

/** The report a single pass returns. */
export type ArtistCreditsBackfillResult = {
  dryRun: boolean;
  // Worklist rows VISITED this pass (edged + skipped). The CLI loop's cap unit — with the sweep's
  // `--limit` pinned to `MAX_BATCH`, a full page equals the limit and the loop stops after one call.
  scanned: number;
  // NEW `artists` rows minted by MB artist id this pass (identity-true; a real MBID backs each).
  mintedArtists: number;
  // Credited artists that matched an EXISTING `artists` row by exact `mbid` this pass.
  matchedArtists: number;
  // EXISTING artists that had no mbid and gained one this pass via an unambiguous name fold (the
  // duplicate-prevention rung — a Spotify-keyed row slice 0 could not match, now MB-identified).
  adoptedArtists: number;
  // `track_artists` edges written this pass (or, in a dry run, the count that WOULD be written).
  edgesWritten: number;
  // Zero-matched rows carrying NO MB recording identity — terminally skipped (stamped, never retried).
  skippedNoIdentity: number;
  // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — the CLI stops looping
  // the cursor and the next tick resumes with a fresh window.
  rateLimited: boolean;
  // The track-id cursor to resume from, or null once the worklist is drained (or a throttle-stop).
  nextCursor: string | null;
  ok: true;
};

// ── MusicBrainz recording → artist-credits ───────────────────────────────────────────────────────

type MbArtistCredit = { artist?: { id?: string; name?: string }; name?: string };
type MbRecordingCredits = { "artist-credit"?: MbArtistCredit[] };

/** One credited artist resolved to an identity, carrying its 1-based credit position. */
type CreditEdge = { artistId: string; position: number };

/** One recording resolve's outcome. The no-identity SKIP is handled inline (before any vendor call),
 *  so it is not one of these — a resolved recording either yields edges or hits the throttle wall. */
type ResolveOutcome =
  | { kind: "edged"; edges: CreditEdge[]; minted: number; matched: number; adopted: number }
  | { kind: "rate-limited" };

/** How one credited artist resolved down the mbid → ADOPT → mint ladder. */
type CreditResolution = { artistId: string; outcome: "matched" | "adopted" | "minted" };
type CreditResolver = (name: string, mbid: string) => Promise<CreditResolution>;

/**
 * Build the per-pass credit resolver ONCE from the whole `artists` + trusted-alias corpus (the slice-0
 * set-based discipline — the fold map is built once, never per credit). It holds three in-memory maps,
 * kept consistent as it adopts/mints so within-pass repeats resolve to the SAME row:
 *   - `foldMap` (fold → artistId): the slice-0 matcher `buildArtistFoldMap`, reused wholesale — a fold
 *     two distinct identities share is dropped (ambiguous), so a hit is unambiguous by construction.
 *   - `mbidToArtistId` (mbid → artistId): rung 1's exact-mbid seek, in memory (no per-credit query).
 *   - `mbidByArtistId` (artistId → mbid|null): the ADOPT decision reads it — a folded row with no mbid
 *     is adopted; one already carrying a DIFFERENT mbid is a homonym and falls through to MINT.
 */
function createCreditResolver(
  corpus: ReadonlyArray<{ id: string; mbid: string | null; name: string }>,
  aliases: ReadonlyArray<{ alias: string; artist_id: string }>,
): CreditResolver {
  const foldMap = buildArtistFoldMap(corpus, aliases);
  const mbidByArtistId = new Map<string, string | null>();
  const mbidToArtistId = new Map<string, string>();

  for (const artist of corpus) {
    mbidByArtistId.set(artist.id, artist.mbid);

    if (artist.mbid) {
      mbidToArtistId.set(artist.mbid, artist.id);
    }
  }

  return async (name, mbid) => {
    // Rung 1: an existing row already carries this exact MB artist id.
    const byMbid = mbidToArtistId.get(mbid);

    if (byMbid !== undefined) {
      return { artistId: byMbid, outcome: "matched" };
    }

    // Rung 2: ADOPT — the name folds UNAMBIGUOUSLY onto an existing artist that has NO mbid yet. A
    // folded row already carrying a DIFFERENT mbid (rung 1 would have caught a SAME one) is a homonym,
    // so it is NOT adopted — it falls through to mint (fail closed: a wrong merge is unrecoverable).
    const foldedId = foldMap.get(fold(name));

    if (foldedId !== undefined && (mbidByArtistId.get(foldedId) ?? null) === null) {
      await adoptArtistMbid(foldedId, mbid);
      mbidByArtistId.set(foldedId, mbid);
      mbidToArtistId.set(mbid, foldedId);

      return { artistId: foldedId, outcome: "adopted" };
    }

    // Rung 3: MINT a fresh identity-true row (no mbid match, no adoptable fold).
    const newId = await mintArtistByMbid(name, mbid);
    mbidByArtistId.set(newId, mbid);
    mbidToArtistId.set(mbid, newId);

    return { artistId: newId, outcome: "minted" };
  };
}

/**
 * Fetch one recording's artist-credits and resolve each credited artist down the mbid → ADOPT → mint
 * ladder (via `resolve`). Dedupes to ONE edge per distinct artist (the 1-based position of its FIRST
 * occurrence, the `matchTrackNames` rule); the natural key would dedupe anyway. Skips the
 * Various-Artists placeholder and any credit with no artist MBID or no name. Returns `rate-limited`
 * when MusicBrainz is actively throttling so the pass can circuit-break.
 */
async function resolveRecordingCredits(
  mbid: string,
  resolve: CreditResolver,
): Promise<ResolveOutcome> {
  const { data, rateLimited } = await mbFetch<MbRecordingCredits>(
    `/recording/${encodeURIComponent(mbid)}?inc=artist-credits`,
  );

  if (rateLimited) {
    return { kind: "rate-limited" };
  }

  // A clean no-match (404 / an empty result / a swallowed error) is a terminal outcome, NOT a skip
  // for missing identity: the row HAD a recording id, MusicBrainz just returned no usable credit. It
  // gains no edge and is stamped so it drains — reported as an `edged` outcome with zero edges.
  const credits = data?.["artist-credit"] ?? [];

  const edges: CreditEdge[] = [];
  const seen = new Set<string>();
  let minted = 0;
  let matched = 0;
  let adopted = 0;

  for (let i = 0; i < credits.length; i++) {
    const credit = credits[i];
    const artistMbid = credit?.artist?.id;
    const artistName = credit?.artist?.name ?? credit?.name;

    if (!artistMbid || artistMbid === VARIOUS_ARTISTS_MBID || !artistName) {
      continue;
    }

    const { artistId, outcome } = await resolve(artistName, artistMbid);

    if (outcome === "minted") {
      minted += 1;
    } else if (outcome === "adopted") {
      adopted += 1;
    } else {
      matched += 1;
    }

    if (seen.has(artistId)) {
      continue;
    }

    seen.add(artistId);
    edges.push({ artistId, position: i + 1 });
  }

  return { adopted, edges, kind: "edged", matched, minted };
}

// ── DB layer ─────────────────────────────────────────────────────────────────────────────────────

type WorkRow = { mb_recording_id: string | null; track_id: string };

/** Load the whole `artists` corpus (id + canonical name + mbid) for the per-pass resolver — one
 *  bounded read, the slice-0 `loadArtists` shape plus the `mbid` the ADOPT/exact-mbid rungs need. */
async function loadArtistCorpus(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<Array<{ id: string; mbid: string | null; name: string }>> {
  const result = await db.execute({ args: [], sql: `select id, name, mbid from artists` });

  return typedRows<{ id: string; mbid: string | null; name: string }>(result.rows);
}

/** Load the TRUSTED alias corpus — real-name AKAs only (`kind='name'`, `status in ('auto',
 *  'confirmed')`), the slice-0 / search-resolver alias semantics, reused verbatim. One bounded read. */
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
 * One bounded page of the worklist: slice 0's ZERO-MATCHED residual not yet visited by THIS sweep —
 * a track with NO `track_artists` edge (the anti-join), slice-0-stamped (`artist_edges_backfilled_at
 * is not null`, so it is genuinely zero-MATCHED, not merely un-attempted), and not yet credit-swept
 * (`artist_credits_backfilled_at is null`). Track-id cursored. Rides
 * `tracks_artist_credits_backfill_queue_idx` for the ordered candidate walk; the anti-join rides
 * `track_artists_track_id_idx`. It carries `mb_recording_id` so the pass reads the identity without a
 * second query — the `mb_` PK prefix is the fallback the code derives per row.
 */
async function listWork(
  db: Awaited<ReturnType<typeof getDb>>,
  limit: number,
  cursor: string | undefined,
): Promise<WorkRow[]> {
  const result = await db.execute({
    args: cursor ? [cursor, limit] : [limit],
    sql: cursor
      ? `select t.track_id, t.mb_recording_id
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is not null
           and t.artist_credits_backfilled_at is null
           and t.track_id > ?
         order by t.track_id asc
         limit ?`
      : `select t.track_id, t.mb_recording_id
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is not null
           and t.artist_credits_backfilled_at is null
         order by t.track_id asc
         limit ?`,
  });

  return typedRows<WorkRow>(result.rows);
}

/** Write one track's edges `insert or ignore` on the natural key `(track_id, artist_id)`. */
async function insertEdges(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  edges: ReadonlyArray<CreditEdge>,
): Promise<number> {
  if (edges.length === 0) {
    return 0;
  }

  const values = edges.map(() => "(?, ?, ?)").join(", ");
  const args = edges.flatMap((edge) => [trackId, edge.artistId, edge.position]);

  const result = await db.execute({
    args,
    sql: `insert or ignore into track_artists (track_id, artist_id, position) values ${values}`,
  });

  return result.rowsAffected;
}

/** Stamp one visited track's `artist_credits_backfilled_at` so it drains the worklist. */
async function stampVisited(db: Awaited<ReturnType<typeof getDb>>, trackId: string): Promise<void> {
  await db.execute({
    args: [new Date().toISOString(), trackId],
    sql: `update tracks set artist_credits_backfilled_at = ? where track_id = ?`,
  });
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One bounded, idempotent pass of the MB credit sweep. Reads a page of slice 0's zero-matched residual;
 * for each row derives its MB recording identity (`mb_recording_id` or the `mb_` PK prefix), resolves
 * the recording's credits, mints/matches artists by MB id, writes the edges, and stamps EVERY visited
 * row so it drains. A dry run reports the eligible worklist without any vendor call or write. Stops
 * early on a MusicBrainz throttle (circuit breaker, `rateLimited: true`, null cursor) or when the 60s
 * response budget is spent (a pause — the unhandled tail resumes from the last handled row's cursor).
 */
export async function resolveArtistCredits(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistCreditsBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const rows = await listWork(db, batchLimit, cursor);

  let scanned = 0;
  let mintedArtists = 0;
  let matchedArtists = 0;
  let adoptedArtists = 0;
  let edgesWritten = 0;
  let skippedNoIdentity = 0;
  let rateLimited = false;
  let budgetPaused = false;
  let lastHandledTrackId: string | null = null;
  const deadline = Date.now() + RESPONSE_BUDGET_MS;

  if (dryRun) {
    // Report the eligible worklist without a vendor call or write — `scanned` is the page it WOULD
    // work; the mint/adopt/match/edge counts are unknowable without the vendor calls, so they stay zero.
    return {
      adoptedArtists: 0,
      dryRun,
      edgesWritten: 0,
      matchedArtists: 0,
      mintedArtists: 0,
      nextCursor: rows.length < batchLimit ? null : (rows.at(-1)?.track_id ?? null),
      ok: true,
      rateLimited: false,
      scanned: rows.length,
      skippedNoIdentity: 0,
    };
  }

  if (rows.length === 0) {
    // A drained tick stays a single-query no-op — no corpus read, no resolver built.
    return {
      adoptedArtists: 0,
      dryRun,
      edgesWritten: 0,
      matchedArtists: 0,
      mintedArtists: 0,
      nextCursor: null,
      ok: true,
      rateLimited: false,
      scanned: 0,
      skippedNoIdentity: 0,
    };
  }

  // Build the per-pass credit resolver ONCE from the whole artist + trusted-alias corpus (the slice-0
  // set-based discipline — the fold map is not rebuilt per credit).
  const [corpus, aliases] = await Promise.all([loadArtistCorpus(db), loadAliases(db)]);
  const resolve = createCreditResolver(corpus, aliases);

  for (const row of rows) {
    if (Date.now() >= deadline) {
      // Budget spent — pause, don't fail. The unhandled rest of this page resumes from the cursor on
      // the CLI's next request; the paused rows were NOT stamped, so no state moved.
      budgetPaused = true;
      logEvent("info", "artist-credits.budget-pause", { handled: scanned, pageSize: rows.length });
      break;
    }

    const mbid = row.mb_recording_id ?? recordingMbidFromTrackId(row.track_id);

    if (!mbid) {
      // No MB identity to resolve — terminal skip. Stamp so it drains; never retried.
      await stampVisited(db, row.track_id);
      skippedNoIdentity += 1;
      scanned += 1;
      lastHandledTrackId = row.track_id;
      continue;
    }

    const outcome = await resolveRecordingCredits(mbid, resolve);

    if (outcome.kind === "rate-limited") {
      // Circuit breaker: MusicBrainz is actively throttling. Stop; do NOT stamp this row (it was
      // throttled, not resolved) — the next tick retries it fresh.
      rateLimited = true;
      break;
    }

    // `edged` (including a zero-credit no-match): write the edges, count mint/adopt/match, stamp.
    edgesWritten += await insertEdges(db, row.track_id, outcome.edges);
    mintedArtists += outcome.minted;
    matchedArtists += outcome.matched;
    adoptedArtists += outcome.adopted;
    await stampVisited(db, row.track_id);
    scanned += 1;
    lastHandledTrackId = row.track_id;

    logEvent("info", "artist-credits.resolved", {
      adopted: outcome.adopted,
      edges: outcome.edges.length,
      matched: outcome.matched,
      minted: outcome.minted,
      trackId: row.track_id,
    });
  }

  // Drained when the page came back short. On a throttle-stop, null the cursor so the CLI stops
  // looping this tick (the next tick resumes from the top; the stamps re-skip handled rows). On a
  // budget pause, resume right after the last HANDLED row — the unhandled tail carries no stamp, so
  // the very next request picks it up. A pause that handled nothing (a >60s worklist query —
  // pathological) nulls the cursor rather than hand the CLI the SAME cursor back, which would loop it
  // forever; the next tick retries.
  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rateLimited
    ? null
    : budgetPaused
      ? lastHandledTrackId
      : rows.length < batchLimit
        ? null
        : lastTrackId;

  return {
    adoptedArtists,
    dryRun,
    edgesWritten,
    matchedArtists,
    mintedArtists,
    nextCursor,
    ok: true,
    rateLimited,
    scanned,
    skippedNoIdentity,
  };
}

// Admin-gated, idempotent, Worker-paced catalogue backfills for the two music-graph
// writes not included in the synchronous add:
//
//   1. Last.fm `track.love` — endorse every already-published finding (a Loved
//      Track, never a scrobble — no fabricated listening history). `lastfmLove`
//      is idempotent server-side (loving twice is a no-op) and NO-OPS silently
//      without LASTFM_SESSION_KEY, so even a non-dry run is a safe no-op until
//      Maurice provisions that secret.
//   2. Discogs release-ID — resolve `in_release_id` / `in_master_id` for findings
//      that never got one (added before the resolver shipped, or resolved below
//      the gate at the time). `discogsResolveRelease` stores NOTHING below the
//      0.9 confidence gate, so an unresolved finding correctly stays null.
//
// Both are Worker-owned and best-effort PER FINDING: one bad finding counts as a failure and the
// sweep continues. Discogs vendor reads are normally fetched by the box and returned as bounded
// evidence; the Worker still owns every match verdict and write. Neither triggers the publish
// fan-out — this is a side-channel repair over rows that are already published.
//
// ── Reliability ───────────────────────────────────────────────────────────────
// The box paces the Discogs reads while the Worker retains durable state and all writes. To keep
// from re-storming a vendor API across ticks, each finding carries per-source
// reliability state in the `tracks` row (backfill_{discogs,lastfm}_{attempted_at,
// attempts,failures,done_at}). Before any vendor call the sweep SKIPS a finding
// that is already done or was tried within a cooldown window; the window grows
// with the consecutive-failure count, so a rate-limited finding backs off
// exponentially instead of being retried every tick. After the call the outcome
// is recorded so the next tick resumes from a clean, durable state.

import {
  type DiscogsFactsCandidate,
  type DiscogsFactsWork,
  type DiscogsReleaseCandidate,
  type DiscogsReleaseWork,
} from "@fluncle/contracts/orpc";
import {
  type AppleCatalogBundle,
  appleCatalogLookupByIsrc,
  appleCatalogLookupByIsrcs,
} from "./apple-music";
import {
  areAppleCallsAllowed,
  isAppleCallBudgetAvailable,
  recordAppleAuthOutcome,
  recordAppleCall,
} from "./apple-breaker";
import {
  recordAlbumDiscogsFailure,
  storeAlbumDiscogsFacts,
  storeAlbumDiscogsFactsForTrack,
} from "./albums";
import { parseArtistsJson } from "./artists";
import { resolveBeatportUrl } from "./beatport-resolve";
import { getDb, typedRows } from "./db";
import { batchDueWorkSourceMutation } from "./due-work";
import { lookupDeezerTrackByIsrc } from "./deezer";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import {
  type DiscogsEnrichment,
  type DiscogsThrottleVendor,
  discogsResolveRelease,
  fetchDiscogsReleaseFacts,
  prepareDiscogsRelease,
  releaseFacts,
  scoreDiscogsReleaseCandidates,
} from "./discogs";
import { readOptionalEnv } from "./env";
import { lastfmLove } from "./lastfm";
import {
  decodeTrackCursor,
  encodeTrackCursor,
  getTracksByIds,
  listTracks,
  type TrackListItem,
} from "./tracks";

// One DB page per pass. The batch pages with the same cursor the public feed uses
// until it has visited `limit` eligible findings (or run out of rows).
const PAGE_SIZE = 48;

// Discogs allows ~60 req/min with the token. A finding can cost a few lookups
// (MB bridge + a couple of scored search candidates), so we pace one resolve
// every ~1.2s to stay comfortably under the ceiling across a long backfill.
const DISCOGS_DELAY_MS = 1200;

// Apple Music guidance is ~20 req/min; one ISRC resolve is a single request, so pace
// one every ~3s to stay comfortably under the ceiling across a long backfill.
const APPLE_MUSIC_DELAY_MS = 3000;

// Per-pass ceiling on eligible findings. Each resolve runs under a ~1.1s-floored
// rate limiter (Discogs + MB), so a finding can cost several seconds; sweeping
// the WHOLE catalogue in one request blows past the Worker execution budget (and
// the CLI's fetch). So a backfill is CLEAVED into bounded passes: each request
// processes at most this many eligible findings and returns a resume cursor; the
// CLI loops the cursor until the archive is exhausted. Keep this small enough
// that one pass stays comfortably inside the request budget even when every
// finding needs a resolve. An UNRESOLVED Discogs finding is the worst case — it
// fans out into ~10 rate-limited (~1.1s) lookups (3 search variants + their
// candidate release fetches + the MB bridge) ≈ 12s, so 3/pass ≈ 36s stays well
// under the ~100s gateway ceiling that the all-at-once sweep blew. A caller may
// request fewer via `limit`.
const MAX_BATCH = 3;

// ── Cooldown / backoff policy ────────────────────────────────────────────────
// A finding that was attempted recently is SKIPPED until its cooldown elapses, so
// a tight cron (re-running every few minutes) can't re-hit the same finding before
// the vendor's rate budget has recovered. The base cooldown is the floor between
// two attempts on the SAME finding; the actual window grows with the consecutive
// failure count (exponential backoff), capped, so a finding the vendor keeps
// throttling backs off hard instead of being retried every tick.
//
//   - BASE: a clean attempt (resolved, loved, or a clean no-match) earns a long
//     floor — there is no reason to re-resolve an unresolved finding for a day; a
//     new resolver pass is a deliberate operator action (clear the columns or pass
//     a fresh window), not an every-tick retry.
//   - On FAILURE (a rate-limit hit, or a Last.fm error): window = BASE × 2^failures,
//     capped at MAX, so 1→2× … and it tops out rather than growing unbounded.
const COOLDOWN_BASE_MS = 24 * 60 * 60 * 1000; // 24h between attempts on the same finding
const COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000; // cap the backoff window at 7 days

// The cursor to resume from on the next pass, or null once the archive is
// exhausted. The CLI loops until this is null — UNLESS `rateLimited` is true, the
// vendor circuit breaker tripped (active 429s): then the CLI must stop looping and
// let the next tick resume with a fresh rate window, instead of re-firing the
// cursor straight back into the same wall (the #119-class storm — a stalled tick
// that grinds 300s+ and busts the cron's 120s timeout).
type BackfillPass<T> = T & { nextCursor: string | null; rateLimited: boolean };

export type LastfmBackfillResult = BackfillPass<{
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  loved: string[];
  lovedCount: number;
  // Findings the sweep deliberately skipped this pass (already done, or cooling
  // down after a recent attempt/failure). They don't burn the batch budget.
  skipped: string[];
  skippedCount: number;
}>;

export type DiscogsBackfillResult = BackfillPass<{
  discogsWork: DiscogsReleaseWork[];
  dryRun: boolean;
  rateLimitedBy: DiscogsThrottleVendor | null;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;
  // Findings the sweep deliberately skipped this pass (already resolved, or cooling
  // down after a recent attempt/failure). They don't burn the batch budget.
  skipped: string[];
  skippedCount: number;
  unresolved: string[];
  unresolvedCount: number;
}>;

export type AppleMusicBackfillResult = BackfillPass<{
  // Album-fact rows this pass wrote once (recordLabel/upc/artwork/palette) off the single-ISRC
  // oracle's canonical album — the second half of the Apple read (RFC U1). Zero on a pass that
  // only touched findings whose album was already fact-stamped (or has no `albums` row).
  albumFactsWritten: number;
  // True when the pass STOPPED because the cross-cutting Apple breaker is tripped (K consecutive
  // 401/403 — a suspended developer token) or its per-window call budget is spent. Distinct from
  // `rateLimited` (a 429): the breaker short-circuits the whole leg until it cools down / is reset.
  breakerTripped: boolean;
  // False when the MusicKit secrets are unset — the leg is a NO-OP this tick (nothing
  // resolved, nothing stored, no finding cooled down), so the box cron output reads
  // honestly as "unconfigured" instead of a silent "0 resolved".
  configured: boolean;
  dryRun: boolean;
  // Findings whose resolve threw a non-rate error this pass (recorded as a failure so
  // they back off) — the printSweepJson partial-failure signal.
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;
  // Findings the reliability gate skipped this pass (already resolved, or cooling down
  // after a recent attempt/failure). They don't burn the batch budget.
  skipped: string[];
  skippedCount: number;
  // Findings whose ISRC Apple has no song for (a clean no-match — a `tried`, base
  // cooldown), so a later pass can re-resolve if Apple's catalogue grows.
  unresolved: string[];
  unresolvedCount: number;
}>;

// Which source's reliability columns a query/write targets. `note` is the odd one
// out: it is NOT a Worker-paced vendor sweep (no `backfillNote…` driver lives in
// this module) — it only shares the per-source `backfill_note_*` column shape so the
// auto-note authoring step (`note_track`, agent tier) can reuse `recordAttempt` for
// its "ran" stamp and the board can reuse `listBackfillRanForTracks(_, "note")` for
// the Note cell's done-when-ran semantics, exactly like Discogs/Last.fm.
export type BackfillSource = "apple_music" | "beatport" | "discogs" | "lastfm" | "note";

// The per-source reliability state read off a finding's row.
type ReliabilityState = {
  attemptedAt: string | null;
  failures: number;
  isDone: boolean;
};

// The recorded outcome of one finding's attempt, mapped to a reliability write.
type AttemptOutcome = "done" | "failure" | "tried";

// A finding is "published" once it's on the playlist AND posted — the same bar the
// love/Discogs writes care about (an in-flight/incomplete add isn't a finding yet).
function isPublishedFinding(track: TrackListItem): boolean {
  return track.type === "finding" && track.addedToSpotify && track.postedToTelegram;
}

// ── Reliability state I/O ─────────────────────────────────────────────────────

// The snake_case column prefix for a source ("backfill_discogs" / "backfill_lastfm").
function columnPrefix(source: BackfillSource): string {
  return `backfill_${source}`;
}

// Which TABLE a source's reliability columns live on. `apple_music` moved to `tracks` (its
// output `apple_music_url` is catalogue identity and the sweep drains catalogue rows, which
// have no `findings` row — RFC musickit-second-authority U1); `beatport` was BORN there for the
// same reason (`beatport_url` describes the recording, so it is just as true of an uncertified
// row — only the WORKLIST is certified-only today, not the column); the finding-only sweeps
// (discogs/lastfm/note) stay on `findings`. A static literal, never interpolated user input.
function reliabilityTable(source: BackfillSource): "findings" | "tracks" {
  return source === "apple_music" || source === "beatport" ? "tracks" : "findings";
}

// Read a finding's per-source reliability state. Rows that predate the columns
// read as all-null/zero (the migration defaults attempts/failures to 0), which is
// exactly the "never attempted" state — so a fresh finding is eligible immediately.
async function readReliability(trackId: string, source: BackfillSource): Promise<ReliabilityState> {
  const db = await getDb();
  const p = columnPrefix(source);

  const result = await db.execute({
    args: [trackId],
    sql: `select ${p}_attempted_at as attempted_at,
        ${p}_failures as failures,
        ${p}_done_at as done_at
      from ${reliabilityTable(source)}
      where track_id = ?
      limit 1`,
  });

  const row = result.rows[0] as
    | { attempted_at: string | null; done_at: string | null; failures: number | null }
    | undefined;

  return {
    attemptedAt: row?.attempted_at ?? null,
    failures: typeof row?.failures === "number" ? row.failures : 0,
    isDone: Boolean(row?.done_at),
  };
}

/**
 * Which of the given findings are already loved on Last.fm — i.e. carry a
 * `backfill_lastfm_done_at`. Returned as a Set of trackIds; the admin board turns
 * it into the Last.fm (LFM) cell status, the SAME `done_at` the backfill stamps on
 * a successful `track.love`, so the heart and the love write share one source of
 * truth. One batch query for the whole page, no N+1. Findings that predate the
 * column (or were never loved) read as absent — an empty heart.
 */
export async function listLastfmLovedForTracks(trackIds: string[]): Promise<Set<string>> {
  if (trackIds.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id from findings
          where track_id in (${placeholders})
            and backfill_lastfm_done_at is not null`,
  });

  return new Set(typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id));
}

/**
 * Which of the given findings the backfill has RUN for a given source — i.e. carry
 * a `backfill_<source>_attempted_at`. The attempt timestamp is stamped on EVERY
 * real attempt (a confident match, a clean no-match, and a failure alike — see
 * `recordAttempt`), so it answers the board's actual question: "has the workflow
 * run for this finding?", not "did it find data?". `done_at` (loved / resolved)
 * only stamps on a successful match, so a ran-but-empty finding has `attempted_at`
 * set and `done_at` null — exactly the "Checked — no release" / "Checked — not
 * loved" state the board now shows instead of grey. One batch query per source for
 * the whole page, no N+1. Findings that predate the columns read as absent.
 */
export async function listBackfillRanForTracks(
  trackIds: string[],
  source: BackfillSource,
): Promise<Set<string>> {
  if (trackIds.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const p = columnPrefix(source);
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id from findings
          where track_id in (${placeholders})
            and ${p}_attempted_at is not null`,
  });

  return new Set(typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id));
}

// The cooldown window for a finding given its consecutive-failure count: the base
// floor, doubled per failure, capped. 0 failures → BASE; each failure doubles it.
function cooldownMs(failures: number): number {
  if (failures <= 0) {
    return COOLDOWN_BASE_MS;
  }

  const scaled = COOLDOWN_BASE_MS * 2 ** Math.min(failures, 10);

  return Math.min(scaled, COOLDOWN_MAX_MS);
}

// Whether a finding should be SKIPPED this pass: already done, or attempted within
// its (failure-scaled) cooldown window. A finding never attempted (attemptedAt
// null) is always eligible.
function shouldSkip(state: ReliabilityState, now: number): boolean {
  if (state.isDone) {
    return true;
  }

  if (!state.attemptedAt) {
    return false;
  }

  const last = Date.parse(state.attemptedAt);

  if (!Number.isFinite(last)) {
    // An unparseable timestamp shouldn't wedge a finding forever — treat it as
    // eligible (the next attempt overwrites it with a clean ISO value).
    return false;
  }

  return now - last < cooldownMs(state.failures);
}

// Record a finding's attempt outcome into its per-source reliability columns. Bumps
// the attempt counter and the attempt timestamp every time; `done` stamps done_at
// and clears the failure streak; `failure` increments the streak (driving the
// backoff); `tried` (a clean no-match) clears the streak without marking done.
// Touches ONLY the reliability columns — never updated_at, enrichment status, or
// any public field, so it triggers no fan-out and is invisible to the feed.
async function recordAttempt(
  trackId: string,
  source: BackfillSource,
  outcome: AttemptOutcome,
): Promise<void> {
  const db = await getDb();
  const p = columnPrefix(source);
  const now = new Date().toISOString();

  const doneClause = outcome === "done" ? `${p}_done_at = ?,` : "";
  const failuresClause =
    outcome === "failure" ? `${p}_failures = ${p}_failures + 1` : `${p}_failures = 0`;

  const args: string[] = [now]; // attempted_at

  if (outcome === "done") {
    args.push(now); // done_at
  }

  args.push(trackId);

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args,
        sql: `update ${reliabilityTable(source)}
          set ${p}_attempted_at = ?,
            ${p}_attempts = ${p}_attempts + 1,
            ${doneClause}
            ${failuresClause}
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-attempt" },
  );
}

/**
 * Stamp the auto-note authoring "ran" state for a finding into the `backfill_note_*`
 * columns. The exported seam the `note_track` handler calls: `done` when an empty
 * `note` was filled this run (stamps `backfill_note_done_at`), `tried` when the
 * authoring ran but did NOT fill (a too-long/blank script, or an operator note
 * already present — the workflow ran, found nothing to do). Reuses `recordAttempt`,
 * so it touches ONLY the reliability columns (no `updated_at` bump, no fan-out) —
 * the same quiet write the catalogue sweeps make. Note has no backoff scheduler of
 * its own (the deterministic `hasNote=false` queue is the worklist), so `failure`
 * is intentionally not surfaced here; an authoring miss is a `tried`.
 */
export async function recordNoteAttempt(trackId: string, filled: boolean): Promise<void> {
  await recordAttempt(trackId, "note", filled ? "done" : "tried");
}

// ── Pass driver ───────────────────────────────────────────────────────────────

// Process ONE bounded pass of the public feed (newest-first, deterministic on
// added_at + track_id) starting at `startCursor`, invoking `visit` for each
// PUBLISHED finding until `limit` of them have been HANDLED or the archive is
// exhausted. `visit` returns whether the finding counted toward the limit (a
// skipped/already-done finding returns false, so it doesn't burn the budget).
//
// Returns the cursor to resume from on the next pass — the feed cursor is
// exclusive on {added_at, track_id}, so resuming after the LAST published finding
// we visited re-scans only the cheap non-finding rows between it and the next
// finding (skipped again, no budget burned). Returns null once the feed drains.
async function runPublishedFindingPass(
  workKind: "apple-finding" | "beatport-finding" | "discogs-track" | "lastfm-track",
  startCursor: string | undefined,
  limit: number,
  // `true` = handled (counts toward the limit); `false` = skipped; `"stop"` = a
  // circuit breaker tripped (e.g. the vendor is rate-limiting) — abort the pass
  // immediately rather than marching the next finding into the same wall.
  visit: (track: TrackListItem) => Promise<boolean | "stop">,
): Promise<string | null> {
  if (await isDueWorkCutoverEnabled()) {
    return runProjectedPublishedFindingPass(workKind, startCursor, limit, visit);
  }

  // GOAL H: remove this unchanged legacy corpus selector after the due-work cutover proves out.
  let cursor = startCursor;
  let handled = 0;
  let lastVisited: { addedAt: string; trackId: string } | undefined;

  while (handled < limit) {
    const page = await listTracks({
      cursor: decodeTrackCursor(cursor ?? null),
      limit: PAGE_SIZE,
      order: "desc",
    });

    for (const track of page.tracks) {
      if (handled >= limit) {
        break;
      }

      if (!isPublishedFinding(track)) {
        continue;
      }

      lastVisited = { addedAt: track.addedAt, trackId: track.trackId };

      const outcome = await visit(track);

      if (outcome === "stop") {
        // Circuit breaker tripped — stop the pass now (no more vendor calls this
        // run). Resume from the last finding visited on the next tick.
        return lastVisited ? encodeTrackCursor(lastVisited) : (cursor ?? null);
      }

      if (outcome) {
        handled += 1;
      }
    }

    if (handled >= limit) {
      // Hit the per-pass ceiling: resume after the last finding we visited.
      return lastVisited ? encodeTrackCursor(lastVisited) : (page.nextCursor ?? null);
    }

    if (!page.nextCursor) {
      // Drained the feed — no more passes.
      return null;
    }

    cursor = page.nextCursor;
  }

  return lastVisited ? encodeTrackCursor(lastVisited) : (cursor ?? null);
}

function findingDueContinuation(
  cursor: ReturnType<typeof decodeTrackCursor>,
): { sortKey: string; subjectId: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  return {
    sortKey: encodeDueWorkOrder([
      { direction: "desc", kind: "timestamp", nulls: "last", value: cursor.addedAt },
      { direction: "desc", kind: "text", value: cursor.trackId },
    ]),
    subjectId: cursor.trackId,
  };
}

async function runProjectedPublishedFindingPass(
  workKind: "apple-finding" | "beatport-finding" | "discogs-track" | "lastfm-track",
  startCursor: string | undefined,
  limit: number,
  visit: (track: TrackListItem) => Promise<boolean | "stop">,
): Promise<string | null> {
  const db = await getDb();
  let continuation = findingDueContinuation(decodeTrackCursor(startCursor ?? null));
  let handled = 0;
  let lastVisited: { addedAt: string; trackId: string } | undefined;

  while (handled < limit) {
    const page = await readPromotedDueWorkPage(db, workKind, {
      continuation,
      limit: PAGE_SIZE,
    });
    if (page.subjectIds.length === 0) {
      return null;
    }

    const byId = await getTracksByIds(page.subjectIds);
    for (const subjectId of page.subjectIds) {
      if (handled >= limit) {
        break;
      }
      const track = byId[subjectId];
      if (track === undefined || !isPublishedFinding(track)) {
        continue;
      }

      lastVisited = { addedAt: track.addedAt, trackId: track.trackId };
      const outcome = await visit(track);
      if (outcome === "stop") {
        return encodeTrackCursor(lastVisited);
      }
      if (outcome) {
        handled += 1;
      }
    }

    if (handled >= limit) {
      return lastVisited === undefined ? null : encodeTrackCursor(lastVisited);
    }
    if (!page.hasMore) {
      return null;
    }

    const lastSubjectId = page.subjectIds.at(-1);
    if (lastSubjectId === undefined) {
      return null;
    }
    const cursorRow = await db.execute({
      args: [workKind, lastSubjectId],
      sql: `select sort_key from due_work
            where work_kind = ? and subject_id = ? and subject_type = 'track'
            limit 1`,
    });
    const sortKey = cursorRow.rows[0]?.sort_key;
    if (typeof sortKey !== "string") {
      return null;
    }
    continuation = { sortKey, subjectId: lastSubjectId };
  }

  return lastVisited === undefined ? null : encodeTrackCursor(lastVisited);
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

// Back-fill Last.fm loves over published findings. `lastfmLove` is idempotent and
// no-ops without the session key, so this is safe to run repeatedly; we still
// honour dryRun so the operator can preview the set first. Best-effort per finding,
// with per-finding reliability state: a loved finding is marked done (skipped
// forever after), a rate-limited/failed one backs off via the cooldown window.
export async function backfillLastfmLoves(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<LastfmBackfillResult> {
  const loved: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];
  const skipped: string[] = [];
  const now = Date.now();
  let rateLimited = false;

  const nextCursor = await runPublishedFindingPass(
    "lastfm-track",
    startCursor,
    batchLimit(limit),
    async (track) => {
      const logId = track.logId ?? track.trackId;
      const artist = track.artists[0] ?? track.artists.join(", ");

      if (!artist || !track.title.trim()) {
        // No matchable {artist, track} pair — skip without counting it a failure
        // and without burning the budget (Last.fm matches by string only).
        return false;
      }

      // Reliability gate: already loved, or cooling down → skip (don't burn budget).
      const state = await readReliability(track.trackId, "lastfm");

      if (shouldSkip(state, now)) {
        skipped.push(logId);
        return false;
      }

      if (dryRun) {
        // Preview the set without firing or recording state.
        loved.push(logId);
        return true;
      }

      const outcome = await lastfmLove(artist, track.title);

      if (outcome.ok) {
        await recordAttempt(track.trackId, "lastfm", "done");
        loved.push(logId);
        return true;
      }

      if (outcome.rateLimited) {
        // Circuit breaker: Last.fm is actively rate-limiting. Stop the run here and
        // do NOT cool this finding down (it was throttled, not unmatchable) so the
        // next tick retries it with a fresh window — symmetric with Discogs below.
        rateLimited = true;
        return "stop";
      }

      await recordAttempt(track.trackId, "lastfm", "failure");
      failed.push({ error: outcome.error, logId });
      return true;
    },
  );

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    loved,
    lovedCount: loved.length,
    // Null the cursor on a throttle-stop so even the deployed CLI stops looping this
    // tick (see the Discogs return for the full why) — the deployed CLI breaks on a
    // null cursor, not the newer `rateLimited` flag.
    nextCursor: rateLimited ? null : nextCursor,
    rateLimited,
    skipped,
    skippedCount: skipped.length,
  };
}

// ── Discogs ───────────────────────────────────────────────────────────────────

// Back-fill Discogs ids over published findings WHERE in_release_id is null (the
// public DTO exposes this as the absence of `discogsReleaseUrl`). Resolves
// best-effort and, on a confident match, writes the ids server-side. Paced under
// the Discogs rate limit, with per-finding reliability state: a resolved finding is
// marked done, a clean no-match earns the base cooldown (so it isn't re-resolved
// every tick), and a rate-limited resolve backs off via the failure-scaled window.
export async function backfillDiscogsIds(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
  options: {
    boxFetch?: boolean;
    discogsCandidates?: DiscogsReleaseCandidate[];
  } = {},
): Promise<DiscogsBackfillResult> {
  const discogsWork: DiscogsReleaseWork[] = [];
  const resolved: DiscogsBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let first = true;
  let rateLimited = false;
  let rateLimitedBy: DiscogsThrottleVendor | null = null;
  const suppliedByTrack = new Map(
    (options.discogsCandidates ?? []).map((candidate) => [candidate.trackId, candidate.releases]),
  );

  const visit = async (track: TrackListItem): Promise<boolean | "stop"> => {
    // Already has a release id (discogsReleaseUrl present) → idempotent skip; it
    // doesn't count toward the limit so a full backfill keeps making progress.
    if (track.discogsReleaseUrl) {
      return false;
    }

    if (!track.artists[0]?.trim() || !track.title.trim()) {
      // Nothing to resolve on — skip without burning the budget.
      return false;
    }

    const logId = track.logId ?? track.trackId;

    // Reliability gate: already resolved (done), or cooling down → skip. This is
    // what stops the 429-storm: a finding tried this window is not re-resolved.
    const state = await readReliability(track.trackId, "discogs");

    if (shouldSkip(state, now)) {
      skipped.push(logId);
      return false;
    }

    if (dryRun) {
      // Preview the set without resolving, writing, or recording state.
      unresolved.push(logId);
      return true;
    }

    const input = {
      album: track.album,
      artists: track.artists,
      isrc: track.isrc,
      label: track.label,
      releaseDate: track.releaseDate,
      title: track.title,
    };

    const supplied = suppliedByTrack.get(track.trackId);

    let enrichment: DiscogsEnrichment;

    if (options.discogsCandidates !== undefined) {
      // Missing is not empty: only an explicit group proves the box completed this row. A partial
      // batch therefore cannot stamp an omitted finding as a clean no-match.
      if (supplied === undefined) {
        return false;
      }

      // The scorer reads the row as it exists NOW and runs the identical tracklist/confidence
      // gate as Worker-fetched releases. No Discogs request occurs on this branch.
      enrichment = scoreDiscogsReleaseCandidates(input, supplied);
    } else if (options.boxFetch) {
      // Preparation keeps the resolver's MusicBrainz-first identity leg. It deliberately stops
      // before Discogs: a direct RELEASE relation can resolve here, while master-only still needs
      // a concrete release and therefore becomes box work.
      const preparation = await prepareDiscogsRelease(input);
      enrichment = preparation.enrichment;

      if (enrichment.rateLimited) {
        rateLimited = true;
        rateLimitedBy = enrichment.rateLimitedBy ?? null;
        return "stop";
      }

      if (!enrichment.releaseId) {
        discogsWork.push({ queries: preparation.queries, trackId: track.trackId });
        return true;
      }
    } else {
      // Pace legacy Worker-fetch calls (skip the wait before the first one).
      if (!first) {
        await delay(DISCOGS_DELAY_MS);
      }
      first = false;

      // The legacy branch remains unchanged for callers that do not opt into the split.
      enrichment = await discogsResolveRelease(input);
    }

    if (enrichment.rateLimited) {
      // Circuit breaker: Discogs is actively rate-limiting. Stop the whole run
      // here rather than marching the next finding into the same 429 wall — the
      // storm #119 missed (per-finding cooldown only helps the NEXT run; nothing
      // stopped the current one). Do NOT cool this finding down: it was budget-
      // throttled, not unresolvable, so the next 30m tick retries it with a fresh
      // rate-limit window (the resolved findings above are already `done`-gated).
      // The flag tells the CLI to STOP LOOPING the cursor (not just this pass) —
      // otherwise it re-fires the same throttled cursor and grinds to a timeout.
      rateLimited = true;
      rateLimitedBy = enrichment.rateLimitedBy ?? null;
      return "stop";
    }

    if (!enrichment.releaseId) {
      // A clean no-match is a TRIED (base cooldown, streak reset) so an
      // unresolvable finding isn't re-hit every tick.
      await recordAttempt(track.trackId, "discogs", "tried");
      unresolved.push(logId);
      return true;
    }

    await setDiscogsIds(track.trackId, enrichment.releaseId, enrichment.masterId);
    await recordAttempt(track.trackId, "discogs", "done");

    // CAPTURE ON RESOLVE, the publish path's twin (publish.ts). The scored search leg held the
    // release payload, so its catno + styles are already in hand — store them at the album grain
    // rather than throwing away a fact we paid for. A MusicBrainz-bridge resolve carries none and
    // leaves the album `pending` for `backfillDiscogsFacts` below. Fill-empty-only in SQL.
    if (enrichment.catno !== undefined || enrichment.styles !== undefined) {
      await storeAlbumDiscogsFactsForTrack(track.trackId, {
        catno: enrichment.catno,
        styles: enrichment.styles,
      });
    }

    resolved.push({
      logId,
      masterId: enrichment.masterId,
      releaseId: enrichment.releaseId,
      // The resolver doesn't surface which leg matched (MB bridge vs scored
      // search), so the source is the resolver itself.
      source: "discogs",
    });

    return true;
  };

  let nextCursor: string | null;

  if (options.discogsCandidates !== undefined) {
    const suppliedIds = [...suppliedByTrack.keys()];
    let selectedIds: string[];
    const cutoverEnabled = await isDueWorkCutoverEnabled();

    if (cutoverEnabled) {
      if (suppliedIds.length === 0) {
        selectedIds = [];
      } else {
        const db = await getDb();
        const page = await readPromotedDueWorkPage(db, "discogs-track", {
          limit: suppliedIds.length,
          subjectIds: suppliedIds,
        });
        selectedIds = page.subjectIds;
      }
    } else {
      // GOAL H: remove this unchanged legacy supplied-evidence selector after cutover proves out.
      selectedIds = suppliedIds;
    }

    const tracks = await getTracksByIds(selectedIds);

    for (const trackId of selectedIds) {
      const track = tracks[trackId];

      if (track !== undefined && (await visit(track)) === "stop") {
        break;
      }
    }

    nextCursor = null;
  } else {
    nextCursor = await runPublishedFindingPass(
      "discogs-track",
      startCursor,
      batchLimit(limit),
      visit,
    );
  }

  return {
    discogsWork,
    dryRun,
    // On a throttle-stop, NULL the cursor so even the currently-deployed CLI (which
    // breaks only on a null cursor, not the newer `rateLimited` flag) stops looping
    // this tick instead of re-firing the cursor into the same 429 wall to the 120s
    // timeout. Losing the resume point is harmless: the cron starts each tick from
    // the top and the reliability gate re-skips done/cooling findings cheaply.
    nextCursor: rateLimited ? null : nextCursor,
    rateLimited,
    rateLimitedBy,
    resolved,
    resolvedCount: resolved.length,
    skipped,
    skippedCount: skipped.length,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

// Server-side write of the two Discogs columns — the same `in_release_id` /
// `in_master_id` publishTrack sets on the initial insert, here as a targeted
// UPDATE for the backfill. Bumps updated_at like every other track mutation; does
// NOT touch enrichment status or trigger any fan-out.
async function setDiscogsIds(
  trackId: string,
  releaseId: number,
  masterId: number | undefined,
): Promise<void> {
  const db = await getDb();

  // The resolve straddles the pair: the Discogs ids are CATALOGUE IDENTITY (they
  // describe the recording, so they live on `tracks` and would be just as true of an
  // uncertified track), while `updated_at` is the FINDING's public lastmod — the
  // `discogs.com/release/{id}` sameAs the write puts on /log is what moves. One batch,
  // so the id and the lastmod that advertises it can never diverge.
  const now = new Date().toISOString();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        // The tracks-side attempt record rides the ids it describes (schema.ts § `backfill_discogs_*`
        // on `tracks`), so a finding this sweep resolves can never read "attempted, no release"
        // while carrying one. That set is the RECORDING's attempt record and is distinct from this
        // sweep's own pacing state on `findings`, which `recordAttempt` keeps as before — the sweep
        // writes both because it is the one path that moves both truths at once.
        args: [releaseId, masterId ?? null, now, now, trackId],
        sql: `update tracks
          set in_release_id = ?,
            in_master_id = ?,
            backfill_discogs_attempted_at = ?,
            backfill_discogs_done_at = ?,
            backfill_discogs_attempts = backfill_discogs_attempts + 1
          where track_id = ?`,
      },
      {
        args: [now, trackId],
        sql: `update findings set updated_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-discogs-resolve" },
  );
}

// ── Discogs — the RELEASE FACTS drain (catalogue number + styles) ──────────────────────────────
//
// The sweep above resolves a finding to a Discogs RELEASE ID and stops. This one takes that id and
// reads the two album-grained facts off the release: `labels[].catno` (the label's own catalogue
// number, the code printed on the sleeve — RAMM###, HOSP###) and `styles[]`. Both land on the
// `albums` row (db/schema.ts § albums, docs/album-entity.md); the catno reaches the album page and
// its JSON-LD, the styles are stored only.
//
// WHY A SECOND LEG AT ALL, when the resolver hands the same facts back inline. Because the
// resolver's PRIMARY path never sees a release payload: the MusicBrainz bridge reaches a Discogs id
// through a curated `url-rels` relation and accepts it directly, so a bridge-resolved finding
// carries an id and no facts. Capture-on-resolve covers the scored-search half for free; this leg
// covers the rest, and it is the only path that can reach the findings resolved before the facts
// columns existed at all.
//
// THE WORKLIST IS ALBUM-GRAINED AND SELF-DRAINING. It starts from the tracks that carry an
// `in_release_id` (a partial index fronts exactly that slice — a full scan of `tracks` every tick
// is the shape AGENTS.md forbids), joins their album by primary key, and keeps only albums still
// `pending` and past their cooldown. A pass that resolves an album flips it to `resolved`, one that
// finds a release with no number flips it to terminal `none`, and either way the row leaves the
// worklist for good. No cursor: the next tick simply reads what is left.
//
// ONE LOOKUP PER ALBUM, NOT PER TRACK. Ten findings off one record share one catalogue number, so
// the pass groups by album and buys the release once — which is also why the ledger lives on
// `albums` rather than reusing the per-track `backfill_*` columns.

/** One album awaiting its Discogs facts, with the release to read and the ledger the gate needs. */
type DiscogsFactsWorkRow = {
  albumId: string;
  attemptedAt: null | string;
  failures: number;
  releaseId: number;
  slug: string;
};

/** One bounded Discogs-facts pass's numbers. No cursor — the worklist self-drains by state. */
export type DiscogsFactsBackfillResult = {
  // False when neither a legacy Worker token nor the box-fetch request arms this pass.
  configured: boolean;
  discogsWork: DiscogsFactsWork[];
  dryRun: boolean;
  // Albums whose release lookup ERRORED — nothing was learned, the streak scales their cooldown.
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // Albums whose release genuinely carries no catalogue number — terminal, never re-read.
  none: string[];
  noneCount: number;
  // True when the pass STOPPED on the Discogs rate-limit circuit breaker; the next tick resumes
  // with a fresh window rather than marching the rest of the batch into the same wall.
  rateLimited: boolean;
  resolved: Array<{ catno: string; slug: string }>;
  resolvedCount: number;
};

// At most this many albums per pass. Each is one paced (~1.1s) Discogs release lookup, so 25 is
// ~28s of wall time — comfortably inside the Worker request budget, with the box driving a smaller
// batch than this ceiling on its own 30-minute cadence.
const DISCOGS_FACTS_MAX_BATCH = 25;

/**
 * Read the Discogs-facts worklist: albums still `pending`, past the base cooldown, that at least one
 * Discogs-resolved track points at. The `group by` collapses a record's tracks to ONE row and
 * `min(in_release_id)` picks its release deterministically, so a re-read of the same worklist asks
 * for the same releases. The precise failure-scaled cooldown is refined per row in TS, exactly as
 * `listCatalogueAppleWork` does — the SQL applies only the cheap base cutoff.
 */
async function listDiscogsFactsWork(
  limit: number,
  slugs?: string[],
): Promise<DiscogsFactsWorkRow[]> {
  if (slugs?.length === 0) {
    return [];
  }

  const db = await getDb();
  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const slugClause = slugs ? `and a.slug in (${slugs.map(() => "?").join(", ")})` : "";
  const result = await db.execute({
    args: slugs ? [cutoff, ...slugs, limit] : [cutoff, limit],
    sql: `select a.id as album_id, a.slug as slug,
                 a.discogs_attempted_at as attempted_at,
                 a.discogs_failures as failures,
                 min(t.in_release_id) as release_id
          from tracks t
          join albums a on a.id = t.album_id
          where t.in_release_id is not null
            and a.discogs_state = 'pending'
            and (a.discogs_attempted_at is null or a.discogs_attempted_at < ?)
            ${slugClause}
          group by a.id
          order by a.id
          limit ?`,
  });

  return typedRows<{
    album_id: string;
    attempted_at: null | string;
    failures: null | number;
    release_id: number;
    slug: string;
  }>(result.rows).map((row) => ({
    albumId: row.album_id,
    attemptedAt: row.attempted_at,
    failures: typeof row.failures === "number" ? row.failures : 0,
    releaseId: row.release_id,
    slug: row.slug,
  }));
}

/**
 * Drain one bounded pass of the Discogs release-facts worklist.
 *
 * The ledger writes, and the reasoning behind each:
 *   - a release with a catno  → `resolved` (catno + styles stored, terminal);
 *   - a release with none     → `none` (terminal too: a pressing does not grow a catalogue number
 *                                later, so re-reading it forever would spend the rate budget on a
 *                                question already answered);
 *   - a lookup that errored   → `failure` (streak scales the cooldown; nothing was concluded, so
 *                                the album stays `pending` and a later tick retries it);
 *   - a throttle              → NOTHING at all, and the pass stops. The album was budget-blocked,
 *                                not unanswerable, so stamping it would poison the ledger.
 *   - unconfigured            → NOTHING at all, and the pass stops before the first read.
 */
export async function backfillDiscogsFacts(
  limit: number,
  dryRun: boolean,
  options: {
    boxFetch?: boolean;
    discogsCandidates?: DiscogsFactsCandidate[];
  } = {},
): Promise<DiscogsFactsBackfillResult> {
  const discogsWork: DiscogsFactsWork[] = [];
  const resolved: DiscogsFactsBackfillResult["resolved"] = [];
  const none: string[] = [];
  const failed: DiscogsFactsBackfillResult["failed"] = [];
  const now = Date.now();

  const summarize = (over: Partial<DiscogsFactsBackfillResult>): DiscogsFactsBackfillResult => ({
    configured,
    discogsWork,
    dryRun,
    failed,
    failedCount: failed.length,
    none,
    noneCount: none.length,
    rateLimited: false,
    resolved,
    resolvedCount: resolved.length,
    ...over,
  });

  // Read the token FIRST, so `configured` is honest on every return path including a dry run — a
  // A legacy preview with no Worker token remains unconfigured; an explicit box-fetch request is
  // armed because its vendor token stays outside this process.
  const token = await readOptionalEnv("DISCOGS_USER_TOKEN");
  const configured =
    Boolean(token) || options.boxFetch === true || options.discogsCandidates !== undefined;

  if (options.discogsCandidates !== undefined && options.discogsCandidates.length === 0) {
    return summarize({});
  }

  const page = Math.max(1, Math.min(limit, DISCOGS_FACTS_MAX_BATCH));
  const suppliedSlugs = options.discogsCandidates?.map((candidate) => candidate.slug);
  const candidates = await listDiscogsFactsWork(
    page,
    suppliedSlugs && suppliedSlugs.length > 0 ? suppliedSlugs : undefined,
  );

  // The precise failure-scaled cooldown, refined per row (the SQL applied only the base cutoff).
  // `isDone: false` because a done album is not in the worklist at all — the `pending` predicate
  // already removed it, so this gate only has the backoff window left to decide.
  const eligible = candidates.filter(
    (candidate) =>
      !shouldSkip(
        { attemptedAt: candidate.attemptedAt, failures: candidate.failures, isDone: false },
        now,
      ),
  );

  if (eligible.length === 0) {
    return summarize({});
  }

  if (dryRun) {
    // Preview the eligible set (as `none` — the "would be read" set) without a single vendor call.
    for (const candidate of eligible) {
      none.push(candidate.slug);
    }

    return summarize({});
  }

  if (options.boxFetch && options.discogsCandidates === undefined) {
    for (const candidate of eligible) {
      discogsWork.push({ releaseId: candidate.releaseId, slug: candidate.slug });
    }

    return summarize({});
  }

  if (options.discogsCandidates !== undefined) {
    const suppliedBySlug = new Map(
      options.discogsCandidates.map((candidate) => [candidate.slug, candidate]),
    );

    for (const candidate of eligible) {
      const supplied = suppliedBySlug.get(candidate.slug);

      if (!supplied) {
        continue;
      }

      // Re-read identity wins. Stale or cross-wired evidence is reported but cannot mutate either
      // the album ledger or its facts.
      if (supplied.release.id !== candidate.releaseId) {
        failed.push({
          error: `Discogs release evidence did not match DB release ${candidate.releaseId}`,
          slug: candidate.slug,
        });
        continue;
      }

      const facts = releaseFacts(supplied.release);
      await storeAlbumDiscogsFacts(candidate.albumId, facts);

      if (facts.catno) {
        resolved.push({ catno: facts.catno, slug: candidate.slug });
      } else {
        none.push(candidate.slug);
      }
    }

    return summarize({});
  }

  // No token → no reads, no stamps. Every album would answer identically, so scanning to no effect
  // is waste and recording an attempt nobody made would poison the ledger (the Beatport rule).
  if (!token) {
    return summarize({});
  }

  for (const candidate of eligible) {
    const outcome = await fetchDiscogsReleaseFacts(candidate.releaseId, token);

    if (outcome.rateLimited) {
      // Circuit breaker: stop the whole pass rather than marching the next album into the same 429.
      // Nothing is stamped, so every remaining album stays eligible for the next tick's fresh window.
      return summarize({ rateLimited: true });
    }

    if (!outcome.found || !outcome.facts) {
      await recordAlbumDiscogsFailure(candidate.albumId);
      failed.push({
        error: `Discogs release ${candidate.releaseId} could not be read`,
        slug: candidate.slug,
      });
      continue;
    }

    await storeAlbumDiscogsFacts(candidate.albumId, outcome.facts);

    if (outcome.facts.catno) {
      resolved.push({ catno: outcome.facts.catno, slug: candidate.slug });
    } else {
      none.push(candidate.slug);
    }
  }

  return summarize({});
}

// ── Apple Music ─────────────────────────────────────────────────────────────────

// Back-fill Apple Music URLs over published findings WHERE apple_music_url is null and
// the finding carries an ISRC. Resolves EXACTLY by ISRC (never a fuzzy artist/title
// guess) via the Apple Music API and, on a match, writes the URL server-side. Paced
// under the ~20 req/min guidance, with the same per-finding reliability state as the
// other sweeps: a resolved finding is marked done, a clean no-match earns the base
// cooldown (Apple has no song for that ISRC — re-checkable later), and a rate-limited
// resolve backs off via the failure-scaled window. NO-OP until the MusicKit secrets are
// provisioned: the first unconfigured resolve stops the pass cheaply and the result
// reports `configured: false`.
export async function backfillAppleMusicUrls(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<AppleMusicBackfillResult> {
  const resolved: AppleMusicBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const failed: AppleMusicBackfillResult["failed"] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let first = true;
  let rateLimited = false;
  let breakerTripped = false;
  let configured = true;
  let albumFactsWritten = 0;

  const nextCursor = await runPublishedFindingPass(
    "apple-finding",
    startCursor,
    batchLimit(limit),
    async (track) => {
      // Already has an Apple Music URL → idempotent skip; doesn't count toward the
      // limit so a full backfill keeps making progress.
      if (track.appleMusicUrl) {
        return false;
      }

      // The worklist is ISRC-gated: the resolve is exact-by-ISRC, so a finding without
      // one has nothing to match on — skip without burning the budget.
      if (!track.isrc?.trim()) {
        return false;
      }

      const logId = track.logId ?? track.trackId;

      // Reliability gate: already resolved (done), or cooling down → skip.
      const state = await readReliability(track.trackId, "apple_music");

      if (shouldSkip(state, now)) {
        skipped.push(logId);
        return false;
      }

      if (dryRun) {
        // Preview the eligible set without resolving, writing, or recording state.
        unresolved.push(logId);
        return true;
      }

      // THE CROSS-CUTTING BREAKER + METER (RFC U1). Consult before spending a call: a tripped
      // breaker (a suspended token) or a spent call window short-circuits the whole leg this
      // tick — stop cleanly, record nothing (the finding stays eligible), resume next tick.
      if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
        breakerTripped = true;
        return "stop";
      }

      // Pace the calls (skip the wait before the first one).
      if (!first) {
        await delay(APPLE_MUSIC_DELAY_MS);
      }
      first = false;

      // ONE single-ISRC oracle read carries BOTH the URL and the canonical album facts, so the
      // finding sweep resolves the listen link AND populates its album's second-authority facts
      // in a single call (RFC U1) — no extra Apple request per finding.
      await recordAppleCall(now);
      const outcome = await appleCatalogLookupByIsrc(track.isrc);

      if (!outcome.configured) {
        // The MusicKit secrets are unset — the whole leg is a no-op. Every finding
        // would answer the same, so stop the pass here (cheap) rather than scanning
        // the archive to no effect. Record NOTHING: the finding stays eligible for
        // when the key is provisioned.
        configured = false;
        return "stop";
      }

      if (!outcome.ok) {
        // Feed the breaker: a 401/403 advances its consecutive-auth-failure streak (and trips
        // it on the K-th); a 429 / other error leaves it untouched.
        await recordAppleAuthOutcome(appleOutcomeKind(outcome), now);

        if (outcome.rateLimited) {
          // Circuit breaker: Apple is actively rate-limiting. Stop the run; do NOT cool
          // this finding down (it was throttled, not unresolvable) so the next tick
          // retries it with a fresh window — symmetric with Discogs/Last.fm.
          rateLimited = true;
          return "stop";
        }

        // A non-rate error (bad token, network) is a real failure — record it so the
        // finding backs off, and surface it in `failed` for the partial-failure signal.
        await recordAttempt(track.trackId, "apple_music", "failure");
        failed.push({ error: outcome.error, logId });
        return true;
      }

      await recordAppleAuthOutcome("ok", now);

      if (!outcome.bundle) {
        // A clean no-match is a TRIED (base cooldown, streak reset): Apple has no song
        // for this ISRC yet, so don't re-hit it every tick — but it isn't done, so a
        // later pass can pick it up if Apple's catalogue grows.
        await recordAttempt(track.trackId, "apple_music", "tried");
        unresolved.push(logId);
        return true;
      }

      // A finding HAS a `findings` row, so bump its public lastmod alongside the URL write.
      await setAppleMusicUrl(track.trackId, outcome.bundle.songUrl, true);
      await recordAttempt(track.trackId, "apple_music", "done");
      resolved.push({ logId, url: outcome.bundle.songUrl });

      // Album facts, once per album — off the same read, no extra call.
      if (await storeAlbumFactsForTrack(track.trackId, outcome.bundle)) {
        albumFactsWritten += 1;
      }

      return true;
    },
  );

  return {
    albumFactsWritten,
    breakerTripped,
    configured,
    dryRun,
    failed,
    failedCount: failed.length,
    // Null the cursor on a throttle-stop, a breaker trip, OR an unconfigured no-op so even the
    // deployed CLI (which breaks only on a null cursor) stops looping this tick. Losing the
    // resume point is harmless: the cron restarts from the top and the reliability gate
    // re-skips done/cooling findings cheaply.
    nextCursor: rateLimited || breakerTripped || !configured ? null : nextCursor,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
    skipped,
    skippedCount: skipped.length,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

/**
 * Map an Apple `{ ok: false }` outcome to the breaker's outcome kind: a flagged 401/403 is an
 * `auth_failure` (advances the trip streak); everything else (a 429, a network throw) is `other`
 * (the breaker leaves it alone — that is the 429 regime the sweeps' own backoff handles).
 */
function appleOutcomeKind(outcome: {
  authFailed?: boolean;
  rateLimited: boolean;
}): "auth_failure" | "other" {
  return outcome.authFailed ? "auth_failure" : "other";
}

// Server-side write of the Apple Music URL, CATALOGUE-AWARE (RFC U1). The URL is CATALOGUE
// identity (it describes the recording, so it lives on `tracks` and is just as true of an
// uncertified track). `bumpFinding` is the conditional half: a FINDING carries a `findings`
// row whose public lastmod (`updated_at`) advertises the new `music.apple.com/…` sameAs on
// /log, so its write bumps it in the SAME batch (the URL and the lastmod can never diverge). A
// CATALOGUE row has no `findings` row to bump — passing `false` writes the URL alone.
async function setAppleMusicUrl(trackId: string, url: string, bumpFinding: boolean): Promise<void> {
  const db = await getDb();

  const statements = [
    {
      args: [url, trackId],
      sql: `update tracks set apple_music_url = ? where track_id = ?`,
    },
  ];

  if (bumpFinding) {
    statements.push({
      args: [new Date().toISOString(), trackId],
      sql: `update findings set updated_at = ? where track_id = ?`,
    });
  }

  await batchDueWorkSourceMutation(db, statements, [{ subjectId: trackId, subjectType: "track" }], {
    producer: "backfill-apple-resolve",
  });
}

/**
 * Store the Apple album FACTS (recordLabel/upc/artwork/palette) for a track's album, ONCE. Given
 * a resolved single-ISRC bundle, this resolves the track's `albums` row (via `tracks.album_id`)
 * and — only when that row exists AND has not been fact-stamped yet (`apple_album_id IS NULL`) —
 * writes the canonical album's facts. Returns true iff a row was written (so the caller counts
 * one album fact). NULL-SAFE at every hop: an honest miss (the bundle has no `canonicalAlbum`, the
 * track has no `album_id`, its album is already stamped, or another concurrent pass stamped it
 * first) writes nothing and returns false. Facts are ALBUM-grained, so this is idempotent and
 * runs at most once per album across every pass.
 */
export async function storeAlbumFactsForTrack(
  trackId: string,
  bundle: AppleCatalogBundle,
): Promise<boolean> {
  const album = bundle.canonicalAlbum;

  if (!album) {
    return false;
  }

  const db = await getDb();

  // Resolve the album row this track points at, but only if it still needs facts. The join +
  // the `apple_album_id is null` guard are both in SQL, so an already-stamped album never
  // crosses the wire and the whole thing stays a single indexed read.
  const target = await db.execute({
    args: [trackId],
    sql: `select a.id as id
          from tracks t
          join albums a on a.id = t.album_id
          where t.track_id = ? and a.apple_album_id is null
          limit 1`,
  });

  const albumId = typedRows<{ id: string }>(target.rows)[0]?.id;

  if (typeof albumId !== "string") {
    return false;
  }

  const artwork = album.artwork;
  const updated = await db.execute({
    // `apple_album_id is null` in the WHERE makes the write itself the idempotence: two passes
    // racing the same album, only the first stamps it. The rest of the columns are NULL-safe
    // (an absent fact binds NULL). `updated_at` bumps — the album page reads these facts.
    args: [
      album.id,
      album.upc ?? null,
      album.recordLabel ?? null,
      artwork?.urlTemplate ?? null,
      artwork?.width ?? null,
      artwork?.height ?? null,
      artwork?.bgColor ?? null,
      artwork?.textColor1 ?? null,
      artwork?.textColor2 ?? null,
      artwork?.textColor3 ?? null,
      artwork?.textColor4 ?? null,
      new Date().toISOString(),
      albumId,
    ],
    sql: `update albums
          set apple_album_id = ?,
              upc = ?,
              record_label_raw = ?,
              artwork_url_template = ?,
              artwork_width = ?,
              artwork_height = ?,
              artwork_bg_color = ?,
              artwork_text_color1 = ?,
              artwork_text_color2 = ?,
              artwork_text_color3 = ?,
              artwork_text_color4 = ?,
              updated_at = ?
          where id = ? and apple_album_id is null`,
  });

  return updated.rowsAffected > 0;
}

// ── Beatport ────────────────────────────────────────────────────────────────────────────────
//
// The store leg of the identity answer: a finding's Beatport BUY link, won by exact ISRC equality
// through the keyless public-search resolve (lib/server/beatport-resolve.ts, which carries the
// no-API-key ruling and the §F terms rail).
//
// SCOPED TO CERTIFIED FINDINGS, DELIBERATELY. This rides `runPublishedFindingPass` — the public
// feed — so it sees published findings and is structurally blind to a catalogue track, exactly as
// the Discogs and Last.fm legs are. That is the ruled scope, not an oversight: the ~85 certified
// findings are worth one scrape each, and the catalogue tail is a different economic question
// (docs/planning/ROADMAP.md's identity tail holds the gate). The COLUMN is on `tracks` and would
// serve a catalogue row unchanged the day that ruling flips; only this worklist would change.
//
// NEW FINDINGS RIDE THE SAME SWEEP. A finding published tomorrow enters the feed with null
// reliability columns, which reads as "never attempted" — so the next tick picks it up with no
// backfill/steady-state split to maintain.
//
// NO SHARED METER. Unlike the two Apple legs, this leg has no cross-cutting call budget to
// consult: pacing is the Firecrawl account's own limiter plus this pass's small `limit`. One
// scrape per eligible finding, a handful per tick, and the reliability cooldown keeps a drained
// archive quiet.

/**
 * The outcome of one bounded Beatport pass — BOTH tiers.
 *
 * The catalogue tier keeps its own counters rather than folding into the findings arrays, because
 * the two are different money. A certified row is one of ~85 and worth a scrape on sight; a
 * catalogue row is one of five figures and every one of them is a Firecrawl credit, so the operator
 * has to be able to read this tier's spend on its own line. They are keyed differently too: a
 * catalogue row has no Log ID to report.
 */
export type BeatportBackfillResult = {
  // Catalogue rows whose scrape errored — nothing learned, the streak backs them off.
  catalogueFailed: Array<{ error: string; trackId: string }>;
  catalogueFailedCount: number;
  catalogueResolved: Array<{ trackId: string; url: string }>;
  catalogueResolvedCount: number;
  // Catalogue rows Beatport ran a search for and does not carry — a concluded no-match.
  catalogueUnresolved: string[];
  catalogueUnresolvedCount: number;
  configured: boolean;
  dryRun: boolean;
  // Findings whose resolve genuinely errored (a scrape failure, a timeout, an unreadable page).
  // Distinct from `unresolved` — nothing was learned, so these back off and are retried.
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  nextCursor: null | string;
  ok: boolean;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;
  // Findings the reliability gate skipped this pass (already linked, or cooling down).
  skipped: string[];
  skippedCount: number;
  // Findings Beatport ran a search for and does not carry — a clean no-match, re-checkable.
  unresolved: string[];
  unresolvedCount: number;
};

/**
 * Write a finding's Beatport URL and its verification stamp in ONE statement, and only onto a row
 * that does not already carry one.
 *
 * FIRST WRITE WINS, enforced by the `beatport_url is null` predicate rather than by the caller
 * having checked first — so two overlapping passes cannot have the second silently relabel a link
 * the first already verified, and the stamp can never describe a different URL than the one beside
 * it. NO `findings.updated_at` BUMP, unlike the Apple write: this link is terminal (§F) and never
 * reaches /log, its JSON-LD `sameAs`, or any feed, so there is no public lastmod to move.
 */
async function setBeatportUrl(trackId: string, url: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [url, new Date().toISOString(), trackId],
        sql: `update tracks
          set beatport_url = ?, beatport_verified_at = ?
          where track_id = ? and beatport_url is null`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-beatport-resolve" },
  );
}

/**
 * Back-fill Beatport URLs over published findings that carry an ISRC but no link yet.
 *
 * The ledger writes, and the reasoning behind each (the rules at the top of this file):
 *   - a match          → `done` (url + stamp written, failure streak cleared);
 *   - a clean no-match → `tried` (attempted + counted, NOT done — Beatport's catalogue grows, and
 *                         the receipt says "Not found · checked <date>" without promising a
 *                         re-check, since no re-check policy is ruled yet);
 *   - a scrape failure → `failure` (the streak scales the cooldown; nothing was concluded);
 *   - unconfigured     → NOTHING at all, and the pass stops on the first one. Every finding would
 *                         answer identically, so scanning the archive to no effect is waste, and
 *                         recording an attempt nobody made would poison the receipt.
 */
export async function backfillBeatportUrls(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<BeatportBackfillResult> {
  const resolved: BeatportBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const failed: BeatportBackfillResult["failed"] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let configured = true;

  const nextCursor = await runPublishedFindingPass(
    "beatport-finding",
    startCursor,
    batchLimit(limit),
    async (track) => {
      // NOTE THE MISSING CHECK. The Apple leg opens by testing `track.appleMusicUrl` off the feed
      // item; there is deliberately no `track.beatportUrl` twin, because `beatport_url` is a
      // terminal artifact (§F) and must never join the public track DTO just to give this sweep a
      // convenient read. Idempotence rides the reliability ledger instead: a linked row carries
      // `backfill_beatport_done_at`, which `shouldSkip` already treats as done. The write itself is
      // guarded a second time by `setBeatportUrl`'s `beatport_url is null` predicate.

      // The gate is exact ISRC equality, so a finding without one has nothing to match on.
      if (!track.isrc?.trim()) {
        return false;
      }

      const logId = track.logId ?? track.trackId;
      const state = await readReliability(track.trackId, "beatport");

      if (shouldSkip(state, now)) {
        skipped.push(logId);

        return false;
      }

      if (dryRun) {
        // Preview the eligible set without scraping, writing, or recording state.
        unresolved.push(logId);

        return true;
      }

      const outcome = await resolveBeatportUrl({
        artists: track.artists,
        isrc: track.isrc,
        title: track.title,
      });

      if (!outcome.configured) {
        configured = false;

        return "stop";
      }

      if (!outcome.ok) {
        await recordAttempt(track.trackId, "beatport", "failure");
        failed.push({ error: outcome.error, logId });

        return true;
      }

      if (!outcome.url) {
        await recordAttempt(track.trackId, "beatport", "tried");
        unresolved.push(logId);

        return true;
      }

      await setBeatportUrl(track.trackId, outcome.url);
      await recordAttempt(track.trackId, "beatport", "done");
      resolved.push({ logId, url: outcome.url });

      return true;
    },
  );

  // THE CATALOGUE TIER, BEHIND THE CERTIFIED ONE — and `nextCursor === null` is what puts it there.
  //
  // The order is the budget, exactly as it is on the shared Apple meter: the certified feed gets
  // first call on the Firecrawl window every tick, and the catalogue drains only what is left. A
  // null cursor is precisely the statement "the certified feed is exhausted for this tick", so
  // gating on it makes the priority structural rather than hoped-for — a tick busy with certified
  // rows spends nothing on the catalogue, by construction.
  //
  // IT IS ALSO THE SPEND BOUND, and that is the load-bearing half. The CLI LOOPS this endpoint,
  // re-firing the cursor until the feed drains — so a catalogue drain on every pass would multiply
  // the sub-cap by however many passes a tick happens to take (a ~4-pass tick would quietly spend
  // 4× the credits the operator capped). Exactly one pass per invocation returns a null cursor, so
  // the tier runs exactly once per tick and the cap means what it says.
  //
  // Unconfigured skips it too: the findings pass already stopped on the first unconfigured resolve,
  // and scanning a second worklist to make the same discovery would be waste.
  const catalogue =
    configured && nextCursor === null
      ? await drainBeatportCatalogue(dryRun)
      : { failed: [], resolved: [], unresolved: [] };

  return {
    catalogueFailed: catalogue.failed,
    catalogueFailedCount: catalogue.failed.length,
    catalogueResolved: catalogue.resolved,
    catalogueResolvedCount: catalogue.resolved.length,
    catalogueUnresolved: catalogue.unresolved,
    catalogueUnresolvedCount: catalogue.unresolved.length,
    configured,
    dryRun,
    failed,
    failedCount: failed.length,
    nextCursor,
    ok: failed.length === 0 && catalogue.failed.length === 0,
    resolved,
    resolvedCount: resolved.length,
    skipped,
    skippedCount: skipped.length,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

// ── Beatport — the CATALOGUE tier ─────────────────────────────────────────────────────────────
//
// The findings pass above rides `runPublishedFindingPass` (the public feed), so it is structurally
// blind to a catalogue track — the same hole the Apple drain closed for its own read. `beatport_url`
// was BORN on `tracks` precisely because it describes the recording and is just as true of an
// uncertified row (schema.ts), so nothing but the WORKLIST had to change to reach them.
//
// THE ECONOMICS ARE THE WHOLE DESIGN, and they are why this tier is capped separately rather than
// sharing the leg's `--limit`. One catalogue row is one RENDERED page scrape through Firecrawl —
// the slowest and only metered call in this sweep — and the catalogue is five figures. So the
// default is 5 a tick: enough that newly crawled rows accrete their buy link steadily, small enough
// that the tier can never quietly become the sweep's dominant spend. The operator raises
// FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT when he wants that spend, and 0 turns the tier off.
//
// WHY THE CAP IS A WORKER ENV VAR AND NOT A CLI FLAG. The box drives this leg through its PINNED
// `fluncle` CLI, and a pin that predates a new flag fails the whole run outright (`Unknown option
// '--limit'`, seen live — the note above the freshness tap's missing CLI command records it). A
// Worker var also puts the spending cap where the spending happens: the Worker holds
// FIRECRAWL_API_KEY, so one place decides how much of it this tier may burn, and changing it is a
// var edit rather than a box rebake.
//
// AND WHY THE WORKLIST IS `attempted_at is null`, NOT THE FINDINGS TIER'S COOLDOWN. Verified while
// building this: the certified tier gates on `shouldSkip`, whose base cooldown is 24h — so a
// concluded no-match there becomes eligible again a day later. That is survivable across ~85
// findings and would be ruinous across the catalogue, where it would re-spend a Firecrawl credit on
// every row the operator's campaign already concluded, forever. No re-check cadence is ruled for
// Beatport (the identity envelope serves `retry: "single-shot"` because none is), so this tier asks
// once: a row that has ever concluded is out, and only a row nothing has ever concluded on is in.
// A row whose scrape FAILED is still in (`failures > 0` re-admits it), held back by the same
// failure-scaled backoff the rest of the module uses.

/** One catalogue Beatport candidate — identity plus the ledger the backoff gate reads. */
type BeatportCatalogueCandidate = {
  artists: string[];
  attemptedAt: null | string;
  failures: number;
  isrc: string;
  title: string;
  trackId: string;
};

// The default per-tick catalogue sub-cap. Small on purpose (see the section header); the operator
// raises it via FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT when he wants the spend.
const BEATPORT_CATALOGUE_DEFAULT_LIMIT = 5;

// The ceiling the operator's var is clamped to, so a fat-fingered value cannot turn one tick into
// an unbounded Firecrawl bill. Raising the real ceiling is a deliberate code change.
const BEATPORT_CATALOGUE_MAX_LIMIT = 50;

/**
 * How many catalogue rows this tick may scrape. Reads the operator's var, falling back to the small
 * default; a non-numeric or negative value falls back too (a typo must never silently widen spend),
 * and an explicit `0` is honoured as a kill switch for the tier.
 */
async function beatportCatalogueLimit(): Promise<number> {
  const raw = await readOptionalEnv("FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT");

  if (raw === undefined) {
    return BEATPORT_CATALOGUE_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return BEATPORT_CATALOGUE_DEFAULT_LIMIT;
  }

  return Math.min(parsed, BEATPORT_CATALOGUE_MAX_LIMIT);
}

/**
 * Read the catalogue Beatport worklist: uncertified rows carrying an ISRC and no link, that nothing
 * has ever concluded on — or that only ever FAILED, which concluded nothing and so is re-admitted.
 * Ordered by the Ear's capture-priority ladder, the same free ordering the Apple drain uses. The
 * precise failure-scaled cooldown is refined per row in TS; the SQL applies only the base cutoff.
 */
async function listBeatportCatalogueWork(limit: number): Promise<BeatportCatalogueCandidate[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "beatport-catalogue", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }
    const placeholders = page.subjectIds.map(() => "?").join(", ");
    const result = await db.execute({
      args: page.subjectIds,
      sql: `select t.track_id, t.isrc, t.title, t.artists_json,
                   t.backfill_beatport_attempted_at as attempted_at,
                   t.backfill_beatport_failures as failures
            from tracks t
            where t.track_id in (${placeholders})`,
    });
    const byId = new Map(
      typedRows<{
        artists_json: null | string;
        attempted_at: null | string;
        failures: null | number;
        isrc: string;
        title: string;
        track_id: string;
      }>(result.rows).map((row) => [
        row.track_id,
        {
          artists: parseArtistsJson(row.artists_json ?? "[]"),
          attemptedAt: row.attempted_at,
          failures: typeof row.failures === "number" ? row.failures : 0,
          isrc: row.isrc,
          title: row.title,
          trackId: row.track_id,
        },
      ]),
    );
    return page.subjectIds
      .map((trackId) => byId.get(trackId))
      .filter((candidate): candidate is BeatportCatalogueCandidate => candidate !== undefined);
  }

  // GOAL H: remove this unchanged legacy corpus selector after the due-work cutover proves out.
  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const result = await db.execute({
    args: [cutoff, limit],
    // `title` + `artists_json` ride the worklist read so the drain needs no per-row lookup: they
    // steer Beatport's SEARCH, while the link itself is authorised by exact ISRC equality alone.
    sql: `select t.track_id, t.isrc, t.title, t.artists_json,
                 t.backfill_beatport_attempted_at as attempted_at,
                 t.backfill_beatport_failures as failures
          from tracks t
          where t.is_catalogue = 1
            and t.beatport_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_beatport_done_at is null
            and (t.backfill_beatport_attempted_at is null
                 or (t.backfill_beatport_failures > 0
                     and t.backfill_beatport_attempted_at < ?))
          order by t.capture_priority desc, t.track_id desc
          limit ?`,
  });

  return typedRows<{
    artists_json: null | string;
    attempted_at: null | string;
    failures: null | number;
    isrc: string;
    title: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json ?? "[]"),
    attemptedAt: row.attempted_at,
    failures: typeof row.failures === "number" ? row.failures : 0,
    isrc: row.isrc,
    title: row.title,
    trackId: row.track_id,
  }));
}

/**
 * Drain the catalogue tier: up to the sub-cap, one keyless ISRC-exact Beatport resolve each, with
 * the same ledger writes the findings tier makes (`done` on a match, `tried` on a concluded
 * no-match, `failure` on a scrape error). Returns this tier's rows for the caller's summary.
 */
async function drainBeatportCatalogue(dryRun: boolean): Promise<{
  failed: Array<{ error: string; trackId: string }>;
  resolved: Array<{ trackId: string; url: string }>;
  unresolved: string[];
}> {
  const resolved: Array<{ trackId: string; url: string }> = [];
  const unresolved: string[] = [];
  const failed: Array<{ error: string; trackId: string }> = [];
  const limit = await beatportCatalogueLimit();

  if (limit === 0) {
    // The operator has switched the tier off. No read, no spend.
    return { failed, resolved, unresolved };
  }

  const now = Date.now();
  const candidates = await listBeatportCatalogueWork(limit);
  // The precise failure-scaled cooldown, refined per row. `isDone: false` because a done row is not
  // in the worklist at all — the `done_at is null` predicate already removed it.
  const eligible = candidates.filter(
    (candidate) =>
      !shouldSkip(
        { attemptedAt: candidate.attemptedAt, failures: candidate.failures, isDone: false },
        now,
      ),
  );

  if (dryRun) {
    // Preview the eligible set (as `unresolved` — the "would be scraped" set), no call, no write.
    for (const candidate of eligible) {
      unresolved.push(candidate.trackId);
    }

    return { failed, resolved, unresolved };
  }

  for (const candidate of eligible) {
    const outcome = await resolveBeatportUrl({
      artists: candidate.artists,
      isrc: candidate.isrc,
      title: candidate.title,
    });

    if (!outcome.configured) {
      // Unconfigured mid-drain (a key pulled between calls): stop, stamp nothing.
      break;
    }

    if (!outcome.ok) {
      await recordAttempt(candidate.trackId, "beatport", "failure");
      failed.push({ error: outcome.error, trackId: candidate.trackId });
      continue;
    }

    if (!outcome.url) {
      await recordAttempt(candidate.trackId, "beatport", "tried");
      unresolved.push(candidate.trackId);
      continue;
    }

    await setBeatportUrl(candidate.trackId, outcome.url);
    await recordAttempt(candidate.trackId, "beatport", "done");
    resolved.push({ trackId: candidate.trackId, url: outcome.url });
  }

  return { failed, resolved, unresolved };
}

// ── Apple Music — the CATALOGUE drain (RFC musickit-second-authority, U1) ────────────────────
//
// The findings sweep above rides the public FEED (an inner join onto the certification), so it is
// structurally blind to a CATALOGUE track (a `tracks` row with no `findings` row) — the same hole
// track-work.ts fixed for the audio pipeline. This is that fix for the Apple read: a worklist
// derived straight off `tracks`, gated only by the reliability columns that MOVED to `tracks`.
//
// It uses the BATCHED oracle (≤25 ISRCs/request) for the URL — the cheap half, one request per 25
// rows — and fires the single-ISRC oracle only for the NEW albums the drain encounters, to
// populate their second-authority facts once. No cursor: the worklist is a fresh reliability-gated
// anti-join each tick, so a drained (done/cooling) row simply drops out of the next read.

/** The catalogue worklist candidate — identity + the reliability columns the gate reads. */
type CatalogueAppleCandidate = {
  albumId: null | string;
  attemptedAt: null | string;
  failures: number;
  isrc: string;
  trackId: string;
};

/** One catalogue drain pass's numbers. No cursor — the worklist self-drains by reliability. */
export type AppleCatalogueBackfillResult = {
  albumFactsWritten: number;
  breakerTripped: boolean;
  configured: boolean;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  rateLimited: boolean;
  resolved: Array<{ trackId: string; url: string }>;
  resolvedCount: number;
  // ISRCs Apple has no song for (a clean no-match, base cooldown, re-checkable if Apple grows).
  unresolved: string[];
  unresolvedCount: number;
};

// A catalogue drain reads at most this many candidates a pass (the batched oracle chunks them at
// 25/request internally). Larger than the findings `MAX_BATCH` because a batched URL read is one
// cheap request per 25 rows, not one paced request per row.
const CATALOGUE_APPLE_MAX_BATCH = 100;

// At most this many NEW albums get their facts resolved per pass — each is a paced single-ISRC
// call, so this bounds the pass's wall time independently of how many URLs the batch resolved.
const CATALOGUE_FACTS_MAX_PER_PASS = 10;

/**
 * Read the catalogue Apple worklist: uncertified tracks (no `findings` row) that carry an ISRC,
 * have no Apple URL yet, are not done, and are past their base cooldown. Ordered by the Ear's
 * capture-priority ladder so the rows nearest the archive resolve first (a free ordering — the
 * URL read is not metered). The precise failure-scaled cooldown is refined in TS per row.
 */
async function listCatalogueAppleWork(limit: number): Promise<CatalogueAppleCandidate[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "apple-catalogue", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }
    const placeholders = page.subjectIds.map(() => "?").join(", ");
    const result = await db.execute({
      args: page.subjectIds,
      sql: `select t.track_id, t.isrc, t.album_id,
                   t.backfill_apple_music_attempted_at as attempted_at,
                   t.backfill_apple_music_failures as failures
            from tracks t
            where t.track_id in (${placeholders})`,
    });
    const byId = new Map(
      typedRows<{
        album_id: null | string;
        attempted_at: null | string;
        failures: null | number;
        isrc: string;
        track_id: string;
      }>(result.rows).map((row) => [
        row.track_id,
        {
          albumId: row.album_id,
          attemptedAt: row.attempted_at,
          failures: typeof row.failures === "number" ? row.failures : 0,
          isrc: row.isrc,
          trackId: row.track_id,
        },
      ]),
    );
    return page.subjectIds
      .map((trackId) => byId.get(trackId))
      .filter((candidate): candidate is CatalogueAppleCandidate => candidate !== undefined);
  }

  // GOAL H: remove this unchanged legacy corpus selector after the due-work cutover proves out.
  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const result = await db.execute({
    args: [cutoff, limit],
    sql: `select t.track_id, t.isrc, t.album_id,
                 t.backfill_apple_music_attempted_at as attempted_at,
                 t.backfill_apple_music_failures as failures
          from tracks t
          where t.is_catalogue = 1
            and t.apple_music_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_apple_music_done_at is null
            and (t.backfill_apple_music_attempted_at is null
                 or t.backfill_apple_music_attempted_at < ?)
          -- The full tracks_vendor_worklist_idx includes nullable capture priorities and carries
          -- this exact is_catalogue/order/tiebreak shape. Never-ranked NULL rows remain eligible and
          -- sort last without restoring the redundant capture-priority singleton.
          order by t.capture_priority desc, t.track_id desc
          limit ?`,
  });

  return typedRows<{
    album_id: null | string;
    attempted_at: null | string;
    failures: null | number;
    isrc: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    albumId: row.album_id,
    attemptedAt: row.attempted_at,
    failures: typeof row.failures === "number" ? row.failures : 0,
    isrc: row.isrc,
    trackId: row.track_id,
  }));
}

/**
 * Drain one bounded pass of the CATALOGUE Apple worklist. Batched URL resolve for every eligible
 * row; single-ISRC facts resolve for the new albums it encounters. Reliability + the cross-cutting
 * breaker/meter gate the whole thing exactly like the findings sweep. NO-OP until configured.
 */
export async function backfillAppleMusicCatalogue(
  limit: number,
  dryRun: boolean,
): Promise<AppleCatalogueBackfillResult> {
  const resolved: AppleCatalogueBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const failed: AppleCatalogueBackfillResult["failed"] = [];
  const now = Date.now();
  let albumFactsWritten = 0;

  const empty = (over: Partial<AppleCatalogueBackfillResult>): AppleCatalogueBackfillResult => ({
    albumFactsWritten,
    breakerTripped: false,
    configured: true,
    dryRun,
    failed,
    failedCount: failed.length,
    rateLimited: false,
    resolved,
    resolvedCount: resolved.length,
    unresolved,
    unresolvedCount: unresolved.length,
    ...over,
  });

  const page = Math.max(1, Math.min(limit, CATALOGUE_APPLE_MAX_BATCH));
  const candidates = await listCatalogueAppleWork(page);

  // The precise failure-scaled cooldown, refined per row (the SQL applied only the base cutoff).
  const eligible = candidates.filter(
    (candidate) =>
      !shouldSkip(
        { attemptedAt: candidate.attemptedAt, failures: candidate.failures, isDone: false },
        now,
      ),
  );

  if (eligible.length === 0) {
    return empty({});
  }

  if (dryRun) {
    // Preview the eligible set (as `unresolved` — the "would resolve" set) without any call.
    for (const candidate of eligible) {
      unresolved.push(candidate.trackId);
    }

    return empty({});
  }

  // THE BREAKER + METER — consult once before the batch (RFC U1).
  if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
    return empty({ breakerTripped: true });
  }

  const byIsrc = new Map<string, CatalogueAppleCandidate>();

  for (const candidate of eligible) {
    // First-seen wins per ISRC (two catalogue rows can share one) — the loser is left for a
    // later pass rather than double-counted.
    if (!byIsrc.has(candidate.isrc)) {
      byIsrc.set(candidate.isrc, candidate);
    }
  }

  // Record one meter tick per underlying request the oracle will make (one per ≤25 ISRCs).
  const chunks = Math.ceil(byIsrc.size / 25);

  for (let i = 0; i < chunks; i += 1) {
    await recordAppleCall(now);
  }

  const outcome = await appleCatalogLookupByIsrcs([...byIsrc.keys()]);

  if (!outcome.configured) {
    return empty({ configured: false });
  }

  if (!outcome.ok) {
    await recordAppleAuthOutcome(appleOutcomeKind(outcome), now);

    // A 429 backs the pass off; a 401/403 has already advanced the breaker. Either way stop
    // cleanly — record nothing on the rows (they stay eligible), resume next tick.
    return empty({ breakerTripped: Boolean(outcome.authFailed), rateLimited: outcome.rateLimited });
  }

  await recordAppleAuthOutcome("ok", now);

  // The albums that still need facts among the resolved rows — deduped to ONE track per album.
  const factsQueue: CatalogueAppleCandidate[] = [];
  const albumsSeen = new Set<string>();

  for (const [isrc, candidate] of byIsrc) {
    const bundle = outcome.bundles.get(isrc);

    if (!bundle) {
      // Apple has no song for this ISRC — a clean TRIED (base cooldown), re-checkable later.
      await recordAttempt(candidate.trackId, "apple_music", "tried");
      unresolved.push(candidate.trackId);
      continue;
    }

    // A catalogue row has no `findings` row — write the URL alone (no lastmod to bump).
    await setAppleMusicUrl(candidate.trackId, bundle.songUrl, false);
    await recordAttempt(candidate.trackId, "apple_music", "done");
    resolved.push({ trackId: candidate.trackId, url: bundle.songUrl });

    if (candidate.albumId && !albumsSeen.has(candidate.albumId)) {
      albumsSeen.add(candidate.albumId);
      factsQueue.push(candidate);
    }
  }

  // Facts, once per NEW album the drain encountered — a single-ISRC oracle read each, paced and
  // bounded, and only for albums whose row still lacks facts.
  albumFactsWritten += await drainCatalogueAlbumFacts(factsQueue, now);

  return empty({});
}

/**
 * Resolve + store album facts for up to {@link CATALOGUE_FACTS_MAX_PER_PASS} of the given
 * candidates whose album row still needs them, one paced single-ISRC oracle read each. Returns
 * how many album rows were written. Consults the breaker/meter before each call; a trip stops the
 * facts drain early (the URLs are already written — facts catch up on a later pass).
 */
async function drainCatalogueAlbumFacts(
  candidates: CatalogueAppleCandidate[],
  now: number,
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }

  // Pre-filter to the albums that actually need facts (`apple_album_id is null`), in ONE read, so
  // we never spend a single-ISRC call on an album already stamped.
  const db = await getDb();
  const byTrack = new Map(candidates.map((candidate) => [candidate.trackId, candidate]));
  const placeholders = candidates.map(() => "?").join(", ");
  const need = await db.execute({
    args: candidates.map((candidate) => candidate.trackId),
    sql: `select t.track_id
          from tracks t
          join albums a on a.id = t.album_id
          where t.track_id in (${placeholders}) and a.apple_album_id is null`,
  });

  const needing = typedRows<{ track_id: string }>(need.rows)
    .map((row) => byTrack.get(row.track_id))
    .filter((candidate): candidate is CatalogueAppleCandidate => candidate !== undefined)
    .slice(0, CATALOGUE_FACTS_MAX_PER_PASS);

  let written = 0;
  let first = true;

  for (const candidate of needing) {
    if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
      break;
    }

    if (!first) {
      await delay(APPLE_MUSIC_DELAY_MS);
    }
    first = false;

    await recordAppleCall(now);
    const outcome = await appleCatalogLookupByIsrc(candidate.isrc);

    if (!outcome.configured) {
      break;
    }

    if (!outcome.ok) {
      await recordAppleAuthOutcome(appleOutcomeKind(outcome), now);
      break;
    }

    await recordAppleAuthOutcome("ok", now);

    if (outcome.bundle && (await storeAlbumFactsForTrack(candidate.trackId, outcome.bundle))) {
      written += 1;
    }
  }

  return written;
}

// ── Deezer — the FORWARD-ACCRETION leg ───────────────────────────────────────────────────────
//
// The id-retention slice kept the Deezer track ids three existing reads already carried and threw
// away (schema.ts § `deezer_track_id`), and was deliberately FORWARD-ONLY: no sweep, so a row only
// ever filled when one of those three paths happened to run over it. The operator's catalogue-wide
// campaign then filled the historical archive by hand. This leg is what stops the gap RE-OPENING:
// every newly crawled row now accretes its Deezer link on its own, the way Apple's catalogue drain
// already does, instead of waiting for the next manual campaign.
//
// ONE LEG, BOTH TIERS. Unlike the Apple pair (a findings sweep + a separate catalogue drain), this
// is a single leg that drains CERTIFIED rows first and then the catalogue in the Ear's
// capture-priority order. That is possible here because the read is cheap and identical for both —
// the column is on `tracks`, the gate is the row's own duration, and a finding needs no lastmod
// bump (a link on an existing recording moves no finding, schema.ts). Two worklist reads rather
// than one sorted union, deliberately: the Deezer gate matches nearly every row in the table today,
// so a single `order by certified, capture_priority` would sort tens of thousands of rows every
// tick, while each tier's own read rides an index and stops at its LIMIT.
//
// KEYLESS, AND METERED BY THE CAP RATHER THAN A BREAKER. `GET /track/isrc:<ISRC>` takes no token,
// so there is nothing to provision and no `configured` flag to report — the leg is live the moment
// it ships. What it does have is Deezer's PER-IP quota, and the Worker egresses from Cloudflare's
// SHARED edge IPs where that quota is spent by the whole platform rather than by Fluncle (measured:
// the search rung recovered 0 of 5,133 rows from the edge while answering 25/25 from the box's own
// IP — deezer.ts's header). So the default cap stays small, the calls are paced, and a throttle
// ends the pass instead of failing the row.
//
// THE LEDGER LAW (schema.ts § `backfill_deezer_*`), which is what this leg is really built around:
// stamp ONLY an outcome that settles whether Deezer carries the recording.
//   · a duration-vouched hit → the id trio + `done` (first-write-wins);
//   · a `DataException` miss → `tried` (attempted + counted, done_at null) — the honest negative
//     that lets `/identity` say "Not found · checked <date>" instead of "Not checked yet";
//   · found-but-unvouchable  → the failure STREAK only, like a transport failure. Deezer picked
//     something whose duration disagrees — neither a hit nor a miss, so no receipt is written —
//     but the streak must move or the `attempted_at is null` worklist re-serves the same
//     unvouchable rows every tick forever;
//   · a THROTTLE (quota code 4, arriving in an HTTP-200 body) → NOTHING, and the pass ENDS. This is
//     the known ledger poison: the quota answer is indistinguishable from a miss to any client that
//     only checks `data`, and stamping it would mark a whole tick's rows "not on Deezer" because a
//     neighbour on the shared IP burst;
//   · a transport failure → the failure STREAK only, never `attempted_at`. The row stays in the
//     worklist (whose predicate is `attempted_at is null`) and retries on a later tick until the
//     streak hits its cap, at which point it drops out rather than burning the budget forever.

/** One Deezer worklist candidate — identity plus the duration the gate needs. */
type DeezerCandidate = {
  durationMs: number;
  isrc: string;
  trackId: string;
};

/** One bounded Deezer pass's numbers. No cursor — the worklist self-drains by the ledger. */
export type DeezerBackfillResult = {
  dryRun: boolean;
  // Rows whose lookup errored in transport — nothing was learned, the streak backs them off.
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  // True when the pass STOPPED on Deezer's quota answer. Nothing was stamped, so every remaining
  // row stays eligible for the next tick's fresh window.
  rateLimited: boolean;
  resolved: Array<{ trackId: string; url: string }>;
  resolvedCount: number;
  // ISRCs Deezer answered `DataException` for — a concluded miss, stamped.
  unresolved: string[];
  unresolvedCount: number;
  // Rows Deezer PICKED a track for whose duration did not vouch. Stamped NOTHING, so they stay
  // eligible; surfaced separately because a rising count here means the gate is doing its job.
  unvouchable: string[];
  unvouchableCount: number;
};

// At most this many rows per pass. Deliberately modest: the Worker shares Cloudflare's egress IPs
// with the whole platform, and Deezer's tokenless quota is per-IP, so a big burst is exactly how a
// tick earns a quota answer for rows that would otherwise have resolved. 25 paced reads is ~9s of
// wall time — comfortably inside the request budget — and the box drives one pass per tick.
const DEEZER_MAX_BATCH = 25;

// Pace between reads, for the same shared-IP reason. The sibling search client carries no pacing
// gate because the anchor waterfall makes exactly ONE Deezer call per request; this leg makes up to
// DEEZER_MAX_BATCH in a row, so it supplies the cadence the waterfall got for free.
const DEEZER_DELAY_MS = 250;

// A row whose lookup has errored this many times in a row leaves the worklist. Transport failures
// stamp only the streak (never `attempted_at`), so without this cap a permanently unreadable row
// would re-enter every tick forever and eat the small per-tick budget. The row is not concluded —
// nothing is written to the ledger — it is simply no longer asked about.
const DEEZER_MAX_FAILURES = 3;

/** The shared worklist gate, spelled once so the two tiers cannot drift apart. */
const DEEZER_WORK_GATE = `t.deezer_track_id is null
  and t.backfill_deezer_attempted_at is null
  and t.backfill_deezer_failures < ?
  and t.isrc is not null and trim(t.isrc) <> ''
  and t.duration_ms > 0`;

/**
 * Read the Deezer worklist: CERTIFIED rows first (newest finding first), then CATALOGUE rows in the
 * Ear's capture-priority order — the same ladder the Apple catalogue drain reads by, and for the
 * same reason (the rows nearest his taste resolve first).
 *
 * WHY `attempted_at is null` RATHER THAN A COOLDOWN. This leg accretes forward; it is not a
 * re-check cadence, and no re-check cadence is ruled for Deezer (the identity envelope serves
 * `retry: "single-shot"` precisely because none is). A concluded miss is therefore permanent until
 * someone rules otherwise, which is also what keeps the operator's completed campaign from being
 * re-spent: every row it concluded carries a stamp, and a stamped row is not in this worklist.
 *
 * `duration_ms > 0` is a WORKLIST predicate, not just a runtime guard: without a duration there is
 * nothing to vouch a pick with, so such a row could only ever come back `unvouchable` — which
 * stamps nothing, which would leave it in the worklist to be re-asked forever. Excluding it in SQL
 * means the budget is never spent on a question that cannot be answered.
 */
async function listDeezerWork(limit: number): Promise<DeezerCandidate[]> {
  const db = await getDb();

  const toCandidates = (rows: Parameters<typeof typedRows>[0]): DeezerCandidate[] =>
    typedRows<{ duration_ms: number; isrc: string; track_id: string }>(rows).map((row) => ({
      durationMs: Number(row.duration_ms),
      isrc: row.isrc,
      trackId: row.track_id,
    }));

  if (await isDueWorkCutoverEnabled()) {
    const findingPage = await readPromotedDueWorkPage(db, "deezer-finding", { limit });
    const subjectIds = [...findingPage.subjectIds];
    const remaining = limit - subjectIds.length;
    if (remaining > 0) {
      const cataloguePage = await readPromotedDueWorkPage(db, "deezer-catalogue", {
        limit: remaining,
      });
      subjectIds.push(...cataloguePage.subjectIds);
    }
    if (subjectIds.length === 0) {
      return [];
    }
    const placeholders = subjectIds.map(() => "?").join(", ");
    const result = await db.execute({
      args: subjectIds,
      sql: `select t.track_id, t.isrc, t.duration_ms
            from tracks t
            where t.track_id in (${placeholders})`,
    });
    const byId = new Map(
      toCandidates(result.rows).map((candidate) => [candidate.trackId, candidate]),
    );
    return subjectIds
      .map((trackId) => byId.get(trackId))
      .filter((candidate): candidate is DeezerCandidate => candidate !== undefined);
  }

  // GOAL H: remove these unchanged legacy corpus selectors after the due-work cutover proves out.

  const certified = await db.execute({
    args: [DEEZER_MAX_FAILURES, limit],
    // Driven FROM `findings` (a small table) rather than scanning `tracks` for the certified
    // slice — the join is by primary key, so the tier costs one seek per finding.
    sql: `select t.track_id, t.isrc, t.duration_ms
          from findings f
          join tracks t on t.track_id = f.track_id
          where ${DEEZER_WORK_GATE}
          order by f.added_at desc, t.track_id
          limit ?`,
  });

  const candidates = toCandidates(certified.rows);

  if (candidates.length >= limit) {
    return candidates;
  }

  const catalogue = await db.execute({
    args: [DEEZER_MAX_FAILURES, limit - candidates.length],
    // The full tracks_vendor_worklist_idx includes nullable capture priorities and carries this
    // exact is_catalogue/order/tiebreak shape. Never-ranked NULL rows remain eligible and sort last
    // without restoring the redundant capture-priority singleton.
    sql: `select t.track_id, t.isrc, t.duration_ms
          from tracks t
          where t.is_catalogue = 1
            and ${DEEZER_WORK_GATE}
          order by t.capture_priority desc, t.track_id desc
          limit ?`,
  });

  return [...candidates, ...toCandidates(catalogue.rows)];
}

/**
 * Write a vouched Deezer id, its provenance, and the ledger — in ONE statement.
 *
 * The trio is FIRST-WRITE-WINS through `coalesce` (schema.ts § `deezer_track_id`), so a row can
 * never wear an id with another path's provenance and this leg never clobbers what the anchor rung
 * or a publish already won. `deezer_verified_by` is `"isrc"`: the id came off `/track/isrc:` and
 * was duration-confirmed, which is exactly what that value is defined to mean.
 *
 * The ledger rides the same statement so an attempt and its outcome can never be recorded apart —
 * `done_at` coalesces on the same first-write-wins rule and binds the same instant as
 * `deezer_verified_at`, so the moment the link was won and the moment the ledger says it resolved
 * cannot drift. `failures` resets: the streak counts CONSECUTIVE failures, and this is a success.
 *
 * NO `findings.updated_at` BUMP, unlike the Apple write and like the Beatport one: a link on an
 * existing recording moves no finding's public lastmod (schema.ts says so in as many words).
 */
async function setDeezerTrackId(trackId: string, deezerTrackId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [deezerTrackId, "isrc", now, now, now, trackId],
        sql: `update tracks
          set deezer_track_id = coalesce(deezer_track_id, ?),
            deezer_verified_by = coalesce(deezer_verified_by, ?),
            deezer_verified_at = coalesce(deezer_verified_at, ?),
            backfill_deezer_attempted_at = ?,
            backfill_deezer_attempts = backfill_deezer_attempts + 1,
            backfill_deezer_done_at = coalesce(backfill_deezer_done_at, ?),
            backfill_deezer_failures = 0
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-deezer-resolve" },
  );
}

/**
 * Stamp a CONCLUDED Deezer miss — Deezer looked and carries no recording under this ISRC.
 * `attempted_at` moves and `attempts` increments (the monotone tally the identity envelope prints);
 * `done_at` stays null because nothing resolved, and `failures` resets because this branch IS a
 * clean conclusion rather than the transport failure a streak backs off from.
 */
async function recordDeezerMiss(trackId: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [new Date().toISOString(), trackId],
        sql: `update tracks
          set backfill_deezer_attempted_at = ?,
            backfill_deezer_attempts = backfill_deezer_attempts + 1,
            backfill_deezer_failures = 0
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-deezer-miss" },
  );
}

/**
 * Record a TRANSPORT failure — the streak, and nothing else. Deliberately NOT `attempted_at`: the
 * worklist gates on that column, so stamping it here would silently conclude a row nothing was
 * learned about, and `/identity` would start reading "Not found · checked <date>" off a timeout.
 * The streak alone backs the row off (and eventually past {@link DEEZER_MAX_FAILURES} out of the
 * worklist) while the receipt keeps telling the truth: nobody has concluded anything yet.
 */
async function recordDeezerFailure(trackId: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [trackId],
        sql: `update tracks
          set backfill_deezer_failures = backfill_deezer_failures + 1
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-deezer-failure" },
  );
}

/**
 * Drain one bounded pass of the Deezer worklist — certified rows first, then the Ear-ranked
 * catalogue. One keyless `/track/isrc:` read per row, gated on exact duration agreement, with the
 * ledger law above deciding what (if anything) each outcome writes.
 */
export async function backfillDeezer(
  limit: number,
  dryRun: boolean,
): Promise<DeezerBackfillResult> {
  const resolved: DeezerBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const unvouchable: string[] = [];
  const failed: DeezerBackfillResult["failed"] = [];

  const summarize = (over: Partial<DeezerBackfillResult>): DeezerBackfillResult => ({
    dryRun,
    failed,
    failedCount: failed.length,
    rateLimited: false,
    resolved,
    resolvedCount: resolved.length,
    unresolved,
    unresolvedCount: unresolved.length,
    unvouchable,
    unvouchableCount: unvouchable.length,
    ...over,
  });

  const page = Math.max(1, Math.min(limit, DEEZER_MAX_BATCH));
  const candidates = await listDeezerWork(page);

  if (candidates.length === 0) {
    return summarize({});
  }

  if (dryRun) {
    // Preview the eligible set (as `unresolved` — the "would be asked about" set) without a call.
    for (const candidate of candidates) {
      unresolved.push(candidate.trackId);
    }

    return summarize({});
  }

  let first = true;

  for (const candidate of candidates) {
    if (!first) {
      await delay(DEEZER_DELAY_MS);
    }
    first = false;

    const outcome = await lookupDeezerTrackByIsrc(candidate.isrc, candidate.durationMs);

    if (outcome.outcome === "quota") {
      // THE THROTTLE. Stop the whole pass rather than marching the rest of the batch into the same
      // spent window — and stamp nothing, so every remaining row is untouched next tick.
      return summarize({ rateLimited: true });
    }

    if (outcome.outcome === "failed") {
      await recordDeezerFailure(candidate.trackId);
      failed.push({ error: outcome.error, trackId: candidate.trackId });
      continue;
    }

    if (outcome.outcome === "unvouchable") {
      // Found, not vouched for. No RECEIPT is written (the ledger law holds: neither `absent` nor
      // `verified` is true of this row) — but the can't-conclude STREAK moves, because writing
      // nothing at all causes a starvation loop: the worklist's
      // `attempted_at is null` predicate re-served the same top-priority unvouchable rows every
      // tick forever, and every row behind them starved. `failures` is exactly the right column —
      // it counts attempts that settled nothing, the envelope never reads it, and the
      // `failures < cap` gate retires a thrice-unvouchable row from the budget while its receipt
      // honestly stays "Not checked yet".
      await recordDeezerFailure(candidate.trackId);
      unvouchable.push(candidate.trackId);
      continue;
    }

    if (outcome.outcome === "absent") {
      await recordDeezerMiss(candidate.trackId);
      unresolved.push(candidate.trackId);
      continue;
    }

    await setDeezerTrackId(candidate.trackId, outcome.deezerTrackId);
    resolved.push({
      trackId: candidate.trackId,
      url: `https://www.deezer.com/track/${encodeURIComponent(outcome.deezerTrackId)}`,
    });
  }

  return summarize({});
}

// One pass never handles more than MAX_BATCH eligible findings, so a single
// request stays inside the Worker budget regardless of the caller's `limit`. A
// caller asking for fewer (a small probe) is honoured.
function batchLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MAX_BATCH));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

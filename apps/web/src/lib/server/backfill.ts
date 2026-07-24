// Admin-gated, idempotent, Worker-paced catalogue backfills for the two music-graph
// writes that landed AFTER the synchronous add already existed:
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
// Both are Worker-owned (the Worker holds LASTFM_* / DISCOGS_USER_TOKEN) and
// best-effort PER FINDING: one bad finding counts as a failure and the sweep
// continues. Neither triggers the publish fan-out (no Spotify playlist add, no
// Telegram) — this is a side-channel repair over rows that are already published.
//
// ── Reliability (the "Worker-paced" model) ──────────────────────────────────
// The box holds NO vendor keys, so the API calls happen HERE (in the Worker); the
// box `--no-agent` cron just drives one small batch per tick via the CLI. To keep
// from re-storming a vendor API across ticks, each finding carries per-source
// reliability state in the `tracks` row (backfill_{discogs,lastfm}_{attempted_at,
// attempts,failures,done_at}). Before any vendor call the sweep SKIPS a finding
// that is already done or was tried within a cooldown window; the window grows
// with the consecutive-failure count, so a rate-limited finding backs off
// exponentially instead of being retried every tick. After the call the outcome
// is recorded so the next tick resumes from a clean, durable state.

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
import { getDb, typedRows } from "./db";
import { discogsResolveRelease } from "./discogs";
import { lastfmLove } from "./lastfm";
import { decodeTrackCursor, encodeTrackCursor, listTracks, type TrackListItem } from "./tracks";

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
  dryRun: boolean;
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
export type BackfillSource = "apple_music" | "discogs" | "lastfm" | "note";

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
// have no `findings` row — RFC musickit-second-authority U1); the finding-only sweeps
// (discogs/lastfm/note) stay on `findings`. A static literal, never interpolated user input.
function reliabilityTable(source: BackfillSource): "findings" | "tracks" {
  return source === "apple_music" ? "tracks" : "findings";
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

  await db.execute({
    args,
    sql: `update ${reliabilityTable(source)}
      set ${p}_attempted_at = ?,
        ${p}_attempts = ${p}_attempts + 1,
        ${doneClause}
        ${failuresClause}
      where track_id = ?`,
  });
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
  startCursor: string | undefined,
  limit: number,
  // `true` = handled (counts toward the limit); `false` = skipped; `"stop"` = a
  // circuit breaker tripped (e.g. the vendor is rate-limiting) — abort the pass
  // immediately rather than marching the next finding into the same wall.
  visit: (track: TrackListItem) => Promise<boolean | "stop">,
): Promise<string | null> {
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
): Promise<DiscogsBackfillResult> {
  const resolved: DiscogsBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let first = true;
  let rateLimited = false;

  const nextCursor = await runPublishedFindingPass(
    startCursor,
    batchLimit(limit),
    async (track) => {
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

      // Pace the calls (skip the wait before the first one).
      if (!first) {
        await delay(DISCOGS_DELAY_MS);
      }
      first = false;

      // discogsResolveRelease never throws; {} = unresolved (below the gate or no
      // token). `rateLimited` distinguishes "throttled" from "no match" so we can
      // back off the former hard instead of re-hitting it next tick.
      const enrichment = await discogsResolveRelease({
        album: track.album,
        artists: track.artists,
        isrc: track.isrc,
        label: track.label,
        releaseDate: track.releaseDate,
        title: track.title,
      });

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

      resolved.push({
        logId,
        masterId: enrichment.masterId,
        releaseId: enrichment.releaseId,
        // The resolver doesn't surface which leg matched (MB bridge vs scored
        // search), so the source is the resolver itself.
        source: "discogs",
      });

      return true;
    },
  );

  return {
    dryRun,
    // On a throttle-stop, NULL the cursor so even the currently-deployed CLI (which
    // breaks only on a null cursor, not the newer `rateLimited` flag) stops looping
    // this tick instead of re-firing the cursor into the same 429 wall to the 120s
    // timeout. Losing the resume point is harmless: the cron starts each tick from
    // the top and the reliability gate re-skips done/cooling findings cheaply.
    nextCursor: rateLimited ? null : nextCursor,
    rateLimited,
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
  await db.batch(
    [
      {
        args: [releaseId, masterId ?? null, trackId],
        sql: `update tracks
          set in_release_id = ?,
            in_master_id = ?
          where track_id = ?`,
      },
      {
        args: [new Date().toISOString(), trackId],
        sql: `update findings set updated_at = ? where track_id = ?`,
      },
    ],
    "write",
  );
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

  await db.batch(statements, "write");
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
  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const result = await db.execute({
    args: [cutoff, limit],
    sql: `select t.track_id, t.isrc, t.album_id,
                 t.backfill_apple_music_attempted_at as attempted_at,
                 t.backfill_apple_music_failures as failures
          from tracks t
          left join findings f on f.track_id = t.track_id
          where f.track_id is null
            and t.apple_music_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_apple_music_done_at is null
            and (t.backfill_apple_music_attempted_at is null
                 or t.backfill_apple_music_attempted_at < ?)
          -- Plain desc (no coalesce wrapper) rides tracks_capture_priority_idx and sorts NULLs last:
          -- functionally equivalent to coalesce-as-0 for a priority worklist (NULL/0 rows are lowest
          -- and taken last, top-priority rows unaffected). docs/db-scale-backlog Wave 1 #13.
          order by t.capture_priority desc, t.track_id
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

// One pass never handles more than MAX_BATCH eligible findings, so a single
// request stays inside the Worker budget regardless of the caller's `limit`. A
// caller asking for fewer (a small probe) is honoured.
function batchLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MAX_BATCH));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

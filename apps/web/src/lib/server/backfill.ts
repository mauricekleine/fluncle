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

import { env } from "cloudflare:workers";
import { getDb, typedRows } from "./db";
import { discogsResolveRelease } from "./discogs";
import { lastfmLove } from "./lastfm";
import { alignObservationAudio, type ObservationAlignment } from "./observation";
import { decodeTrackCursor, encodeTrackCursor, listTracks, type TrackListItem } from "./tracks";

// One DB page per pass. The batch pages with the same cursor the public feed uses
// until it has visited `limit` eligible findings (or run out of rows).
const PAGE_SIZE = 48;

// Discogs allows ~60 req/min with the token. A finding can cost a few lookups
// (MB bridge + a couple of scored search candidates), so we pace one resolve
// every ~1.2s to stay comfortably under the ceiling across a long backfill.
const DISCOGS_DELAY_MS = 1200;

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
// exhausted. The CLI loops until this is null.
type BackfillPass<T> = T & { nextCursor: string | null };

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

export type AlignmentBackfillResult = BackfillPass<{
  // Findings whose observation got word-level caption timings this pass.
  aligned: string[];
  alignedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  // Eligible findings the alignment came back empty for (no usable words) — counted
  // as handled (we won't re-burn them every tick) but not "aligned".
  empty: string[];
  emptyCount: number;
}>;

// Which source's reliability columns a query/write targets. `note` is the odd one
// out: it is NOT a Worker-paced vendor sweep (no `backfillNote…` driver lives in
// this module) — it only shares the per-source `backfill_note_*` column shape so the
// auto-note authoring step (`note_track`, agent tier) can reuse `recordAttempt` for
// its "ran" stamp and the board can reuse `listBackfillRanForTracks(_, "note")` for
// the Note cell's done-when-ran semantics, exactly like Discogs/Last.fm.
export type BackfillSource = "discogs" | "lastfm" | "note";

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
      from tracks
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
    sql: `select track_id from tracks
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
    sql: `select track_id from tracks
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
    sql: `update tracks
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
      } else {
        await recordAttempt(track.trackId, "lastfm", "failure");
        failed.push({ error: outcome.error, logId });
      }

      return true;
    },
  );

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    loved,
    lovedCount: loved.length,
    nextCursor,
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
    nextCursor,
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

  await db.execute({
    args: [releaseId, masterId ?? null, new Date().toISOString(), trackId],
    sql: `update tracks
      set in_release_id = ?,
        in_master_id = ?,
        updated_at = ?
      where track_id = ?`,
  });
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

// ── Observation-alignment backfill ──────────────────────────────────────────────
//
// Re-derive word-level caption timings for observations rendered BEFORE the
// `/with-timestamps` switch (audio + script already on R2, `observation_alignment_json`
// null) WITHOUT re-rendering: fetch the existing mp3 from R2 and force-align it to its
// stored script (ElevenLabs `/forced-alignment` — cheap, no second voice spend).
//
// Idempotent like `context_track`: the artifact's own presence is the resume marker
// (the `observation_alignment_json IS NULL` pick), so a re-run never re-aligns a done
// finding and no per-source cooldown columns are needed. A force-align that comes back
// with no usable words stores a sentinel `{ words: [] }` so it is marked handled (the
// radio simply renders no captions for it) rather than re-burned every tick. One pass
// is bounded (`batchLimit`) and returns a resume cursor the CLI loops until null.

// Eligible-row shape for the alignment sweep: the audio + script needed to align,
// keyed by the cursor's (added_at, track_id).
type AlignmentRow = {
  added_at: string;
  log_id: string | null;
  observation_audio_url: string;
  observation_script: string;
  track_id: string;
};

// One forced-alignment call per finding can take a few seconds; pace them so a long
// sweep stays well under any ElevenLabs concurrency ceiling.
const ALIGNMENT_DELAY_MS = 600;

// Fetch the rendered observation mp3 bytes from R2 for a finding. The audio lives at
// `<log-id>/observation.mp3` (the same key the observe handler put it under).
async function readObservationAudio(logId: string): Promise<ArrayBuffer | null> {
  const object = await env.VIDEOS.get(`${logId}/observation.mp3`);

  return object ? await object.arrayBuffer() : null;
}

/**
 * Back-fill word-level caption alignment over observations that have audio + a script
 * but no alignment yet. Best-effort per finding (a vendor error counts as a failure
 * and the sweep continues). `dryRun` previews the eligible set without spending a
 * forced-alignment call or writing. Bounded + cursor-paged; returns `nextCursor`.
 */
export async function backfillObservationAlignment(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<AlignmentBackfillResult> {
  const aligned: string[] = [];
  const empty: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];
  const max = batchLimit(limit);
  const db = await getDb();

  let cursor = startCursor;
  let handled = 0;
  let nextCursor: string | null = null;
  let first = true;

  while (handled < max) {
    const decoded = decodeTrackCursor(cursor ?? null);
    // Page the eligible rows oldest-LAST (desc) to match the feed cursor's ordering,
    // filtering to "has audio + script, no alignment" so the sweep only visits real
    // work. The cursor is the (added_at, track_id) of the last row of the prior page.
    const args: Array<number | string> = [];
    let where = `observation_audio_url is not null
        and observation_script is not null
        and observation_alignment_json is null
        and log_id is not null`;

    if (decoded) {
      where += ` and (added_at < ? or (added_at = ? and track_id < ?))`;
      args.push(decoded.addedAt, decoded.addedAt, decoded.trackId);
    }

    const page = await db.execute({
      args: [...args, PAGE_SIZE],
      sql: `select track_id, log_id, added_at, observation_audio_url, observation_script
            from tracks
            where ${where}
            order by added_at desc, track_id desc
            limit ?`,
    });

    const rows = typedRows<AlignmentRow>(page.rows);

    if (rows.length === 0) {
      nextCursor = null;
      break;
    }

    for (const row of rows) {
      if (handled >= max) {
        break;
      }

      const logId = row.log_id ?? row.track_id;
      const coordinate = row.log_id ?? "";

      if (dryRun) {
        aligned.push(logId);
        handled += 1;
        continue;
      }

      if (!first) {
        await delay(ALIGNMENT_DELAY_MS);
      }
      first = false;

      try {
        const audio = await readObservationAudio(coordinate);

        if (!audio) {
          failed.push({ error: "observation.mp3 missing from R2", logId });
          handled += 1;
          continue;
        }

        const alignment = await alignObservationAudio(audio, row.observation_script);

        // A null alignment (no usable words) stores a sentinel empty-words artifact so
        // the row is durably marked handled (it drops out of the eligibility filter)
        // rather than re-aligned every tick.
        const stored: ObservationAlignment = alignment ?? { source: "forced-alignment", words: [] };

        await writeObservationAlignment(row.track_id, stored);

        if (alignment && alignment.words.length > 0) {
          aligned.push(logId);
        } else {
          empty.push(logId);
        }
      } catch (error) {
        failed.push({ error: error instanceof Error ? error.message : String(error), logId });
      }

      handled += 1;
    }

    const last = rows[rows.length - 1];
    nextCursor = last
      ? encodeTrackCursor({ addedAt: last.added_at, trackId: last.track_id })
      : null;

    if (handled >= max) {
      break;
    }

    cursor = nextCursor ?? undefined;
  }

  return {
    aligned,
    alignedCount: aligned.length,
    dryRun,
    empty,
    emptyCount: empty.length,
    failed,
    failedCount: failed.length,
    nextCursor,
  };
}

// Server-side write of the alignment column ONLY. Internal-but-public (the radio
// caption render reads it) but it describes an EXISTING artifact, so it must NOT bump
// updated_at — unlike setDiscogsIds. A direct, lastmod-free UPDATE mirrors the quiet
// context_note write.
async function writeObservationAlignment(
  trackId: string,
  alignment: ObservationAlignment,
): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [JSON.stringify(alignment), trackId],
    sql: `update tracks set observation_alignment_json = ? where track_id = ?`,
  });
}

// The recording-MBID fill sweep — give every track its canonical MusicBrainz recording MBID, the
// one join key that reconciles a track to the wider open music graph (MusicBrainz, Wikidata). The
// MBID feeds the `/log` MusicRecording's `sameAs` + a KG `identifier`, so a certified finding that
// carries one is graph-joinable by any crawler or AI answer-engine that keys off MusicBrainz.
//
// ── THE THREE FILL PATHS (docs/catalogue-crawler.md § the MusicBrainz identity layer) ─────────
//   a. CRAWLER-BORN rows already carry the MBID in their PK — `track_id` is `mb_<recording-mbid>`
//      by construction — so this sweep's FIRST act each pass is a bounded, idempotent SQL STRIP:
//      `substr(track_id, 4)` into `mb_recording_id` for any `mb_` row that still lacks it. No
//      vendor call, no MusicBrainz budget — a pure local backfill of history. New crawler rows
//      already stamp the column at mint time (crawl.ts), so this only catches pre-column rows and
//      drains to nothing over a few ticks.
//   b. (the crawler's mint-time write — lives in crawl.ts, not here.)
//   c. FINDING / Spotify-born rows (`track_id` is a Spotify id, not `mb_…`) resolve the MBID by
//      ISRC through the SHARED MusicBrainz client (`/isrc/<isrc>` → its recordings), 1 req/s,
//      Retry-After honoured, circuit-broken on a throttle — the shipped `backfill_label_images`
//      discipline, verbatim.
//
// ── RELIABILITY: the simple attempted-at stamp ───────────────────────────────────────────────
// The ISRC drain stamps `mb_recording_id_attempted_at` on EVERY terminal outcome — a HIT (the MBID
// is written too) AND a MISS (MusicBrainz has no recording for the ISRC: a 404, an empty result,
// or any non-throttle error). That stamp is what drains the worklist: an ISRC MusicBrainz cannot
// resolve is not re-queried on every tick forever. Only a THROTTLE (`rateLimited`) leaves the row
// untouched, so the next tick retries it fresh. Idempotent by construction — a second run over a
// fully-filled archive touches nothing.
//
// ── AND THE OTHER DIRECTION: THE ISRC REFRESH (path d) ───────────────────────────────────────
// Everything above resolves ISRC → MBID. This module also owns the RETURN trip, because it is the
// same key pair, the same 1 req/s client, and the same cron.
//
// MusicBrainz GAINS ISRCs over time — an editor adds one to a recording months after Fluncle
// crawled the release — and nothing ever re-read it. ~9,895 benched catalogue rows sit ISRC-less
// while HOLDING the `mb_recording_id` that would answer the question, and an ISRC-less row is the
// one the anchor waterfall has to resolve down its low-precision FUZZY rung. So: for a row with an
// MBID, no ISRC, and no ISRC look concluded in the last `ISRC_REFRESH_AFTER_DAYS`, ONE
// `/recording/<mbid>?inc=isrcs` read, written fill-empty-only. A row that gains one becomes an
// exact-rung candidate on its next anchor ask with no coupling at all — the anchor queue reads the
// column, not this sweep.
//
// ITS BOOKKEEPING IS `isrc_attempted_at`, the column that already exists for exactly this question
// (schema.ts: "we looked, the recording has no ISRC we can reach"). The refresh is its FIFTH writer
// and stamps on both terminal outcomes, so the worklist self-drains on a rolling window instead of
// needing a column of its own. That the crawler stamps it at mint and the Deezer rung stamps it on
// a concluded look is a FEATURE here: those are the same look, and the refresh should not re-ask a
// recording somebody else asked about last week.

import { getDb, typedRows } from "./db";
import { FILL_ISRC_SQL } from "./isrc";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";

// The `mb_<recording-mbid>` track-id prefix a crawler-born row carries (crawl.ts `catalogueTrackId`).
const CRAWLER_TRACK_ID_PREFIX = "mb_";

// One bounded pass fills at most this many crawler-history rows via the free SQL prefix strip. A
// pure local write (no vendor call), so a generous batch drains pre-column history in a few ticks;
// after that the slice is empty and the statement is a cheap no-op riding the partial fill index.
const PREFIX_STRIP_BATCH = 500;

// One bounded pass resolves at most this many ISRCs via the MusicBrainz client. Each is a
// serialized ~1.1s rate-limited call, so 25 ≈ under 30s — comfortably inside the Worker/gateway
// request budget. The ISRC worklist is the findings/Spotify-born slice (catalogue rows fill from
// their PK), which is small, so it drains in a couple of ticks.
const MAX_API_BATCH = 25;

// How long an ISRC-less row waits between MusicBrainz re-reads. Three weeks, because the thing being
// waited on is a human editing MusicBrainz — a cadence measured in months, not minutes. Long enough
// that the sweep is not re-asking a question whose answer has not had time to change, short enough
// that a newly-added ISRC is picked up inside a month.
const ISRC_REFRESH_AFTER_DAYS = 21;

// One bounded pass re-reads at most this many recordings. Each is a serialized ~1.1s rate-limited
// call, the same unit the ISRC drain above spends, so the cap matches `MAX_API_BATCH` and for the
// same reason: ~25 calls ≈ under 30s, comfortably inside the Worker/gateway request budget.
const MAX_ISRC_REFRESH_BATCH = 25;

/** Strip the `mb_` prefix off a crawler-born track id → the bare recording MBID (else null). */
export function recordingMbidFromTrackId(trackId: string): string | null {
  return trackId.startsWith(CRAWLER_TRACK_ID_PREFIX)
    ? trackId.slice(CRAWLER_TRACK_ID_PREFIX.length)
    : null;
}

/** One ISRC-drain row's outcome — the state machine each track folds into. */
type ResolveOutcome =
  | { kind: "resolved"; mbid: string }
  | { kind: "missed" }
  | { kind: "failed"; error: string }
  | { kind: "rate-limited" };

export type RecordingMbidsResolveResult = {
  dryRun: boolean;
  // Track ids the refresh re-read and MusicBrainz still holds no ISRC for — stamped so they sit out
  // the refresh window rather than being re-asked every tick.
  isrcRefreshMissed: string[];
  isrcRefreshMissedCount: number;
  // Track ids the ISRC REFRESH leg gave an ISRC this pass (or, in a dry run, the rows it WOULD read).
  isrcRefreshed: string[];
  isrcRefreshedCount: number;
  // Crawler-history rows filled from their PK this pass (no vendor call). In a dry run, the count
  // the strip WOULD fill.
  prefixStripped: number;
  // Track ids given an MBID by the ISRC resolve this pass (or, in a dry run, the eligible ISRC
  // worklist it WOULD resolve).
  resolved: string[];
  resolvedCount: number;
  // Track ids whose ISRC MusicBrainz has no recording for — stamped attempted so they drain.
  missed: string[];
  missedCount: number;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  // The track-id cursor to resume the ISRC drain from, or null once it is drained (or a
  // throttle-stop).
  nextCursor: string | null;
  // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — the CLI stops
  // looping the cursor and the next tick resumes with a fresh window.
  rateLimited: boolean;
};

// ── MusicBrainz ISRC → recording ────────────────────────────────────────────────────────────

type MbIsrcResponse = { recordings?: { id?: string }[] };

/**
 * Resolve one ISRC to its MusicBrainz recording MBID (`/isrc/<isrc>` → the recordings that carry
 * it; the first is taken — an ISRC identifies one recording, and a re-press shares the same one).
 * Returns `{ mbid: null, rateLimited: true }` when MusicBrainz is actively throttling so the
 * caller can circuit-break; `{ mbid: null, rateLimited: false }` on a clean no-match (a 404, an
 * empty result) — a terminal miss.
 */
async function resolveRecordingMbidByIsrc(
  isrc: string,
): Promise<{ mbid: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbIsrcResponse>(`/isrc/${encodeURIComponent(isrc)}`);

  if (rateLimited) {
    return { mbid: null, rateLimited: true };
  }

  const mbid = data?.recordings?.find((recording) => recording.id)?.id ?? null;

  return { mbid, rateLimited: false };
}

type MbRecordingIsrcsResponse = { isrcs?: string[] };

/**
 * Re-read one recording's ISRCs (`/recording/<mbid>?inc=isrcs`) — the RETURN trip of the key pair
 * above. The first ISRC is taken: a recording carries one identity, and where MusicBrainz lists
 * several they are re-presses of the same recording (the exact case the anchor's ISRC rung already
 * tiebreaks by duration).
 *
 * `{ isrc: null, rateLimited: true }` when MusicBrainz is actively throttling, so the caller can
 * circuit-break exactly as the ISRC drain does; `{ isrc: null, rateLimited: false }` on a clean
 * "this recording still has no ISRC", which is a real answer and stamps.
 */
async function refreshIsrcByRecordingMbid(
  mbid: string,
): Promise<{ isrc: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbRecordingIsrcsResponse>(
    `/recording/${encodeURIComponent(mbid)}?inc=isrcs`,
  );

  if (rateLimited) {
    return { isrc: null, rateLimited: true };
  }

  const isrc = data?.isrcs?.find((value) => value.trim())?.trim() ?? null;

  return { isrc, rateLimited: false };
}

// ── DB layer ─────────────────────────────────────────────────────────────────────────────────

type IsrcWorkRow = { isrc: string; track_id: string };

type IsrcRefreshRow = { mb_recording_id: string; track_id: string };

/**
 * Fill `mb_recording_id` for crawler-born rows straight off their PK — the free, no-vendor path
 * (a). Bounded to `PREFIX_STRIP_BATCH` via a subquery so one pass never fires a giant UPDATE; the
 * box cron drains history over ticks. Rides the partial `tracks_mb_recording_id_queue_idx`
 * (`mb_recording_id is null and mb_recording_id_attempted_at is null`), so the cost is the
 * remaining unfilled `mb_` slice, which shrinks to zero. Returns the rows filled.
 */
async function stripCrawlerPrefixes(): Promise<number> {
  const db = await getDb();

  const result = await db.execute({
    // BOTH placeholders bound — the prefix AND the limit. The arity guard in the test file
    // pins every statement this module issues.
    args: [CRAWLER_TRACK_ID_PREFIX, PREFIX_STRIP_BATCH],
    // `substr(track_id, 4)` drops the leading `mb_` (3 chars). `substr(track_id, 1, 3) = 'mb_'`
    // is the EXACT prefix test — never a `like 'mb_%'`, whose `_` is a single-char wildcard that
    // would also match a Spotify id. The inner select rides the partial fill index.
    sql: `update tracks
          set mb_recording_id = substr(track_id, 4)
          where track_id in (
            select track_id from tracks
            where mb_recording_id is null
              and mb_recording_id_attempted_at is null
              and substr(track_id, 1, 3) = ?
            order by track_id asc
            limit ?
          )`,
  });

  return result.rowsAffected;
}

/** Count crawler-history rows the prefix strip WOULD fill (dry run only; bounded by the batch). */
async function countStrippableCrawlerRows(): Promise<number> {
  const db = await getDb();

  const result = await db.execute({
    args: [PREFIX_STRIP_BATCH],
    sql: `select count(*) as n from (
            select track_id from tracks
            where mb_recording_id is null
              and mb_recording_id_attempted_at is null
              and substr(track_id, 1, 3) = 'mb_'
            limit ?
          )`,
  });

  return typedRows<{ n: number }>(result.rows)[0]?.n ?? 0;
}

/**
 * One bounded page of the ISRC drain worklist: rows with an ISRC, no `mb_recording_id`, not yet
 * attempted, and NOT crawler-born (a `mb_` row fills from its PK, never the API). Track-id cursored,
 * the same opaque convention as the other backfills. Self-draining as the API fills/stamps rows.
 */
async function listIsrcWork(limit: number, cursor: string | undefined): Promise<IsrcWorkRow[]> {
  const db = await getDb();

  const result = await db.execute({
    args: cursor ? [cursor, limit] : [limit],
    sql: cursor
      ? `select track_id, isrc from tracks
         where mb_recording_id is null
           and mb_recording_id_attempted_at is null
           and isrc is not null and isrc != ''
           and substr(track_id, 1, 3) != 'mb_'
           and track_id > ?
         order by track_id asc limit ?`
      : `select track_id, isrc from tracks
         where mb_recording_id is null
           and mb_recording_id_attempted_at is null
           and isrc is not null and isrc != ''
           and substr(track_id, 1, 3) != 'mb_'
         order by track_id asc limit ?`,
  });

  return typedRows<IsrcWorkRow>(result.rows);
}

/**
 * Stamp a resolved MBID + the attempt marker. Non-clobbering on `mb_recording_id` (never overwrite
 * one a mint/strip already set). The MBID is a PUBLIC identity change (it becomes a `/log` `sameAs`),
 * but it moves no FINDING lastmod — `tracks` writes never bump `findings.updated_at` — so no fan-out.
 */
async function markResolved(trackId: string, mbid: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [mbid, new Date().toISOString(), trackId],
    sql: `update tracks
          set mb_recording_id = coalesce(mb_recording_id, ?), mb_recording_id_attempted_at = ?
          where track_id = ?`,
  });
}

/**
 * One bounded page of the ISRC REFRESH worklist: rows that HOLD a MusicBrainz recording MBID, carry
 * no ISRC, and have had no ISRC look concluded inside the refresh window.
 *
 * OLDEST-LOOKED-AT FIRST, with SQLite's NULL-sorts-smallest putting the never-looked rows at the
 * head — the `youtube-reverdict` round-robin's shape, and the reason this queue needs no cursor: a
 * re-read moves the row's stamp to now, which is what takes it off the head of the queue. So each
 * tick simply asks for the 25 stalest and the queue fixed-points on itself.
 *
 * NO COVERING INDEX, deliberately, and the same call the `youtube-provenance` worklist documents:
 * this is a `tracks` scan with a residual filter, read ONCE per hourly tick, and an index on a
 * post-blob column of a populated `tracks` is a schema change worth MEASURING on hosted Turso rather
 * than guessing at (`tracks_mb_recording_id_idx` cost 104s to build at 66k rows). If this queue ever
 * moves onto a hot path, that measurement is the prerequisite.
 */
async function listIsrcRefreshWork(limit: number, cutoff: string): Promise<IsrcRefreshRow[]> {
  const db = await getDb();

  const result = await db.execute({
    args: [cutoff, limit],
    sql: `select track_id, mb_recording_id from tracks
          where mb_recording_id is not null
            and (isrc is null or trim(isrc) = '')
            and (isrc_attempted_at is null or isrc_attempted_at < ?)
          order by isrc_attempted_at asc, track_id asc
          limit ?`,
  });

  return typedRows<IsrcRefreshRow>(result.rows);
}

/**
 * Write a refreshed ISRC and stamp the look. FILL-EMPTY-ONLY via `coalesce`, the discipline every
 * other ISRC writer here shares (schema.ts § `isrc`): the worklist already selects only ISRC-less
 * rows, so this is defence against a concurrent Deezer recovery landing between the read and the
 * write, never a licence to overwrite. `isrc` binds NULL on a clean miss, which coalesces to the
 * NULL already there and changes nothing but the stamp — one statement for both outcomes, so a look
 * and its conclusion can never be written apart.
 */
async function markIsrcRefreshed(trackId: string, isrc: null | string): Promise<void> {
  const db = await getDb();

  await db.execute({
    // The ISRC binds twice, consecutively — FILL_ISRC_SQL's contract (lib/server/isrc.ts).
    args: [isrc, isrc, new Date().toISOString(), trackId],
    sql: `update tracks
          set ${FILL_ISRC_SQL}, isrc_attempted_at = ?
          where track_id = ?`,
  });
}

/** Stamp the attempt marker only (a clean MusicBrainz no-match) so the row drains the worklist. */
async function markMissed(trackId: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), trackId],
    sql: `update tracks set mb_recording_id_attempted_at = ? where track_id = ?`,
  });
}

// ── The pass ───────────────────────────────────────────────────────────────────────────────────

/**
 * One bounded, idempotent pass of the recording-MBID fill sweep:
 *
 *   1. The free SQL prefix strip (path a) — fills crawler-history rows from their PK, no vendor
 *      call. Runs first every pass; drains to a no-op once history is caught up.
 *   2. The ISRC drain (path c) — resolves each findings/Spotify-born row's MBID via the shared
 *      MusicBrainz client, 1 req/s, circuit-broken on a throttle.
 *   3. The ISRC REFRESH (path d) — the return trip, ONLY on a tick whose ISRC drain had nothing to
 *      do. See the guard at the call site for why it is conditional rather than additive.
 *
 * A dry run reports every worklist without any vendor call or write. Stops early on a MusicBrainz
 * rate-limit (circuit breaker) with `rateLimited: true` + a null cursor so the CLI stops looping.
 */
export async function resolveRecordingMbids(
  limit: number,
  dryRun: boolean,
  cursor?: string,
  isrcRefreshLimit: number = MAX_ISRC_REFRESH_BATCH,
): Promise<RecordingMbidsResolveResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_API_BATCH));
  const refreshLimit = Math.max(0, Math.min(isrcRefreshLimit, MAX_ISRC_REFRESH_BATCH));

  // ── 1. The free prefix strip (crawler history). Only on the first page of a loop, so the CLI's
  //    cursor loop doesn't re-run it each iteration; a fresh tick always starts at cursor=undefined.
  const prefixStripped = cursor
    ? 0
    : dryRun
      ? await countStrippableCrawlerRows()
      : await stripCrawlerPrefixes();

  // ── 2. The ISRC drain.
  const rows = await listIsrcWork(batchLimit, cursor);

  const resolved: string[] = [];
  const missed: string[] = [];
  const failed: Array<{ error: string; trackId: string }> = [];
  let rateLimited = false;

  if (dryRun) {
    for (const row of rows) {
      resolved.push(row.track_id);
    }
  } else {
    for (const row of rows) {
      let outcome: ResolveOutcome;

      try {
        const { mbid, rateLimited: throttled } = await resolveRecordingMbidByIsrc(row.isrc);
        outcome = throttled
          ? { kind: "rate-limited" }
          : mbid
            ? { kind: "resolved", mbid }
            : { kind: "missed" };
      } catch (error) {
        outcome = { error: error instanceof Error ? error.message : String(error), kind: "failed" };
      }

      if (outcome.kind === "rate-limited") {
        // Circuit breaker: MusicBrainz is actively throttling. Stop; do NOT stamp this row (it was
        // throttled, not un-resolvable) — the next tick retries it fresh.
        rateLimited = true;
        break;
      }

      if (outcome.kind === "resolved") {
        await markResolved(row.track_id, outcome.mbid);
        logEvent("info", "recording-mbids.resolved", { mbid: outcome.mbid, trackId: row.track_id });
        resolved.push(row.track_id);
        continue;
      }

      if (outcome.kind === "missed") {
        await markMissed(row.track_id);
        missed.push(row.track_id);
        continue;
      }

      // failed — an unexpected error (a DB write, not the MB call, which never throws). Leave the
      // row un-stamped so it retries next tick, and surface it.
      failed.push({ error: outcome.error, trackId: row.track_id });
    }
  }

  // ── 3. The ISRC REFRESH (path d) — the return trip: MBID → ISRC.
  //
  // IT RUNS ONLY ON AN IDLE TICK, and the condition is a budget rather than a preference. Both legs
  // spend the SAME serialized ~1.1s MusicBrainz calls inside the SAME Worker request, and the whole
  // module is sized around "≤25 calls ≈ under 30s". Running both back to back would double a request
  // that is already the longest thing this cron does. The ISRC drain is the findings/Spotify-born
  // tail — small, and drained today — so an idle tick is the normal tick and the refresh is what
  // fills it; a tick where the drain has real work is a tick where the drain is the priority.
  //
  // FIRST PAGE ONLY (`!cursor`), the prefix strip's rule: the CLI loops the drain's cursor, and this
  // leg has no cursor of its own (its stamps are what advance it), so re-running it per iteration
  // would just re-ask the same 25 rows.
  const isrcRefreshed: string[] = [];
  const isrcRefreshMissed: string[] = [];
  const refreshCutoff = new Date(
    Date.now() - ISRC_REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const refreshIdle = !cursor && !rateLimited && rows.length === 0 && refreshLimit > 0;

  if (refreshIdle && dryRun) {
    // The drain's own dry-run convention: report the rows it WOULD visit, by id, with no vendor call
    // and no write. Same worklist read, so the dry run proves the real query.
    for (const row of await listIsrcRefreshWork(refreshLimit, refreshCutoff)) {
      isrcRefreshed.push(row.track_id);
    }
  } else if (refreshIdle) {
    for (const row of await listIsrcRefreshWork(refreshLimit, refreshCutoff)) {
      try {
        const { isrc, rateLimited: throttled } = await refreshIsrcByRecordingMbid(
          row.mb_recording_id,
        );

        if (throttled) {
          // The same circuit breaker the drain uses: stop, stamp nothing, resume next tick.
          rateLimited = true;
          break;
        }

        await markIsrcRefreshed(row.track_id, isrc);

        if (isrc) {
          logEvent("info", "recording-mbids.isrc-refreshed", { isrc, trackId: row.track_id });
          isrcRefreshed.push(row.track_id);
        } else {
          isrcRefreshMissed.push(row.track_id);
        }
      } catch (error) {
        // A DB write faulting (the MB call never throws). Un-stamped, so it retries next tick.
        failed.push({
          error: error instanceof Error ? error.message : String(error),
          trackId: row.track_id,
        });
      }
    }
  }

  // Drained when the page came back short. On a throttle-stop, null the cursor so the CLI stops
  // looping this tick (the next tick resumes from the top; the attempt stamps re-skip filled rows).
  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rateLimited || rows.length < batchLimit ? null : lastTrackId;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    isrcRefreshMissed,
    isrcRefreshMissedCount: isrcRefreshMissed.length,
    isrcRefreshed,
    isrcRefreshedCount: isrcRefreshed.length,
    missed,
    missedCount: missed.length,
    nextCursor,
    prefixStripped,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
  };
}

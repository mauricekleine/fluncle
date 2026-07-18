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

import { getDb, typedRows } from "./db";
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

// ── DB layer ─────────────────────────────────────────────────────────────────────────────────

type IsrcWorkRow = { isrc: string; track_id: string };

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
    // BOTH placeholders bound — the prefix AND the limit. This statement shipped with only the
    // limit bound and 500'd every wet pass with "Number of arguments mismatch: expected 2, got 1"
    // (Sentry, 2026-07-18) while the dry-run twin below hardcodes 'mb_' and passed — the unit
    // tests mocked db.execute, so nothing validated arity. The arity guard in the test file now
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
 *
 * A dry run reports both worklists without any vendor call or write. Stops early on a MusicBrainz
 * rate-limit (circuit breaker) with `rateLimited: true` + a null cursor so the CLI stops looping.
 */
export async function resolveRecordingMbids(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<RecordingMbidsResolveResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_API_BATCH));

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

  // Drained when the page came back short. On a throttle-stop, null the cursor so the CLI stops
  // looping this tick (the next tick resumes from the top; the attempt stamps re-skip filled rows).
  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rateLimited || rows.length < batchLimit ? null : lastTrackId;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    missed,
    missedCount: missed.length,
    nextCursor,
    prefixStripped,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
  };
}

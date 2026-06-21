// Admin-gated, idempotent catalogue backfills for the two music-graph writes that
// landed AFTER the synchronous add already existed (see docs/rfcs/lastfm-discogs-sync.md):
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

import { getDb } from "./db";
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

// The cursor to resume from on the next pass, or null once the archive is
// exhausted. The CLI loops until this is null.
type BackfillPass<T> = T & { nextCursor: string | null };

export type LastfmBackfillResult = BackfillPass<{
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  loved: string[];
  lovedCount: number;
}>;

export type DiscogsBackfillResult = BackfillPass<{
  dryRun: boolean;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;
  unresolved: string[];
  unresolvedCount: number;
}>;

// A finding is "published" once it's on the playlist AND posted — the same bar the
// love/Discogs writes care about (an in-flight/incomplete add isn't a finding yet).
function isPublishedFinding(track: TrackListItem): boolean {
  return track.type === "finding" && track.addedToSpotify && track.postedToTelegram;
}

// Process ONE bounded pass of the public feed (newest-first, deterministic on
// added_at + track_id) starting at `startCursor`, invoking `visit` for each
// PUBLISHED finding until `limit` of them have been HANDLED or the archive is
// exhausted. `visit` returns whether the finding counted toward the limit
// (Discogs skips rows that already have an id, so those don't burn the budget).
//
// Returns the cursor to resume from on the next pass — the feed cursor is
// exclusive on {added_at, track_id}, so resuming after the LAST published finding
// we visited re-scans only the cheap non-finding rows between it and the next
// finding (skipped again, no budget burned). Returns null once the feed drains.
async function runPublishedFindingPass(
  startCursor: string | undefined,
  limit: number,
  visit: (track: TrackListItem) => Promise<boolean>,
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

      if (await visit(track)) {
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

// Back-fill Last.fm loves over published findings. `lastfmLove` is idempotent and
// no-ops without the session key, so this is safe to run repeatedly; we still
// honour dryRun so the operator can preview the set first. Best-effort per finding.
export async function backfillLastfmLoves(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<LastfmBackfillResult> {
  const loved: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];

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

      if (dryRun) {
        loved.push(logId);
        return true;
      }

      try {
        // lastfmLove never throws (it logs + swallows), so a failure here would be
        // exceptional; we still guard so the sweep can't abort on one finding.
        await lastfmLove(artist, track.title);
        loved.push(logId);
      } catch (error) {
        failed.push({ error: error instanceof Error ? error.message : String(error), logId });
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
  };
}

// Back-fill Discogs ids over published findings WHERE in_release_id is null (the
// public DTO exposes this as the absence of `discogsReleaseUrl`). Resolves
// best-effort and, on a confident match, writes the ids server-side via the same
// columns publishTrack populates. Paced under the Discogs rate limit.
export async function backfillDiscogsIds(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<DiscogsBackfillResult> {
  const resolved: DiscogsBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
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

      // Pace the calls (skip the wait before the first one).
      if (!first) {
        await delay(DISCOGS_DELAY_MS);
      }
      first = false;

      // discogsResolveRelease never throws; {} = unresolved (below the gate or no
      // token), which is the correct state — record it and move on.
      const enrichment = await discogsResolveRelease({
        album: track.album,
        artists: track.artists,
        isrc: track.isrc,
        label: track.label,
        releaseDate: track.releaseDate,
        title: track.title,
      });

      if (!enrichment.releaseId) {
        unresolved.push(logId);
        return true;
      }

      if (!dryRun) {
        await setDiscogsIds(track.trackId, enrichment.releaseId, enrichment.masterId);
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
    },
  );

  return {
    dryRun,
    nextCursor,
    resolved,
    resolvedCount: resolved.length,
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

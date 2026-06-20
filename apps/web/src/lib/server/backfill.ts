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
import { decodeTrackCursor, listTracks, type TrackListItem } from "./tracks";

// One DB page per pass. The loop pages with the same cursor the public feed uses
// until it has visited `limit` eligible findings (or run out of rows).
const PAGE_SIZE = 48;

// Discogs allows ~60 req/min with the token. A finding can cost a few lookups
// (MB bridge + a couple of scored search candidates), so we pace one resolve
// every ~1.2s to stay comfortably under the ceiling across a long backfill.
const DISCOGS_DELAY_MS = 1200;

export type LastfmBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  loved: string[];
  lovedCount: number;
};

export type DiscogsBackfillResult = {
  dryRun: boolean;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;
  unresolved: string[];
  unresolvedCount: number;
};

// A finding is "published" once it's on the playlist AND posted — the same bar the
// love/Discogs writes care about (an in-flight/incomplete add isn't a finding yet).
function isPublishedFinding(track: TrackListItem): boolean {
  return track.type === "finding" && track.addedToSpotify && track.postedToTelegram;
}

// Page the public feed (newest-first, deterministic on added_at + track_id),
// invoking `visit` for each PUBLISHED finding until `limit` of them have been
// handled or the archive is exhausted. `visit` returns whether the finding
// counted toward the limit (Discogs skips rows that already have an id, so those
// don't burn the budget).
async function eachPublishedFinding(
  limit: number,
  visit: (track: TrackListItem) => Promise<boolean>,
): Promise<void> {
  let cursor: string | undefined;
  let handled = 0;

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

      if (await visit(track)) {
        handled += 1;
      }
    }

    if (!page.nextCursor) {
      break;
    }

    cursor = page.nextCursor;
  }
}

// Back-fill Last.fm loves over published findings. `lastfmLove` is idempotent and
// no-ops without the session key, so this is safe to run repeatedly; we still
// honour dryRun so the operator can preview the set first. Best-effort per finding.
export async function backfillLastfmLoves(
  limit: number,
  dryRun: boolean,
): Promise<LastfmBackfillResult> {
  const loved: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];

  await eachPublishedFinding(limit, async (track) => {
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
  });

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    loved,
    lovedCount: loved.length,
  };
}

// Back-fill Discogs ids over published findings WHERE in_release_id is null (the
// public DTO exposes this as the absence of `discogsReleaseUrl`). Resolves
// best-effort and, on a confident match, writes the ids server-side via the same
// columns publishTrack populates. Paced under the Discogs rate limit.
export async function backfillDiscogsIds(
  limit: number,
  dryRun: boolean,
): Promise<DiscogsBackfillResult> {
  const resolved: DiscogsBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  let first = true;

  await eachPublishedFinding(limit, async (track) => {
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
  });

  return {
    dryRun,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

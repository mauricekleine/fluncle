import { env, waitUntil } from "cloudflare:workers";
import { videoPurgeUrls } from "../media";

// Per-URL Cloudflare cache purge for a re-rendered finding's video.
//
// A finding's video is served via Cloudflare Media Transformations: the player
// streams resized/cropped renditions DERIVED from the master `footage.mp4`, and
// each rendition is edge-cached under its own transform URL. When a finding is
// RE-RENDERED — the video ship re-uploads a new `footage.mp4` to the SAME R2 key
// — those rendition URLs stay cached, so the player keeps serving the OLD clip
// until each rendition's TTL expires. This module purges that finding's exact
// rendition URLs from the edge so the next request transcodes the fresh master.
//
// It mirrors the edge-cache purge (edge-cache.ts `purgeLogCacheNow`): the same
// Cloudflare purge-by-URL REST endpoint, the same zone-scoped Cache-Purge token,
// and the same best-effort discipline — fired on `waitUntil` so a write path
// never awaits the network, and a missing token / failed call never throws (the
// renditions' own TTLs still bound staleness, just over a longer window).
//
// Credentials: the SAME zone token the log-cache purge uses — `CF_CACHE_PURGE_*`.
// found.fluncle.com (the transform host) and www.fluncle.com (the log host) are
// both on the fluncle.com zone, so ONE zone-scoped `Zone → Cache Purge` token
// covers both. No new secret is needed if that token is already provisioned (it
// is, for the log-cache purge). If it is not yet set, see this module's doc + the
// PR notes: `wrangler secret put CF_CACHE_PURGE_TOKEN` (+ `CF_CACHE_PURGE_ZONE_ID`).

// Cloudflare's purge-by-URL accepts at most 30 files per request (zone purge
// limit). A squared finding's deduped set is exactly 30 today (3 masters/social +
// 2 orientations × (4 ladder ×3 + 3 native) − the portrait 1080 native that dups
// the 1080 ladder rung), so it fits in one request — but chunk defensively so a
// future widening of the ladder or the surface set never silently drops overflow.
const CLOUDFLARE_PURGE_MAX_FILES = 30;

/**
 * Purge a re-rendered finding's Media-Transformation renditions from the edge.
 *
 * Best-effort, fire-and-extend via `waitUntil`: the caller (the video ship
 * finalize step) never awaits the purge and never fails because of it. Safe to
 * call with a missing/blank logId — a no-op. `squared` mirrors the finding's
 * two-master layout (`video_squared_at` set): it selects which rendition family
 * the surfaces emit, so the purge set matches exactly what was cached.
 */
export function purgeVideoCache(logId: string | null | undefined, squared: boolean): void {
  if (!logId?.trim()) {
    return;
  }

  const task = purgeVideoCacheNow(logId.trim(), squared);

  // Outside the Workers runtime (Node tests, the `turso dev` data layer) there is
  // no execution context, so `waitUntil` throws — fall back to letting the promise
  // run detached (mirrors push.ts). The purge is best-effort either way.
  try {
    waitUntil(task);
  } catch {
    void task;
  }
}

async function purgeVideoCacheNow(logId: string, squared: boolean): Promise<void> {
  // Skipped (not an error) when the operator hasn't wired the zone token. The
  // renditions' own edge TTLs still bound staleness; the purge just shortens it.
  const zoneId = readPurgeBinding("CF_CACHE_PURGE_ZONE_ID");
  const token = readPurgeBinding("CF_CACHE_PURGE_TOKEN");

  if (!zoneId || !token) {
    console.warn(
      `[purgeVideoCache] CF_CACHE_PURGE_ZONE_ID / CF_CACHE_PURGE_TOKEN not set; skipping edge purge for ${logId}. Provision the zone-scoped Cache-Purge token to evict stale renditions on re-render.`,
    );

    return;
  }

  const files = videoPurgeUrls(logId, { squared });

  if (files.length === 0) {
    return;
  }

  // Chunk to the per-request file cap and fire each chunk; one failed chunk never
  // sinks the rest (best-effort, the renditions' TTLs bound staleness regardless).
  for (let i = 0; i < files.length; i += CLOUDFLARE_PURGE_MAX_FILES) {
    const chunk = files.slice(i, i + CLOUDFLARE_PURGE_MAX_FILES);

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
        {
          body: JSON.stringify({ files: chunk }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );

      if (!response.ok) {
        console.warn(
          `[purgeVideoCache] purge_cache returned ${response.status} for ${logId} (${chunk.length} urls)`,
        );
      }
    } catch (error) {
      console.warn(`[purgeVideoCache] purge_cache failed for ${logId}:`, error);
    }
  }
}

// The purge credentials live on the Worker env (wrangler secrets), read the same
// cast way the rest of the server reads secret bindings (they're not in the
// generated `Env` type — only vars/bindings are). Reuses the log-cache purge's
// two secrets; absent in dev and until provisioned, where the purge no-ops.
function readPurgeBinding(
  key: "CF_CACHE_PURGE_ZONE_ID" | "CF_CACHE_PURGE_TOKEN",
): string | undefined {
  const value = (env as unknown as Record<string, string | undefined>)[key];

  return value?.trim() ? value : undefined;
}

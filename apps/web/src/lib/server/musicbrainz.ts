// THE ONE MusicBrainz client — the rate-limited, Retry-After-honouring, honestly
// identified fetcher every MB caller in the Worker goes through.
//
// MusicBrainz needs no token, but it has two hard rules and both are load-bearing:
//
//   1. An IDENTIFIABLE User-Agent with contact info. A generic one is rejected (403).
//   2. ~1 request/second, per client. Exceed it and you get 503s, then a block.
//
// So every call is serialized through a module-level gate spaced by a pacing floor —
// module-level so a backfill sweep, an artist resolve and a catalogue crawl running
// in the same isolate SHARE one honest rate budget instead of each keeping its own
// and tripling the real request rate. A 503 is MB's "slow down": we honour its
// `Retry-After` inside the slot, and if the retries are exhausted we report
// `rateLimited: true` so the CALLER can trip its circuit breaker and stop the run
// rather than re-storming (the shipped `fluncle-backfill` discipline).
//
// This module was EXTRACTED, not invented: `discogs.ts` (the MB→Discogs bridge) and
// `artist-resolution.ts` (the MB url-rels walk) each carried a byte-similar copy of
// this fetcher. Both now import it, and the catalogue crawler is the third caller —
// which is exactly why there must be one, not three, budgets.

import { logEvent } from "./log";

const MUSICBRAINZ_API_ROOT = "https://musicbrainz.org/ws/2";

/**
 * The identifiable User-Agent MusicBrainz (and Discogs) require. Generic agents are
 * rejected outright, so this is not decoration — it is auth.
 */
export const MB_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

/** The pacing floor between two MB calls. Mutable ONLY via the test seam below. */
let rateLimitIntervalMs = 1100;

/**
 * Test seam: drop the pacing floor (and the Retry-After sleep) to zero so MB callers'
 * unit tests run instantly instead of incurring real multi-second waits. Production
 * never calls this.
 */
export function setMusicbrainzRateLimitForTests(ms: number): void {
  rateLimitIntervalMs = ms;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The serializer: each call runs after the previous one settles, plus the pacing gap.
// A failure never wedges the chain (both arms advance the gate).
let tail: Promise<unknown> = Promise.resolve();

function throttle<T>(call: () => Promise<T>): Promise<T> {
  const result = tail.then(call, call);

  tail = result.then(
    () => delay(rateLimitIntervalMs),
    () => delay(rateLimitIntervalMs),
  );

  return result;
}

/** What one MB call returns: the parsed body, or null — plus whether MB throttled us. */
export type MbResult<T> = { data: T | null; rateLimited: boolean };

/**
 * One rate-limited MusicBrainz web-service call. `path` is everything after
 * `/ws/2` (e.g. `/release/<mbid>?inc=recordings`); `fmt=json` is appended here.
 *
 * Never throws — a network error, a 4xx, or an exhausted 503 all resolve to
 * `{ data: null }`. `rateLimited: true` means MB is ACTIVELY throttling us (a 503
 * that survived its Retry-After retries): the caller must stop its run, not retry.
 */
export function mbFetch<T>(path: string): Promise<MbResult<T>> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${MUSICBRAINZ_API_ROOT}${path}${separator}fmt=json`;

  return throttle(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, { headers: { "User-Agent": MB_USER_AGENT } });
      } catch (error) {
        logEvent("warn", "musicbrainz.request-threw", { error, path });

        return { data: null, rateLimited: false };
      }

      // 503 is MB's "slow down" — honour Retry-After and try again within this slot.
      if (response.status === 503 && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After")) || 2;
        logEvent("warn", "musicbrainz.retry", {
          attempt: attempt + 1,
          path,
          retryAfterSeconds: retryAfter,
          status: 503,
        });
        await delay(rateLimitIntervalMs === 0 ? 0 : retryAfter * 1000);
        continue;
      }

      // Retries exhausted on a 503 → MB is actively throttling. Say so, loudly enough
      // that the caller's circuit breaker can stop the run.
      if (response.status === 503) {
        return { data: null, rateLimited: true };
      }

      if (!response.ok) {
        // Surface the status — a swallowed 400 (a bad `inc`) or 403 (a bad User-Agent)
        // is otherwise indistinguishable from a genuine no-match.
        logEvent("warn", "musicbrainz.request-failed", {
          path,
          status: response.status,
          statusText: response.statusText,
        });

        return { data: null, rateLimited: false };
      }

      return { data: (await response.json()) as T, rateLimited: false };
    }

    return { data: null, rateLimited: false };
  });
}

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

/**
 * Per-request wall-clock deadline. MB is 1 req/s paced, so a healthy call answers in
 * well under a second; anything past this is a stalled socket. It MUST be bounded:
 * every caller shares the one serialized `throttle` gate below, so a single hung
 * request would wedge the whole chain — and, in turn, every box driver that blocks on
 * it (`fluncle-artist-sweep`, `fluncle-crawl`, `fluncle-backfill`) until their systemd
 * ceiling kills them. An aborted request resolves to `{ data: null }`, the same as any
 * network error — a stall is not throttling, so never `rateLimited`.
 */
const MB_REQUEST_TIMEOUT_MS = 15_000;

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

// The pacing gate — BOTH properties, learned the hard way across 2026-07-18/19:
//
// 1. SINGLE-FILE (in-flight serialization). MusicBrainz wants one polite client, and the
//    original promise chain guaranteed it implicitly. The pure slot allocator that briefly
//    replaced it paced ARRIVALS at 1.1s but let calls OVERLAP whenever one ran long — under
//    MB's evening slowdown the overlap compounded into real 503-throttling of our IP
//    (observed 2026-07-19 ~21:30 UTC: `throttled: true` sweeps, label-images ticks stretched
//    past the box CLI's 5-minute timeout). Each caller therefore waits for the previous
//    call to settle before firing.
// 2. WEDGE-IMMUNE (the 2026-07-18 lesson). A predecessor whose request context died (client
//    timeout) can leave a frozen timer/fetch the runtime never settles, so the wait races a
//    deadline on the CALLER'S OWN clock — a dead head delays the queue by at most
//    CHAIN_WAIT_FACTOR slots, never forever, and every queued caller's own timer keeps
//    ticking, so the whole queue unwedges together.
//
// The slot timestamp still paces arrivals (and the 503 handler pushes it forward for a
// global backoff); the chain is the mutual exclusion on top.
let nextSlotAt = 0;
let tail: Promise<unknown> = Promise.resolve();

// How long a caller will wait on its predecessor, in units of the pacing interval: covers a
// legitimately slow call (a 15s aborted fetch + two Retry-After sleeps + retries ≈ 25-35s at
// the 1.1s production interval → ~44s bound) while keeping the unwedge bound tight. Scaled by
// the interval so the test seam (interval 0/10ms) keeps tests instant.
const CHAIN_WAIT_FACTOR = 40;

function throttle<T>(call: () => Promise<T>): Promise<T> {
  const prev = tail;

  const run = (async () => {
    const chainWait = rateLimitIntervalMs * CHAIN_WAIT_FACTOR;

    // Serialize behind the predecessor — but never past the deadline on our own clock.
    if (chainWait > 0) {
      await Promise.race([prev.then(noop, noop), delay(chainWait)]);
    } else {
      await Promise.race([prev.then(noop, noop), Promise.resolve()]);
    }

    // Arrival pacing on top (the 1 req/s etiquette + the 503 push-forward).
    const now = Date.now();
    const slotAt = Math.max(now, nextSlotAt);
    nextSlotAt = slotAt + rateLimitIntervalMs;

    if (slotAt > now) {
      await delay(slotAt - now);
    }

    return call();
  })();

  tail = run.then(noop, noop);

  return run;
}

function noop(): void {
  // The chain never propagates results or rejections — links only sequence.
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
        response = await fetch(url, {
          headers: { "User-Agent": MB_USER_AGENT },
          signal: AbortSignal.timeout(MB_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // A network error OR a timeout abort (AbortSignal.timeout → TimeoutError) —
        // both mean this call yielded nothing; move on rather than wedge the chain.
        logEvent("warn", "musicbrainz.request-threw", { error, path });

        return { data: null, rateLimited: false };
      }

      // 503 is MB's "slow down" — honour Retry-After and try again within this slot. Push the
      // slot clock forward too, so OTHER callers (whose slots were pre-allocated) also hold off
      // for MB's cooldown — the global-backoff property the old serialized chain gave for free.
      if (response.status === 503 && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After")) || 2;
        logEvent("warn", "musicbrainz.retry", {
          attempt: attempt + 1,
          path,
          retryAfterSeconds: retryAfter,
          status: 503,
        });

        if (rateLimitIntervalMs !== 0) {
          nextSlotAt = Math.max(nextSlotAt, Date.now() + retryAfter * 1000);
        }

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

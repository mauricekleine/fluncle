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

// The pacing gate. Workers-safe by construction: slots are allocated SYNCHRONOUSLY from a
// module-level timestamp (the isolate is single-threaded, so the read-modify-write below is
// atomic), and each caller sleeps out its own wait with a timer in its OWN request context.
//
// The previous design — a module-level promise chain with a delay() between links — wedged the
// whole isolate: a link whose request context died (client disconnect, timeout) left behind a
// timer the runtime never fires (Workers freeze a completed request's timers), so every later
// MB caller on that isolate queued behind it FOREVER. Observed 2026-07-18: one timed-out
// label-lineage tick poisoned its isolate, and every wet retry that reused the connection (same
// isolate) hung until the client gave up — which grew the frozen chain further. With slot
// allocation, a dead caller merely wastes its slot; nobody ever awaits another request's
// promises or timers.
let nextSlotAt = 0;

function throttle<T>(call: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slotAt = Math.max(now, nextSlotAt);
  nextSlotAt = slotAt + rateLimitIntervalMs;

  const wait = slotAt - now;

  return wait > 0 ? delay(wait).then(call) : call();
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

import { logEvent } from "./log";

export const MUSICBRAINZ_API_HOST = "musicbrainz.org";
const MUSICBRAINZ_API_ROOT = `https://${MUSICBRAINZ_API_HOST}/ws/2`;

export function musicbrainzUrl(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${MUSICBRAINZ_API_ROOT}${path}${separator}fmt=json`;
}

export const MB_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const MB_REQUEST_TIMEOUT_MS = 15_000;

let rateLimitIntervalMs = 1100;

export function setMusicbrainzRateLimitForTests(ms: number): void {
  rateLimitIntervalMs = ms;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextSlotAt = 0;
let tail: Promise<unknown> = Promise.resolve();

const CHAIN_WAIT_FACTOR = 40;

function throttle<T>(call: () => Promise<T>): Promise<T> {
  const prev = tail;

  const run = (async () => {
    const chainWait = rateLimitIntervalMs * CHAIN_WAIT_FACTOR;

    if (chainWait > 0) {
      await Promise.race([prev.then(noop, noop), delay(chainWait)]);
    } else {
      await Promise.race([prev.then(noop, noop), Promise.resolve()]);
    }

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

function noop(): void {}

export type MbResult<T> = { data: T | null; rateLimited: boolean };

export function mbFetch<T>(path: string): Promise<MbResult<T>> {
  const url = musicbrainzUrl(path);

  return throttle(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { "User-Agent": MB_USER_AGENT },
          signal: AbortSignal.timeout(MB_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        logEvent("warn", "musicbrainz.request-threw", { error, path });

        return { data: null, rateLimited: false };
      }

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

      if (response.status === 503) {
        return { data: null, rateLimited: true };
      }

      if (!response.ok) {
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

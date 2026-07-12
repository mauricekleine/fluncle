import { appleCatalogLookupByIsrcs } from "./apple-music";
import {
  areAppleCallsAllowed,
  isAppleCallBudgetAvailable,
  recordAppleAuthOutcome,
  recordAppleCall,
} from "./apple-breaker";
import { enrichFromDeezer } from "./deezer";

export type LivePreviewTrack = {
  artists: string[];
  isrc?: string;
  previewUrl?: string;
  title: string;
};

// How long the exact-by-ISRC Apple rung (rung 3) is allowed to spend before it falls
// through to the keyless fuzzy iTunes rung. This is a user-facing hot path sharing the
// one undocumented Apple budget with the sweeps, so the rung's honest discipline is a
// short bound: a slow answer degrades to today's behaviour, never user-visible latency.
const APPLE_EXACT_PREVIEW_TIMEOUT_MS = 2500;

export async function fetchLivePreview(
  track: LivePreviewTrack,
  request: Request,
): Promise<Response | undefined> {
  const range = request.headers.get("range");
  const upstreamInit: RequestInit = range ? { headers: { range } } : {};

  // Rung 1 — the stored preview (whatever the DTO already carries).
  const stored = await fetchUsablePreview(track.previewUrl, upstreamInit);

  if (stored) {
    return stored;
  }

  // Rung 2 — a fresh Deezer preview by ISRC (stored tokens expire).
  const refreshed = await enrichFromDeezer(track.isrc);
  const deezer = await fetchUsablePreview(
    refreshed.previewUrl && refreshed.previewUrl !== track.previewUrl
      ? refreshed.previewUrl
      : undefined,
    upstreamInit,
  );

  if (deezer) {
    return deezer;
  }

  // Rung 3 — EXACT Apple by ISRC (RFC musickit-second-authority, U4). A strict upgrade
  // of the old fuzzy-iTunes last rung: same recording, confirmed by ISRC rather than a
  // Dice-scored artist+title guess. Resolve-on-demand, never stored (assets get
  // re-mastered). Skips itself entirely — zero latency — when the row has no ISRC,
  // MusicKit is unprovisioned, or the breaker/meter say no (see the rung helper).
  const appleUrl = await resolveAppleExactPreviewUrl(track).catch(() => undefined);
  const apple = await fetchUsablePreview(appleUrl, upstreamInit);

  if (apple) {
    return apple;
  }

  // Rung 4 — the keyless fuzzy iTunes fallback: the honest degraded mode when there is
  // no ISRC to be exact with, MusicKit is dark, or the exact rung was short-circuited.
  const itunesUrl = await resolveItunesPreviewUrl(track).catch(() => undefined);

  return fetchUsablePreview(itunesUrl, upstreamInit);
}

/**
 * Rung 3's resolver: the exact Apple preview URL for a track's ISRC, or undefined when
 * the rung declines (no ISRC, unprovisioned, breaker tripped / budget spent, timeout, or
 * no match) — in every declining case the caller falls through to the fuzzy iTunes rung.
 *
 * HONEST HOT-PATH DISCIPLINE (RFC U4). This is a live authed Apple call on a user-facing
 * path sharing the one shared Apple budget with the sweeps, so:
 *   - the U1 breaker + call meter are consulted BEFORE the call — a suspended token or a
 *     spent window skips the rung with no call at all (a sweep throttle degrades to
 *     today's behaviour, not user-visible latency);
 *   - the call is bound by a short AbortSignal timeout that aborts the fetch and falls
 *     through (never a stalled hot path);
 *   - the outcome feeds the breaker + meter (this rung is one of the surfaces the shared
 *     token darkens, so it must count toward and report the shared budget).
 *
 * Uses the SLIM batched path with a one-element list — the lightest catalog read that
 * still carries `preview.url`, no album join. `timeoutMs` is injectable for tests.
 */
export async function resolveAppleExactPreviewUrl(
  track: LivePreviewTrack,
  timeoutMs: number = APPLE_EXACT_PREVIEW_TIMEOUT_MS,
): Promise<string | undefined> {
  const isrc = track.isrc?.trim();

  if (!isrc) {
    // No ISRC ⇒ nothing to be exact with. The fuzzy rung is this row's fallback.
    return undefined;
  }

  const now = Date.now();

  // Consult the breaker + meter BEFORE spending a call: a tripped breaker (a suspended
  // token) or a spent call window short-circuits the rung entirely — no Apple call, zero
  // user-visible latency, straight through to the fuzzy rung.
  if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const outcome = await appleCatalogLookupByIsrcs([isrc], controller.signal);

    if (!outcome.configured) {
      // MusicKit is unprovisioned — the rung is dark, no HTTP happened. Record nothing
      // (the meter/breaker only count real Apple calls); fall through to the fuzzy rung.
      return undefined;
    }

    // A real Apple call was attempted (answered, errored, or aborted): count it against
    // the shared budget and feed its auth outcome to the breaker.
    await recordAppleCall(now);

    if (!outcome.ok) {
      // A 401/403 advances the breaker's suspension streak (and trips it on the K-th); a
      // 429, a network throw, or our own timeout-abort is the OTHER regime — left alone.
      await recordAppleAuthOutcome(outcome.authFailed ? "auth_failure" : "other", now);

      return undefined;
    }

    await recordAppleAuthOutcome("ok", now);

    return outcome.bundles.get(isrc)?.preview?.url;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsablePreview(
  url: string | undefined,
  init: RequestInit,
): Promise<Response | undefined> {
  if (!url) {
    return undefined;
  }

  const response = await fetch(url, init);

  return response.ok || response.status === 206 ? response : undefined;
}

type ItunesHit = {
  artistName?: string;
  previewUrl?: string;
  trackName?: string;
};

type ItunesResponse = {
  results?: ItunesHit[];
};

async function resolveItunesPreviewUrl(track: LivePreviewTrack): Promise<string | undefined> {
  const artist = track.artists[0]?.trim();

  if (!artist || !track.title.trim()) {
    return undefined;
  }

  const term = `${artist} ${track.title.trim()}`;
  const response = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=10`,
    { headers: { accept: "application/json" } },
  );

  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as ItunesResponse;
  let best: { score: number; url: string } | undefined;

  for (const hit of body.results ?? []) {
    if (!hit.previewUrl) {
      continue;
    }

    const score =
      0.6 * similarity(hit.trackName ?? "", track.title) +
      0.4 * similarity(hit.artistName ?? "", artist);

    if (score >= 0.6 && (!best || score > best.score)) {
      best = { score, url: hit.previewUrl };
    }
  }

  return best?.url;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Dice coefficient over bigrams; cheap fuzzy similarity in 0..1. */
function similarity(a: string, b: string): number {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);

  if (normalizedA.length === 0 || normalizedB.length === 0) {
    return 0;
  }

  if (normalizedA === normalizedB) {
    return 1;
  }

  const bigrams = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();

    for (let index = 0; index < value.length - 1; index++) {
      const gram = value.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }

    return counts;
  };
  const left = bigrams(normalizedA);
  const right = bigrams(normalizedB);
  let intersection = 0;

  for (const [gram, count] of left) {
    const other = right.get(gram);

    if (other) {
      intersection += Math.min(count, other);
    }
  }

  const total = normalizedA.length - 1 + (normalizedB.length - 1);

  return total > 0 ? (2 * intersection) / total : 0;
}

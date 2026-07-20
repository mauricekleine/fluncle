// Recovery from a STALE BUILD held open in a tab.
//
// The problem: the SSR document references build-scoped hashed asset URLs
// (`/assets/<hash>.js`). Deploys land many times a day, and each one replaces the
// whole `/assets` set. A client still holding a page from an older build therefore
// 404s on every lazy-loaded chunk the moment it navigates — one audit run logged 71
// `/assets/*.js` 404s — and client-side navigation stays broken until the visitor
// reloads by hand. Nothing on the page tells them to.
//
// The remedy is the standard one: notice that the failure IS a missing chunk, and
// reload once to pick up the current build. The two halves live here — a predicate
// over the error, and a reload guarded against looping — and `routes/__root.tsx`
// wires them to the two places the failure surfaces (Vite's `vite:preloadError`
// event, and the router's root `errorComponent`).
//
// The other half of the guarantee is on the server: `lib/server/edge-cache.ts` keeps
// the HTML stale-while-revalidate tail inside the deploy cadence, so edge-served HTML
// does not outlive its assets in the first place. This is the client-side backstop for
// the tab that was already open.

// A missing/replaced chunk surfaces with browser-specific wording, so match on the
// stable fragments rather than one exact string. The last two catch the shape this
// site produces specifically: a 404 for `/assets/<hash>.js` is answered with the SPA
// HTML document, so the browser rejects it as the wrong MIME type for a module.
const STALE_BUILD_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "unable to preload css",
  "is not a valid javascript mime type",
  "expected a javascript module script",
];

/**
 * True when an error is a failed dynamic import / chunk load — i.e. this client is
 * running against a build whose assets no longer exist. Accepts the raw `unknown` an
 * error boundary hands over; anything without a matching message is NOT treated as a
 * stale build, so a genuine application error still reaches the error screen.
 */
export function isStaleBuildError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();

  return STALE_BUILD_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Where the one-shot reload attempt is recorded, so a second failure does not loop. */
export const STALE_BUILD_RELOAD_KEY = "fluncle:stale-build-reload";
/**
 * How long a recorded attempt suppresses another one. A reload that fixed the problem
 * costs one hop; a reload that did not (the chunk is genuinely gone, or the failure was
 * never about the build) must not spin. A minute is long enough to cover the reload plus
 * the navigation that follows it, and short enough that a much later, unrelated failure
 * still gets its own single attempt.
 */
export const STALE_BUILD_RELOAD_COOLDOWN_MS = 60_000;

/**
 * Reload once to pick up the current build. No-ops on the server, and no-ops when an
 * attempt was already recorded within the cooldown.
 *
 * Loop safety is the whole point, so the storage failure mode is deliberate: if
 * `sessionStorage` is unavailable (private mode, blocked storage) we cannot prove this
 * is the FIRST attempt, so we do not reload at all — an error screen the visitor can act
 * on beats a tab that refreshes forever.
 */
export function recoverFromStaleBuild(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const last = Number(window.sessionStorage.getItem(STALE_BUILD_RELOAD_KEY));

    if (Number.isFinite(last) && last > 0 && Date.now() - last < STALE_BUILD_RELOAD_COOLDOWN_MS) {
      return;
    }

    window.sessionStorage.setItem(STALE_BUILD_RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }

  window.location.reload();
}

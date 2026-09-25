const STALE_BUILD_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "unable to preload css",
  "is not a valid javascript mime type",
  "expected a javascript module script",
];

export function isStaleBuildError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();

  return STALE_BUILD_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export const STALE_BUILD_RELOAD_KEY = "fluncle:stale-build-reload";

export const STALE_BUILD_RELOAD_COOLDOWN_MS = 60_000;

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

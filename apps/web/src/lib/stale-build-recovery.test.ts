import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStaleBuildError,
  recoverFromStaleBuild,
  STALE_BUILD_RELOAD_COOLDOWN_MS,
  STALE_BUILD_RELOAD_KEY,
} from "./stale-build-recovery";

// The deploy-resilience rail. A deploy replaces every hashed asset, so a tab still holding
// an older build 404s on its next lazy chunk and client-side navigation dies until a manual
// reload. Two properties decide whether the remedy is safe: it must fire on a chunk-load
// failure and ONLY on one (a real application error must still reach the error screen), and
// it must never be able to loop. Both are pinned here.

describe("isStaleBuildError", () => {
  it("matches the chunk-load failures each browser words differently", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://www.fluncle.com/assets/index-DrnJt_M_.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/index-DkgSNzy0.css",
      // The shape this site produces: the 404 is answered with the SPA HTML document.
      'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
      "'text/html' is not a valid JavaScript MIME type",
    ]) {
      expect(isStaleBuildError(new Error(message))).toBe(true);
    }
  });

  it("does NOT match a genuine application error", () => {
    // The reload is a data-losing action, so anything it cannot positively identify as a
    // missing chunk must fall through to the error boundary instead.
    expect(isStaleBuildError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleBuildError(new Error("Turso read failed"))).toBe(false);
    expect(isStaleBuildError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
    expect(isStaleBuildError({})).toBe(false);
    expect(isStaleBuildError("")).toBe(false);
  });

  it("accepts a raw string error (what an error boundary may hand over)", () => {
    expect(isStaleBuildError("Failed to fetch dynamically imported module")).toBe(true);
  });
});

describe("recoverFromStaleBuild", () => {
  const reload = vi.fn();
  let store: Map<string, string>;
  let throwOnAccess: boolean;

  beforeEach(() => {
    reload.mockClear();
    store = new Map<string, string>();
    throwOnAccess = false;
    vi.stubGlobal("window", {
      location: { reload },
      sessionStorage: {
        getItem: (key: string): string | null => {
          if (throwOnAccess) {
            throw new Error("storage blocked");
          }

          return store.get(key) ?? null;
        },
        setItem: (key: string, value: string): void => {
          if (throwOnAccess) {
            throw new Error("storage blocked");
          }

          store.set(key, value);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reloads once and records the attempt", () => {
    recoverFromStaleBuild();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.get(STALE_BUILD_RELOAD_KEY)).toBeDefined();
  });

  it("does NOT loop: a second failure inside the cooldown is suppressed", () => {
    // The failure mode that matters. If the new build is broken too (or the error was
    // never about the build), the tab must settle on an error screen, not spin.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));

    recoverFromStaleBuild();
    recoverFromStaleBuild();
    vi.advanceTimersByTime(STALE_BUILD_RELOAD_COOLDOWN_MS - 1);
    recoverFromStaleBuild();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh attempt once the cooldown has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));

    recoverFromStaleBuild();
    vi.advanceTimersByTime(STALE_BUILD_RELOAD_COOLDOWN_MS + 1);
    recoverFromStaleBuild();

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does NOT reload when sessionStorage is unavailable", () => {
    // Without storage we cannot prove this is the first attempt, and an unprovable
    // first attempt is indistinguishable from a loop. Degrade to the error screen.
    throwOnAccess = true;

    recoverFromStaleBuild();

    expect(reload).not.toHaveBeenCalled();
  });

  it("no-ops on the server", () => {
    vi.stubGlobal("window", undefined);

    expect(() => recoverFromStaleBuild()).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });
});

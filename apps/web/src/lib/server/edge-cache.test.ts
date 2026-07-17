import { describe, expect, it } from "vitest";
import {
  FRESH_SECONDS,
  isCacheableLogPath,
  logPurgeUrls,
  PUBLIC_CACHE_CONTROL,
  purgeLogCache,
  SWR_SECONDS,
} from "./edge-cache";

// Pure-logic coverage for the /log edge cache. The parts that only prod can prove —
// that `caches.default` actually stores/serves/revalidates, and that the global
// zone purge lands in every data center — are NOT exercised here (no Workers runtime
// under Node; the `cloudflare:workers` stub gives an empty `env` and no `caches`
// global, so the store/purge paths deliberately no-op). What IS pinned below is the
// deterministic surface those paths are built from: which paths are cacheable, the
// exact browser/edge directive, the exact purge-URL set, and the write-path no-op
// guards. A regression in any of these silently breaks correctness in prod (a stale
// page served forever, or the wrong surface cached), so they're worth pinning.

describe("isCacheableLogPath", () => {
  it("matches the log index and a finding's log page", () => {
    expect(isCacheableLogPath("/log")).toBe(true);
    expect(isCacheableLogPath("/log/")).toBe(true);
    expect(isCacheableLogPath("/log/2026.A.7Q")).toBe(true);
    // A mixtape coordinate (F-marked) is served by the same route.
    expect(isCacheableLogPath("/log/2026.F.01")).toBe(true);
  });

  it("does NOT match a sibling surface that merely shares the `log` prefix", () => {
    // The guard is `=== "/log"` or `startsWith("/log/")` — so /logbook (and its
    // sector pages) must NOT be caught by the /log cache, or a logbook write would
    // never purge it and a finding write would wrongly purge it. This is the exact
    // boundary a careless `startsWith("/log")` would get wrong.
    expect(isCacheableLogPath("/logbook")).toBe(false);
    expect(isCacheableLogPath("/logbook/2026")).toBe(false);
    expect(isCacheableLogPath("/log-in")).toBe(false);
    expect(isCacheableLogPath("/")).toBe(false);
    expect(isCacheableLogPath("/about")).toBe(false);
  });
});

describe("PUBLIC_CACHE_CONTROL", () => {
  it("keeps the browser cache conservative but lets the edge hold + revalidate", () => {
    // The public log page carries no per-user data, so it is `public` — but the
    // browser copy is `max-age=0` (always revalidate against the edge, never pin a
    // stale page locally), while the shared edge holds it fresh for the short window
    // and serves stale-while-revalidating past it.
    expect(PUBLIC_CACHE_CONTROL).toBe(
      `public, max-age=0, s-maxage=${FRESH_SECONDS}, stale-while-revalidate=${SWR_SECONDS}`,
    );
    expect(PUBLIC_CACHE_CONTROL).toContain("public");
    expect(PUBLIC_CACHE_CONTROL).toContain("max-age=0");
    expect(PUBLIC_CACHE_CONTROL).toContain("s-maxage=300");
    expect(PUBLIC_CACHE_CONTROL).toContain("stale-while-revalidate=86400");
  });

  it("uses a short fresh window and a long stale tail", () => {
    // The shape the design argues for: a short fresh window (an edit surfaces fast
    // even if a purge is missed) with a long stale tail (a quiet archive collapses
    // traffic onto one render). Pin the ordering so a swap can't invert them.
    expect(FRESH_SECONDS).toBe(300);
    expect(SWR_SECONDS).toBe(86_400);
    expect(SWR_SECONDS).toBeGreaterThan(FRESH_SECONDS);
  });
});

describe("logPurgeUrls", () => {
  const CANONICAL = "https://www.fluncle.com";

  it("purges the finding's own page AND the index off the canonical origin", () => {
    // Both, always: an edited finding restates itself on its own page and in the
    // index list. The origin is the canonical one the read path stored under, never
    // the incoming host — so the delete lands on the entry a read created.
    expect(logPurgeUrls("2026.A.7Q")).toEqual([`${CANONICAL}/log/2026.A.7Q`, `${CANONICAL}/log`]);
  });

  it("URL-encodes the coordinate into the path segment", () => {
    // A coordinate is dot-delimited (unreserved, so it rides through verbatim), but
    // anything needing encoding must be encoded so the purge URL matches the stored
    // key exactly. A space would fragment the URL if left raw.
    expect(logPurgeUrls("2026.F.01")).toEqual([`${CANONICAL}/log/2026.F.01`, `${CANONICAL}/log`]);
    expect(logPurgeUrls("a b")[0]).toBe(`${CANONICAL}/log/a%20b`);
  });
});

describe("purgeLogCache", () => {
  it("is a safe no-op for a missing or blank logId", () => {
    // The write paths call it with whatever log_id they have; an unminted claim (no
    // coordinate yet) or a blank string must never throw or fire a purge.
    expect(() => purgeLogCache(null)).not.toThrow();
    expect(() => purgeLogCache(undefined)).not.toThrow();
    expect(() => purgeLogCache("")).not.toThrow();
    expect(() => purgeLogCache("   ")).not.toThrow();
  });

  it("does not throw for a real logId outside the Workers runtime", () => {
    // Under Node (no `caches` global, empty `env`) the local delete + global purge
    // both degrade to a no-op — the write path is never blocked and never errors.
    expect(() => purgeLogCache("2026.A.7Q")).not.toThrow();
  });
});

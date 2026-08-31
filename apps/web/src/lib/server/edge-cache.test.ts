import { afterEach, describe, expect, it, vi } from "vitest";
import {
  edgeCachePolicyFor,
  entityPurgeUrl,
  FRESH_SECONDS,
  HUB_CACHE_POLICY,
  HUB_FRESH_SECONDS,
  HUB_SWR_SECONDS,
  isCacheableEntityRequest,
  isCacheableHubRequest,
  isCacheableLogPath,
  logPurgeUrls,
  PAGE_CACHE_POLICY,
  PUBLIC_CACHE_CONTROL,
  purgeEntityCache,
  purgeEntityCaches,
  purgeLogCache,
  SITEMAP_CACHE_POLICY,
  SITEMAP_FRESH_SECONDS,
  SITEMAP_SWR_SECONDS,
  SWR_SECONDS,
  withEdgeCache,
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
    expect(PUBLIC_CACHE_CONTROL).toContain("stale-while-revalidate=3600");
  });

  it("keeps the stale tail inside the deploy cadence, not a whole day", () => {
    // The shape the design argues for: a short fresh window (an edit surfaces fast even
    // if a purge is missed) with a stale tail that still collapses traffic onto one
    // render — but BOUNDED, because the SSR document references build-scoped hashed
    // asset URLs. HTML that outlives its build hands a client dead `/assets/<hash>.js`
    // URLs and breaks client-side navigation. Deploys land many times a day, so a
    // day-long tail was strictly wrong; an hour keeps it inside the cadence.
    expect(FRESH_SECONDS).toBe(300);
    expect(SWR_SECONDS).toBe(3_600);
    expect(SWR_SECONDS).toBeGreaterThan(FRESH_SECONDS);
    expect(SWR_SECONDS).toBeLessThanOrEqual(3_600);
  });

  it("stores an entry for the whole fresh+stale window under each policy", () => {
    // The stored hard TTL must cover the full window, or a stale-serve is impossible and
    // every request past the fresh window pays a cold render.
    expect(PAGE_CACHE_POLICY.storedMaxAge).toBe(FRESH_SECONDS + SWR_SECONDS);
    expect(HUB_CACHE_POLICY.storedMaxAge).toBe(HUB_FRESH_SECONDS + HUB_SWR_SECONDS);
  });
});

describe("the hub policy", () => {
  it("holds a hub fresh for a minute with a short stale tail", () => {
    // A hub/index invalidates on ANY member change across four entity kinds and several
    // write paths (including the catalogue crawler), so it is deliberately NOT purged —
    // an explicit purge would be a wide, easy-to-miss fan-out and the crawler alone would
    // purge continuously. A 60s ceiling is the invalidation instead: bounded, self-healing,
    // and still enough to collapse effectively all traffic onto one render per minute.
    expect(HUB_FRESH_SECONDS).toBe(60);
    expect(HUB_SWR_SECONDS).toBe(600);
    expect(HUB_FRESH_SECONDS).toBeLessThan(FRESH_SECONDS);
    expect(HUB_CACHE_POLICY.cacheControl).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=600",
    );
  });
});

describe("the sitemap policy", () => {
  it("holds a sitemap fresh for an hour with a day-long stale tail", () => {
    // A crawl cadence tolerates staleness a reader would not: an hour is well inside what
    // Search Console expects, and the alternative is every crawler hit paying the
    // archive-wide read behind the document (measured 3.2–13.6s, and timing the post-deploy
    // surface sweep out twice).
    expect(SITEMAP_FRESH_SECONDS).toBe(3_600);
    expect(SITEMAP_SWR_SECONDS).toBe(86_400);
    expect(SITEMAP_CACHE_POLICY.cacheControl).toBe(
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    );
    expect(SITEMAP_CACHE_POLICY.storedMaxAge).toBe(SITEMAP_FRESH_SECONDS + SITEMAP_SWR_SECONDS);
  });

  it("is the one XML tier — the HTML tiers stay HTML", () => {
    // `contentType` is both the storability gate and what lets server.ts skip the
    // HTML-accepting-client guard for a crawler that asks for XML (or asks for nothing).
    expect(SITEMAP_CACHE_POLICY.contentType).toBe("application/xml");
    expect(PAGE_CACHE_POLICY.contentType).toBe("text/html");
    expect(HUB_CACHE_POLICY.contentType).toBe("text/html");
  });

  it("outlives its build safely, unlike the HTML tiers", () => {
    // The HTML tail is capped at an hour because an SSR document references build-scoped
    // `/assets/<hash>.js`. An XML sitemap references no assets, so a day-long tail is free.
    expect(SITEMAP_SWR_SECONDS).toBeGreaterThan(SWR_SECONDS);
  });
});

describe("isCacheableHubRequest", () => {
  it("matches the five paginated hub/index pages on their canonical query-less URL", () => {
    for (const path of ["/artists", "/albums", "/labels", "/tracks", "/fresh"]) {
      expect(isCacheableHubRequest(path, "")).toBe(true);
    }

    // A single trailing slash is the same canonical page.
    expect(isCacheableHubRequest("/artists/", "")).toBe(true);
  });

  it("matches the stable public pages enrolled at the hub policy on their bare URL", () => {
    // FIX 2: the index/static/legal/docs pages that previously emitted no Cache-Control.
    for (const path of [
      // The front door and the archive feed: bare-URL-only, so no query is ever shared-cached.
      "/",
      "/findings",
      "/galaxies",
      "/mixtapes",
      "/logbook",
      "/newsletter",
      "/reach",
      "/about",
      "/privacy",
      "/terms",
      "/docs",
      "/docs/api",
      "/docs/getting-started",
      // Stable-but-writable detail pages ride the hub window (no purge coupling).
      "/galaxies/drift",
      "/logbook/2026-07-20",
      "/newsletter/3",
    ]) {
      expect(isCacheableHubRequest(path, "")).toBe(true);
    }

    // A single trailing slash is the same canonical page.
    expect(isCacheableHubRequest("/mixtapes/", "")).toBe(true);
    expect(isCacheableHubRequest("/docs/", "")).toBe(true);
  });

  it("caches a LONE numeric ?page=N on a paginated hub (folded into the key)", () => {
    // FIX 1: the documented crawler pager into the catalogue long tail. A lone positive
    // integer is cacheable; the key folds the parsed page so N never collides onto page 1.
    expect(isCacheableHubRequest("/artists", "?page=2")).toBe(true);
    expect(isCacheableHubRequest("/albums", "?page=3")).toBe(true);
    expect(isCacheableHubRequest("/labels", "?page=42")).toBe(true);
    expect(isCacheableHubRequest("/artists/", "?page=2")).toBe(true);
    // A parsed positive integer with leading zeros is still one page.
    expect(isCacheableHubRequest("/artists", "?page=007")).toBe(true);
  });

  it("REFUSES a non-lone-numeric page or any other query on the paginated hubs", () => {
    // THE safety property: only a lone positive integer folds into the key. Anything else
    // must flow UNCACHED, or the query-dropping key would serve the wrong body.
    expect(isCacheableHubRequest("/artists", "?page=0")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?page=-1")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?page=1.5")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?page=abc")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?page=")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?page=2&page=3")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?page=2&sort=old")).toBe(false);
    expect(isCacheableHubRequest("/artists", "?q=drift")).toBe(false);
    expect(isCacheableHubRequest("/tracks", "?galaxy=drift")).toBe(false);
    expect(isCacheableHubRequest("/tracks", "?sort=oldest")).toBe(false);
    expect(isCacheableHubRequest("/fresh", "?view=labels")).toBe(false);
  });

  it("REFUSES ANY query on a bare-URL-only static/detail page — even ?page=N", () => {
    // The FIX-2 pages are NOT paginated hubs: a `?page=` on a galaxy/sector, a `?platform=`
    // on /reach, or any other param must flow uncached (the key drops it).
    expect(isCacheableHubRequest("/galaxies/drift", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/logbook/2026-07-20", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/reach", "?platform=tiktok")).toBe(false);
    expect(isCacheableHubRequest("/galaxies", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/docs/api", "?v=2")).toBe(false);
    expect(isCacheableHubRequest("/newsletter", "?utm=x")).toBe(false);
    // The front door takes no params at all, and the archive feed's `?story=` (the Stories
    // dialog's per-reader URL) must never land in a SHARED cache entry.
    expect(isCacheableHubRequest("/", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/findings", "?story=2026.A.7Q")).toBe(false);
    expect(isCacheableHubRequest("/findings", "?page=2")).toBe(false);
  });

  it("does NOT match a neighbouring or malformed path", () => {
    expect(isCacheableHubRequest("/artist/sub-focus", "")).toBe(false);
    expect(isCacheableHubRequest("/artists/sub-focus", "")).toBe(false);
    expect(isCacheableHubRequest("/tracksy", "")).toBe(false);
    expect(isCacheableHubRequest("/admin", "")).toBe(false);
    expect(isCacheableHubRequest("/admin/tracks", "")).toBe(false);
    expect(isCacheableHubRequest("/account", "")).toBe(false);
    expect(isCacheableHubRequest("/recommendations", "")).toBe(false);
    expect(isCacheableHubRequest("/chat", "")).toBe(false);
    // Interactive/personalized siblings that share a prefix must NOT be caught.
    expect(isCacheableHubRequest("/galaxy", "")).toBe(false);
    expect(isCacheableHubRequest("/mix", "")).toBe(false);
    expect(isCacheableHubRequest("/pipeline", "")).toBe(false);
    expect(isCacheableHubRequest("/device", "")).toBe(false);
    expect(isCacheableHubRequest("/status", "")).toBe(false);
    // The markdown emitter shares the `docs` stem but is a non-HTML surface: must NOT match.
    expect(isCacheableHubRequest("/docs.md/getting-started", "")).toBe(false);
    // A nested path under a detail parent is not a detail page.
    expect(isCacheableHubRequest("/galaxies/drift/tracks", "")).toBe(false);
    // A doubled root is not the root: it must not fold onto the `/` entry.
    expect(isCacheableHubRequest("//", "")).toBe(false);
  });
});

describe("edgeCachePolicyFor", () => {
  it("routes each cacheable surface to its policy", () => {
    expect(edgeCachePolicyFor("/log", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/log/2026.A.7Q", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/artist/sub-focus", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/", "")).toBe(HUB_CACHE_POLICY);
    expect(edgeCachePolicyFor("/artists", "")).toBe(HUB_CACHE_POLICY);
    expect(edgeCachePolicyFor("/fresh", "")).toBe(HUB_CACHE_POLICY);
    // A lone page on a paginated hub rides the hub policy (its key folds the page).
    expect(edgeCachePolicyFor("/artists", "?page=3")).toBe(HUB_CACHE_POLICY);
  });

  // `/search` is deliberately enrolled NOWHERE. A `?q=` view's key space is unbounded and its body
  // is per-query, so a shared cache would either fragment without limit or (worse, if the key
  // dropped the query the way the hub key drops `?utm=`) serve one reader's results to another.
  // The bare surface is free to render, so there is nothing to buy by caching it either.
  it("never shared-caches the search surface, bare or with a query", () => {
    expect(edgeCachePolicyFor("/search", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/search", "?q=netsky")).toBeUndefined();
    expect(edgeCachePolicyFor("/search/", "?q=netsky")).toBeUndefined();
  });

  it("routes the sitemap documents to the sitemap policy, index and children alike", () => {
    expect(edgeCachePolicyFor("/sitemap.xml", "")).toBe(SITEMAP_CACHE_POLICY);

    for (const shard of [
      "/sitemap/pages-1.xml",
      "/sitemap/findings-1.xml",
      "/sitemap/findings-2.xml",
      "/sitemap/artists-1.xml",
      "/sitemap/labels-1.xml",
      "/sitemap/albums-1.xml",
      "/sitemap/galaxies-1.xml",
      "/sitemap/logbook-1.xml",
      "/sitemap/docs-1.xml",
    ]) {
      expect(edgeCachePolicyFor(shard, "")).toBe(SITEMAP_CACHE_POLICY);
    }

    // Each child keys as its own entry, so no two children can collide — the whole identity is
    // in the path segment and the key drops nothing.
    expect(edgeCachePolicyFor("/sitemap/labels-1.xml", "")).toBe(
      edgeCachePolicyFor("/sitemap/albums-1.xml", ""),
    );
  });

  it("refuses a query variant or a sibling that merely shares the `sitemap` stem", () => {
    // The key drops the query, so a `?page=` variant must never be shared-cached as the document.
    expect(edgeCachePolicyFor("/sitemap.xml", "?page=2")).toBeUndefined();
    expect(edgeCachePolicyFor("/sitemap/findings-1.xml", "?utm=x")).toBeUndefined();
    // A nested path is not a child, and a bare `/sitemap` is not a document.
    expect(edgeCachePolicyFor("/sitemap/findings/1.xml", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/sitemap", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/sitemaps.xml", "")).toBeUndefined();
  });

  it("routes the newly-enrolled stable public pages to the hub policy", () => {
    for (const path of [
      "/galaxies",
      "/galaxies/drift",
      "/mixtapes",
      "/logbook",
      "/logbook/2026-07-20",
      "/newsletter",
      "/newsletter/3",
      "/reach",
      "/about",
      "/privacy",
      "/terms",
      "/docs",
      "/docs/api",
    ]) {
      expect(edgeCachePolicyFor(path, "")).toBe(HUB_CACHE_POLICY);
    }
  });

  it("returns undefined — never a policy — for anything not on the cacheable list", () => {
    // `undefined` is what tells server.ts to bypass the shared cache entirely. Every
    // account/admin/personalized/interactive surface must land here, as must an unknown path.
    for (const path of [
      "/admin",
      "/admin/tracks",
      "/account",
      "/recommendations",
      "/chat",
      "/device",
      "/status",
      "/galaxy",
      "/mix",
      "/pipeline",
      "/api/v1/tracks",
      "/nope",
    ]) {
      expect(edgeCachePolicyFor(path, "")).toBeUndefined();
    }
  });

  it("returns undefined for a query-bearing entity URL or a non-lone-page hub URL", () => {
    expect(edgeCachePolicyFor("/artist/sub-focus", "?page=2")).toBeUndefined();
    // A non-lone-numeric page or a second param is refused even on a paginated hub.
    expect(edgeCachePolicyFor("/artists", "?page=0")).toBeUndefined();
    expect(edgeCachePolicyFor("/artists", "?page=2&sort=old")).toBeUndefined();
    expect(edgeCachePolicyFor("/tracks", "?galaxy=drift")).toBeUndefined();
    // Any query on a bare-URL-only static/detail page is refused.
    expect(edgeCachePolicyFor("/reach", "?platform=tiktok")).toBeUndefined();
    expect(edgeCachePolicyFor("/galaxies/drift", "?page=2")).toBeUndefined();
  });
});

describe("withEdgeCache", () => {
  // Exercise the store/serve/stale machinery against a fake `caches.default`. The real
  // Workers cache is absent under Node, so the module's `edgeCache()` lookup finds
  // nothing and every path renders straight through — install a stand-in so the policy
  // plumbing (which TTL is written where) is actually proven rather than argued.
  function installFakeCache(): { entries: Map<string, Response>; restore: () => void } {
    const entries = new Map<string, Response>();
    const cache = {
      delete: async (key: Request) => entries.delete(key.url),
      match: async (key: Request) => {
        const stored = entries.get(key.url);

        return stored ? stored.clone() : undefined;
      },
      put: async (key: Request, response: Response) => {
        entries.set(key.url, response);
      },
    };
    const globals = globalThis as { caches?: unknown };
    const previous = globals.caches;
    globals.caches = { default: cache };

    return {
      entries,
      restore: () => {
        globals.caches = previous;
      },
    };
  }

  function html(body: string): Response {
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores under the CANONICAL origin + path, dropping the incoming host", async () => {
    const fake = installFakeCache();

    try {
      await withEdgeCache(
        new Request("https://preview.example.com/artists"),
        async () => html("hubs"),
        HUB_CACHE_POLICY,
      );
      await Promise.resolve();

      expect([...fake.entries.keys()]).toEqual(["https://www.fluncle.com/artists"]);
    } finally {
      fake.restore();
    }
  });

  it("keys a paginated hub's ?page=N under its OWN entry — never colliding onto page 1", async () => {
    // THE sacred collision-safety property (FIX 1): page 1 (`/artists`), page 2, and page 3 each
    // get a distinct `caches.default` key, and a repeat hit on any of them serves ITS body — so
    // the query-dropping key can never serve page 2's body back for page 1.
    const fake = installFakeCache();

    try {
      await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        async () => html("page-1"),
        HUB_CACHE_POLICY,
      );
      await withEdgeCache(
        new Request("https://www.fluncle.com/artists?page=2"),
        async () => html("page-2"),
        HUB_CACHE_POLICY,
      );
      await withEdgeCache(
        new Request("https://www.fluncle.com/artists?page=3"),
        async () => html("page-3"),
        HUB_CACHE_POLICY,
      );
      await Promise.resolve();

      // Three distinct keys, the page folded verbatim into the key path.
      expect(new Set(fake.entries.keys())).toEqual(
        new Set([
          "https://www.fluncle.com/artists",
          "https://www.fluncle.com/artists?page=2",
          "https://www.fluncle.com/artists?page=3",
        ]),
      );

      // Each key serves its OWN body back on a hit — no cross-page bleed.
      const p1 = await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        async () => html("MISS-1"),
        HUB_CACHE_POLICY,
      );
      const p2 = await withEdgeCache(
        new Request("https://www.fluncle.com/artists?page=2"),
        async () => html("MISS-2"),
        HUB_CACHE_POLICY,
      );

      expect(p1.headers.get("x-edge-cache")).toBe("fresh");
      expect(await p1.text()).toBe("page-1");
      expect(p2.headers.get("x-edge-cache")).toBe("fresh");
      expect(await p2.text()).toBe("page-2");
    } finally {
      fake.restore();
    }
  });

  it("normalizes ?page=007 and ?page=7 onto ONE canonical entry", async () => {
    // The key folds the PARSED integer, so equivalent spellings share one entry rather than
    // splintering the cache (and a share/utm param on a paginated hub never fragments it).
    const fake = installFakeCache();

    try {
      await withEdgeCache(
        new Request("https://www.fluncle.com/albums?page=007"),
        async () => html("page-7"),
        HUB_CACHE_POLICY,
      );
      await Promise.resolve();

      expect([...fake.entries.keys()]).toEqual(["https://www.fluncle.com/albums?page=7"]);

      const hit = await withEdgeCache(
        new Request("https://www.fluncle.com/albums?page=7"),
        async () => html("MISS"),
        HUB_CACHE_POLICY,
      );

      expect(hit.headers.get("x-edge-cache")).toBe("fresh");
      expect(await hit.text()).toBe("page-7");
    } finally {
      fake.restore();
    }
  });

  it("serves the stored copy on the next hit and tags the policy's directive", async () => {
    const fake = installFakeCache();
    const render = vi.fn(async () => html("hubs"));

    try {
      const miss = await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        render,
        HUB_CACHE_POLICY,
      );

      expect(miss.headers.get("x-edge-cache")).toBe("miss");
      expect(miss.headers.get("Cache-Control")).toBe(HUB_CACHE_POLICY.cacheControl);
      await Promise.resolve();

      const hit = await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        render,
        HUB_CACHE_POLICY,
      );

      expect(hit.headers.get("x-edge-cache")).toBe("fresh");
      // The hub directive, not the page one — a hub must never inherit the longer TTL.
      expect(hit.headers.get("Cache-Control")).toBe(HUB_CACHE_POLICY.cacheControl);
      expect(await hit.text()).toBe("hubs");
      // Still one render: the whole point.
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      fake.restore();
    }
  });

  it("goes stale at the POLICY's fresh window, so a hub expires long before a page", async () => {
    const fake = installFakeCache();

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
      await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        async () => html("hubs"),
        HUB_CACHE_POLICY,
      );
      await vi.advanceTimersByTimeAsync(0);

      // 90s: past the hub's 60s fresh window, well inside the page policy's 300s one.
      vi.setSystemTime(new Date("2026-07-20T00:01:30.000Z"));

      const stale = await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        async () => html("hubs"),
        HUB_CACHE_POLICY,
      );

      expect(stale.headers.get("x-edge-cache")).toBe("stale");
    } finally {
      vi.useRealTimers();
      fake.restore();
    }
  });

  it("never stores a non-200 or non-HTML response", async () => {
    const fake = installFakeCache();

    try {
      await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        async () => new Response("nope", { status: 500 }),
        HUB_CACHE_POLICY,
      );
      await withEdgeCache(
        new Request("https://www.fluncle.com/tracks"),
        async () => new Response("{}", { headers: { "content-type": "application/json" } }),
        HUB_CACHE_POLICY,
      );
      await Promise.resolve();

      expect(fake.entries.size).toBe(0);
    } finally {
      fake.restore();
    }
  });

  it("stores and serves an XML sitemap under the sitemap policy", async () => {
    const fake = installFakeCache();
    const xml = (): Response =>
      new Response("<sitemapindex/>", {
        headers: { "content-type": "application/xml; charset=utf-8" },
      });

    try {
      const miss = await withEdgeCache(
        new Request("https://www.fluncle.com/sitemap.xml"),
        async () => xml(),
        SITEMAP_CACHE_POLICY,
      );
      await Promise.resolve();

      expect(miss.headers.get("x-edge-cache")).toBe("miss");
      expect(miss.headers.get("Cache-Control")).toBe(SITEMAP_CACHE_POLICY.cacheControl);
      expect(fake.entries.size).toBe(1);

      // The second crawl is served from the store — the whole point: the archive-wide read
      // behind the document runs once an hour, not once per crawler.
      const hit = await withEdgeCache(
        new Request("https://www.fluncle.com/sitemap.xml"),
        async () => {
          throw new Error("must not re-render a fresh sitemap");
        },
        SITEMAP_CACHE_POLICY,
      );

      expect(hit.headers.get("x-edge-cache")).toBe("fresh");
      expect(await hit.text()).toBe("<sitemapindex/>");
    } finally {
      fake.restore();
    }
  });

  it("stores only the policy's own content-type — a shard 404 or a stray page is never stored", async () => {
    const fake = installFakeCache();

    try {
      // A shard past the end 404s with a plain-text body: never stored as the sitemap.
      await withEdgeCache(
        new Request("https://www.fluncle.com/sitemap/findings-9.xml"),
        async () => new Response("Not found", { status: 404 }),
        SITEMAP_CACHE_POLICY,
      );
      // Nor an HTML body off a sitemap path (an error page slipping through the router).
      await withEdgeCache(
        new Request("https://www.fluncle.com/sitemap/labels-1.xml"),
        async () => html("<html>oops</html>"),
        SITEMAP_CACHE_POLICY,
      );
      // And the gate runs both ways: XML is not storable under an HTML policy.
      await withEdgeCache(
        new Request("https://www.fluncle.com/artists"),
        async () => new Response("<x/>", { headers: { "content-type": "application/xml" } }),
        HUB_CACHE_POLICY,
      );
      await Promise.resolve();

      expect(fake.entries.size).toBe(0);
    } finally {
      fake.restore();
    }
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

describe("isCacheableEntityRequest", () => {
  it("matches an artist/album/label/track DETAIL page with no query string", () => {
    // The four singular detail routes, and only their canonical query-less URL.
    expect(isCacheableEntityRequest("/artist/sub-focus", "")).toBe(true);
    expect(isCacheableEntityRequest("/album/all-that-jazz", "")).toBe(true);
    expect(isCacheableEntityRequest("/label/hospital-records", "")).toBe(true);
    // The archive track destination. It matters most of the four: it has ~122k crawlable URLs
    // behind it, and an uncached view pays an exact vector scan for its neighbours, so an
    // uncached crawl is the expensive path this enrolment exists to collapse.
    expect(isCacheableEntityRequest("/track/mb_2b1c4d5e", "")).toBe(true);
    expect(isCacheableEntityRequest("/track/e2e-track-1", "")).toBe(true);
    // A trailing slash is the same canonical page.
    expect(isCacheableEntityRequest("/artist/sub-focus/", "")).toBe(true);
    expect(isCacheableEntityRequest("/track/mb_2b1c4d5e/", "")).toBe(true);
  });

  it("does NOT cache a paginated/sorted variant (the cache key drops the query)", () => {
    // The cache key strips the query string, so caching `?page=2` would serve it back
    // for page 1. A query-bearing request must flow through UNCACHED. This is the exact
    // collision the guard exists to prevent.
    expect(isCacheableEntityRequest("/artist/sub-focus", "?page=2")).toBe(false);
    expect(isCacheableEntityRequest("/label/hospital-records", "?sort=newest")).toBe(false);
  });

  it("does NOT match the plural INDEX pages or a nested/foreign path", () => {
    // The indexes (`/artists`) are cached, but under the separate HUB policy — they must
    // not be caught by the DETAIL predicate (which carries the longer, purge-backed TTL).
    // A nested path isn't a detail page either.
    expect(isCacheableEntityRequest("/artists", "")).toBe(false);
    expect(isCacheableEntityRequest("/albums", "")).toBe(false);
    expect(isCacheableEntityRequest("/labels", "")).toBe(false);
    expect(isCacheableEntityRequest("/artist/sub-focus/tracks", "")).toBe(false);
    expect(isCacheableEntityRequest("/artist", "")).toBe(false);
    expect(isCacheableEntityRequest("/log/2026.A.7Q", "")).toBe(false);
    // `/tracks` is the plural HUB and keeps its own (shorter, page-param-folding) enrolment —
    // the alternation requires a `/` after the segment, which is what keeps them apart.
    expect(isCacheableEntityRequest("/tracks", "")).toBe(false);
    expect(isCacheableEntityRequest("/tracks", "?page=2")).toBe(false);
    expect(isCacheableEntityRequest("/track", "")).toBe(false);
  });
});

describe("entityPurgeUrl", () => {
  const CANONICAL = "https://www.fluncle.com";

  it("builds the canonical detail-page URL per kind, off the canonical origin", () => {
    expect(entityPurgeUrl("artist", "sub-focus")).toBe(`${CANONICAL}/artist/sub-focus`);
    expect(entityPurgeUrl("album", "all-that-jazz")).toBe(`${CANONICAL}/album/all-that-jazz`);
    expect(entityPurgeUrl("label", "hospital-records")).toBe(`${CANONICAL}/label/hospital-records`);
    // The track kind carries the track's PERMANENT id in the slug position, so the purge key is
    // byte-identical to the read key `trackPagePath` builds.
    expect(entityPurgeUrl("track", "mb_2b1c4d5e")).toBe(`${CANONICAL}/track/mb_2b1c4d5e`);
  });

  it("every purgeable kind's URL is one the read path would actually cache", () => {
    // The pin that matters: a page the read path caches but the write path cannot purge goes
    // stale for its whole SWR window. Asserted over the KIND union, so a kind added later without
    // a matching read-path enrolment fails here.
    for (const kind of ["artist", "album", "label", "track"] as const) {
      const path = new URL(entityPurgeUrl(kind, "some-id")).pathname;

      expect(isCacheableEntityRequest(path, ""), `${kind} must be cacheable at ${path}`).toBe(true);
    }
  });

  it("URL-encodes the slug into the path segment", () => {
    // Slugs are normally kebab-safe, but anything needing encoding must match the stored
    // key exactly — a raw space would fragment the purge URL.
    expect(entityPurgeUrl("artist", "a b")).toBe(`${CANONICAL}/artist/a%20b`);
  });
});

describe("purge targets match the cached URL shapes", () => {
  // The correctness pin that matters most: a page the read path CACHES but the write
  // path fails to PURGE would serve stale content forever. Both derivations key off the
  // same canonical origin + path (edge-cache stores under cacheKeyForPath; the purges
  // emit entityPurgeUrl/logPurgeUrls), and both drop the query string. Rather than trust
  // that by inspection, pin it: every purge URL must round-trip back to a CACHEABLE,
  // query-less path — i.e. the exact shape the read path is willing to store. If either
  // side ever drifts (origin, encoding, a stray query), the predicate rejects it here.
  const CANONICAL = "https://www.fluncle.com";

  it("every entity purge URL is a cacheable, query-less canonical detail path", () => {
    const targets = [
      { kind: "artist", slug: "sub-focus" },
      { kind: "album", slug: "all-that-jazz" },
      { kind: "label", slug: "hospital-records" },
      { kind: "track", slug: "mb_2b1c4d5e" },
    ] as const;

    for (const { kind, slug } of targets) {
      const url = new URL(entityPurgeUrl(kind, slug));

      expect(url.origin).toBe(CANONICAL);
      expect(url.search).toBe("");
      // The read path (server.ts) only stores a request isCacheableEntityRequest accepts;
      // the purge URL must be exactly such a request, or the delete misses the stored entry.
      expect(isCacheableEntityRequest(url.pathname, url.search)).toBe(true);
    }
  });

  it("the finding's own page AND index purge URLs are cacheable, query-less log paths", () => {
    for (const raw of logPurgeUrls("2026.A.7Q")) {
      const url = new URL(raw);

      expect(url.origin).toBe(CANONICAL);
      expect(url.search).toBe("");
      expect(isCacheableLogPath(url.pathname)).toBe(true);
    }
  });
});

describe("purgeEntityCache / purgeEntityCaches", () => {
  it("is a safe no-op for a missing, blank, or empty target set", () => {
    // Write paths call these with whatever slug they hold; a blank slug or empty list
    // must never throw or fire a purge.
    expect(() => purgeEntityCache("artist", null)).not.toThrow();
    expect(() => purgeEntityCache("album", undefined)).not.toThrow();
    expect(() => purgeEntityCache("label", "  ")).not.toThrow();
    expect(() => purgeEntityCaches([])).not.toThrow();
    expect(() => purgeEntityCaches([{ kind: "artist", slug: "  " }])).not.toThrow();
  });

  it("does not throw for real targets outside the Workers runtime", () => {
    // Under Node the local delete + global purge degrade to a no-op, so the write path
    // is never blocked and never errors.
    expect(() => purgeEntityCache("artist", "sub-focus")).not.toThrow();
    expect(() =>
      purgeEntityCaches([
        { kind: "artist", slug: "sub-focus" },
        { kind: "label", slug: "hospital-records" },
      ]),
    ).not.toThrow();
  });
});

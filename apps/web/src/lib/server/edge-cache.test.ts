import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, takeWaitUntilPromises } from "../../test/cloudflare-workers-stub";
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
  isPublicHtmlPagePath,
  PAGE_CACHE_POLICY,
  PUBLIC_CACHE_CONTROL,
  purgeEntityCache,
  purgeEntityCaches,
  purgeLogCache,
  purgePathsNow,
  releaseBoundFeedCacheControl,
  SITEMAP_CACHE_POLICY,
  SITEMAP_FRESH_SECONDS,
  SITEMAP_SWR_SECONDS,
  SWR_SECONDS,
  withEdgeCache,
} from "./edge-cache";

describe("isCacheableLogPath", () => {
  it("matches the log index and a finding's log page", () => {
    expect(isCacheableLogPath("/log")).toBe(true);
    expect(isCacheableLogPath("/log/")).toBe(true);
    expect(isCacheableLogPath("/log/2026.A.7Q")).toBe(true);

    expect(isCacheableLogPath("/log/2026.F.01")).toBe(true);
  });

  it("does NOT match a sibling surface that merely shares the `log` prefix", () => {
    expect(isCacheableLogPath("/logbook")).toBe(false);
    expect(isCacheableLogPath("/logbook/2026")).toBe(false);
    expect(isCacheableLogPath("/log-in")).toBe(false);
    expect(isCacheableLogPath("/")).toBe(false);
    expect(isCacheableLogPath("/about")).toBe(false);
  });
});

describe("PUBLIC_CACHE_CONTROL", () => {
  it("keeps the browser cache conservative but lets the edge hold + revalidate", () => {
    expect(PUBLIC_CACHE_CONTROL).toBe(
      `public, max-age=0, s-maxage=${FRESH_SECONDS}, stale-while-revalidate=${SWR_SECONDS}`,
    );
    expect(PUBLIC_CACHE_CONTROL).toContain("public");
    expect(PUBLIC_CACHE_CONTROL).toContain("max-age=0");
    expect(PUBLIC_CACHE_CONTROL).toContain("s-maxage=300");
    expect(PUBLIC_CACHE_CONTROL).toContain("stale-while-revalidate=3600");
  });

  it("keeps the stale tail inside the deploy cadence, not a whole day", () => {
    expect(FRESH_SECONDS).toBe(300);
    expect(SWR_SECONDS).toBe(3_600);
    expect(SWR_SECONDS).toBeGreaterThan(FRESH_SECONDS);
    expect(SWR_SECONDS).toBeLessThanOrEqual(3_600);
  });

  it("stores an entry for the whole fresh+stale window under each policy", () => {
    expect(PAGE_CACHE_POLICY.storedMaxAge).toBe(FRESH_SECONDS + SWR_SECONDS);
    expect(HUB_CACHE_POLICY.storedMaxAge).toBe(HUB_FRESH_SECONDS + HUB_SWR_SECONDS);
  });
});

describe("the hub policy", () => {
  it("holds a hub fresh for a minute with a short stale tail", () => {
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
    expect(SITEMAP_FRESH_SECONDS).toBe(3_600);
    expect(SITEMAP_SWR_SECONDS).toBe(86_400);
    expect(SITEMAP_CACHE_POLICY.cacheControl).toBe(
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    );
    expect(SITEMAP_CACHE_POLICY.storedMaxAge).toBe(SITEMAP_FRESH_SECONDS + SITEMAP_SWR_SECONDS);
  });

  it("is the one XML tier — the HTML tiers stay HTML", () => {
    expect(SITEMAP_CACHE_POLICY.contentType).toBe("application/xml");
    expect(PAGE_CACHE_POLICY.contentType).toBe("text/html");
    expect(HUB_CACHE_POLICY.contentType).toBe("text/html");
  });

  it("outlives its build safely, unlike the HTML tiers", () => {
    expect(SITEMAP_SWR_SECONDS).toBeGreaterThan(SWR_SECONDS);
  });
});

describe("isCacheableHubRequest", () => {
  it("matches the five paginated hub/index pages on their canonical query-less URL", () => {
    for (const path of ["/artists", "/albums", "/labels", "/tracks", "/fresh"]) {
      expect(isCacheableHubRequest(path, "")).toBe(true);
    }

    expect(isCacheableHubRequest("/artists/", "")).toBe(true);
  });

  it("matches the stable public pages enrolled at the hub policy on their bare URL", () => {
    for (const path of [
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

      "/galaxies/drift",
      "/logbook/2026-07-20",
      "/newsletter/3",
    ]) {
      expect(isCacheableHubRequest(path, "")).toBe(true);
    }

    expect(isCacheableHubRequest("/mixtapes/", "")).toBe(true);
    expect(isCacheableHubRequest("/docs/", "")).toBe(true);
  });

  it("caches a LONE numeric ?page=N on a paginated hub (folded into the key)", () => {
    expect(isCacheableHubRequest("/artists", "?page=2")).toBe(true);
    expect(isCacheableHubRequest("/albums", "?page=3")).toBe(true);
    expect(isCacheableHubRequest("/labels", "?page=42")).toBe(true);
    expect(isCacheableHubRequest("/artists/", "?page=2")).toBe(true);

    expect(isCacheableHubRequest("/artists", "?page=007")).toBe(true);
  });

  it("REFUSES a non-lone-numeric page or any other query on the paginated hubs", () => {
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
    expect(isCacheableHubRequest("/galaxies/drift", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/logbook/2026-07-20", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/reach", "?platform=tiktok")).toBe(false);
    expect(isCacheableHubRequest("/galaxies", "?page=2")).toBe(false);
    expect(isCacheableHubRequest("/docs/api", "?v=2")).toBe(false);
    expect(isCacheableHubRequest("/newsletter", "?utm=x")).toBe(false);

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

    expect(isCacheableHubRequest("/galaxy", "")).toBe(false);
    expect(isCacheableHubRequest("/mix", "")).toBe(false);
    expect(isCacheableHubRequest("/pipeline", "")).toBe(false);
    expect(isCacheableHubRequest("/device", "")).toBe(false);
    expect(isCacheableHubRequest("/status", "")).toBe(false);

    expect(isCacheableHubRequest("/docs.md/getting-started", "")).toBe(false);

    expect(isCacheableHubRequest("/galaxies/drift/tracks", "")).toBe(false);

    expect(isCacheableHubRequest("//", "")).toBe(false);
  });
});

describe("edgeCachePolicyFor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends release-sensitive fresh and stale windows at the next UTC midnight", () => {
    const before = new Date("2026-10-31T23:59:30.000Z");
    const after = new Date("2026-11-01T00:00:01.000Z");
    for (const path of [
      "/",
      "/tracks",
      "/tracks/",
      "/fresh",
      "/fresh/",
      "/artist/drift",
      "/label/hospital",
    ]) {
      expect(edgeCachePolicyFor(path, "", before)?.storedMaxAge).toBeLessThanOrEqual(30);
      expect(edgeCachePolicyFor(path, "", after)?.storedMaxAge).toBeGreaterThan(30);
    }
    expect(edgeCachePolicyFor("/album/drift", "", before)).toBe(PAGE_CACHE_POLICY);
    expect(releaseBoundFeedCacheControl(before)).toContain("s-maxage=30");
    expect(releaseBoundFeedCacheControl(after)).toBe(PAGE_CACHE_POLICY.cacheControl);
  });

  it("routes each cacheable surface to its policy", () => {
    expect(edgeCachePolicyFor("/log", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/log/2026.A.7Q", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/artist/sub-focus", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/", "")).toBe(HUB_CACHE_POLICY);
    expect(edgeCachePolicyFor("/artists", "")).toBe(HUB_CACHE_POLICY);
    expect(edgeCachePolicyFor("/fresh", "")).toBe(HUB_CACHE_POLICY);

    expect(edgeCachePolicyFor("/artists", "?page=3")).toBe(HUB_CACHE_POLICY);
  });

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

    expect(edgeCachePolicyFor("/sitemap/labels-1.xml", "")).toBe(
      edgeCachePolicyFor("/sitemap/albums-1.xml", ""),
    );
  });

  it("refuses a query variant or a sibling that merely shares the `sitemap` stem", () => {
    expect(edgeCachePolicyFor("/sitemap.xml", "?page=2")).toBeUndefined();
    expect(edgeCachePolicyFor("/sitemap/findings-1.xml", "?utm=x")).toBeUndefined();

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

    expect(edgeCachePolicyFor("/artists", "?page=0")).toBeUndefined();
    expect(edgeCachePolicyFor("/artists", "?page=2&sort=old")).toBeUndefined();
    expect(edgeCachePolicyFor("/tracks", "?galaxy=drift")).toBeUndefined();

    expect(edgeCachePolicyFor("/reach", "?platform=tiktok")).toBeUndefined();
    expect(edgeCachePolicyFor("/galaxies/drift", "?page=2")).toBeUndefined();
  });
});

describe("isPublicHtmlPagePath", () => {
  it("recognizes public HTML pages independently of cache enrolment", () => {
    for (const path of [
      "/",
      "/log",
      "/log/2026.A.7Q",
      "/artist/sub-focus",
      "/artist/sub-focus/",
      "/album/all-that-jazz",
      "/album/all-that-jazz/",
      "/label/hospital-records",
      "/label/hospital-records/",
      "/track/mb_2b1c4d5e",
      "/track/mb_2b1c4d5e/",
      "/artists",
      "/artists/",
      "/docs/api",
    ]) {
      expect(isPublicHtmlPagePath(path), path).toBe(true);
    }
  });

  it("does not classify non-page surfaces or sitemap documents as HTML pages", () => {
    for (const path of [
      "/api/v1/tracks",
      "/_serverFn/abc",
      "/assets/app.js",
      "/rss.xml",
      "/sitemap.xml",
      "/sitemap/findings-1.xml",
      "/artist/sub-focus/tracks",
      "/search",
    ]) {
      expect(isPublicHtmlPagePath(path), path).toBe(false);
    }
  });
});

describe("withEdgeCache", () => {
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

  it("keeps a release-day entry until its stored midnight expiry", async () => {
    const fake = installFakeCache();
    const request = new Request("https://www.fluncle.com/artist/drift");
    const render = vi.fn(async () => html("artist"));
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-20T23:58:00.000Z"));
      await withEdgeCache(
        request,
        render,
        edgeCachePolicyFor("/artist/drift", "") ?? PAGE_CACHE_POLICY,
      );
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(new Date("2026-07-20T23:59:30.000Z"));
      expect(
        (
          await withEdgeCache(
            request,
            render,
            edgeCachePolicyFor("/artist/drift", "") ?? PAGE_CACHE_POLICY,
          )
        ).headers.get("x-edge-cache"),
      ).toBe("fresh");
      expect(render).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
      expect(
        (
          await withEdgeCache(
            request,
            render,
            edgeCachePolicyFor("/artist/drift", "") ?? PAGE_CACHE_POLICY,
          )
        ).headers.get("x-edge-cache"),
      ).toBe("miss");
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(new Date("2026-07-21T00:00:01.000Z"));
      expect(
        (
          await withEdgeCache(
            request,
            render,
            edgeCachePolicyFor("/artist/drift", "") ?? PAGE_CACHE_POLICY,
          )
        ).headers.get("x-edge-cache"),
      ).toBe("fresh");
    } finally {
      fake.restore();
    }
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

      expect(new Set(fake.entries.keys())).toEqual(
        new Set([
          "https://www.fluncle.com/artists",
          "https://www.fluncle.com/artists?page=2",
          "https://www.fluncle.com/artists?page=3",
        ]),
      );

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

      expect(hit.headers.get("Cache-Control")).toBe(HUB_CACHE_POLICY.cacheControl);
      expect(await hit.text()).toBe("hubs");

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
      await withEdgeCache(
        new Request("https://www.fluncle.com/sitemap/findings-9.xml"),
        async () => new Response("Not found", { status: 404 }),
        SITEMAP_CACHE_POLICY,
      );

      await withEdgeCache(
        new Request("https://www.fluncle.com/sitemap/labels-1.xml"),
        async () => html("<html>oops</html>"),
        SITEMAP_CACHE_POLICY,
      );

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

describe("cache purge requests", () => {
  const CANONICAL = "https://www.fluncle.com";

  afterEach(() => {
    delete env.CF_CACHE_PURGE_ZONE_ID;
    delete env.CF_CACHE_PURGE_TOKEN;
    vi.unstubAllGlobals();
    void takeWaitUntilPromises();
  });

  it("sends canonical origin and paths in the global purge body", async () => {
    env.CF_CACHE_PURGE_ZONE_ID = "test-zone";
    env.CF_CACHE_PURGE_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await purgePathsNow(["/log/2026.A.7Q", "/log"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/test-zone/purge_cache");
    expect(JSON.parse(init.body as string)).toEqual({
      files: [`${CANONICAL}/log/2026.A.7Q`, `${CANONICAL}/log`],
    });
  });

  it("purges a finding's encoded page and the log index", async () => {
    env.CF_CACHE_PURGE_ZONE_ID = "test-zone";
    env.CF_CACHE_PURGE_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    purgeLogCache("a b");
    await Promise.all(takeWaitUntilPromises());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      files: [`${CANONICAL}/log/a%20b`, `${CANONICAL}/log`],
    });
  });

  it("does not schedule a purge for a missing or blank coordinate", () => {
    env.CF_CACHE_PURGE_ZONE_ID = "test-zone";
    env.CF_CACHE_PURGE_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const logId of [null, undefined, "", "   "]) {
      purgeLogCache(logId);
    }

    expect(takeWaitUntilPromises()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isCacheableEntityRequest", () => {
  it("matches an artist/album/label/track DETAIL page with no query string", () => {
    expect(isCacheableEntityRequest("/artist/sub-focus", "")).toBe(true);
    expect(isCacheableEntityRequest("/album/all-that-jazz", "")).toBe(true);
    expect(isCacheableEntityRequest("/label/hospital-records", "")).toBe(true);

    expect(isCacheableEntityRequest("/track/mb_2b1c4d5e", "")).toBe(true);
    expect(isCacheableEntityRequest("/track/e2e-track-1", "")).toBe(true);

    expect(isCacheableEntityRequest("/artist/sub-focus/", "")).toBe(false);
    expect(isCacheableEntityRequest("/album/all-that-jazz/", "")).toBe(false);
    expect(isCacheableEntityRequest("/label/hospital-records/", "")).toBe(false);
    expect(isCacheableEntityRequest("/track/mb_2b1c4d5e/", "")).toBe(false);
  });

  it("does NOT cache a paginated/sorted variant (the cache key drops the query)", () => {
    expect(isCacheableEntityRequest("/artist/sub-focus", "?page=2")).toBe(false);
    expect(isCacheableEntityRequest("/label/hospital-records", "?sort=newest")).toBe(false);
  });

  it("does NOT match the plural INDEX pages or a nested/foreign path", () => {
    expect(isCacheableEntityRequest("/artists", "")).toBe(false);
    expect(isCacheableEntityRequest("/albums", "")).toBe(false);
    expect(isCacheableEntityRequest("/labels", "")).toBe(false);
    expect(isCacheableEntityRequest("/artist/sub-focus/tracks", "")).toBe(false);
    expect(isCacheableEntityRequest("/artist", "")).toBe(false);
    expect(isCacheableEntityRequest("/log/2026.A.7Q", "")).toBe(false);

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

    expect(entityPurgeUrl("track", "mb_2b1c4d5e")).toBe(`${CANONICAL}/track/mb_2b1c4d5e`);
  });

  it("every purgeable kind's URL is one the read path would actually cache", () => {
    for (const kind of ["artist", "album", "label", "track"] as const) {
      const path = new URL(entityPurgeUrl(kind, "some-id")).pathname;

      expect(isCacheableEntityRequest(path, ""), `${kind} must be cacheable at ${path}`).toBe(true);
    }
  });

  it("URL-encodes the slug into the path segment", () => {
    expect(entityPurgeUrl("artist", "a b")).toBe(`${CANONICAL}/artist/a%20b`);
  });
});

describe("purge targets match the cached URL shapes", () => {
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

      expect(isCacheableEntityRequest(url.pathname, url.search)).toBe(true);
    }
  });
});

describe("purgeEntityCache / purgeEntityCaches", () => {
  it("is a safe no-op for a missing, blank, or empty target set", () => {
    expect(() => purgeEntityCache("artist", null)).not.toThrow();
    expect(() => purgeEntityCache("album", undefined)).not.toThrow();
    expect(() => purgeEntityCache("label", "  ")).not.toThrow();
    expect(() => purgeEntityCaches([])).not.toThrow();
    expect(() => purgeEntityCaches([{ kind: "artist", slug: "  " }])).not.toThrow();
  });

  it("does not throw for real targets outside the Workers runtime", () => {
    expect(() => purgeEntityCache("artist", "sub-focus")).not.toThrow();
    expect(() =>
      purgeEntityCaches([
        { kind: "artist", slug: "sub-focus" },
        { kind: "label", slug: "hospital-records" },
      ]),
    ).not.toThrow();
  });
});

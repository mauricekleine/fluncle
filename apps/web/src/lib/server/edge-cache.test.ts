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

const release = vi.hoisted(() => ({ id: "current-build" as string | undefined }));

vi.mock("../sentry-config", () => ({
  get SENTRY_RELEASE() {
    return release.id;
  },
}));

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
    expect(SITEMAP_CACHE_POLICY.retainSeconds).toBe(SITEMAP_FRESH_SECONDS + SITEMAP_SWR_SECONDS);
  });

  it("is the one XML tier — the HTML tiers stay HTML", () => {
    expect(SITEMAP_CACHE_POLICY.contentType).toBe("application/xml");
    expect(PAGE_CACHE_POLICY.contentType).toBe("text/html");
    expect(HUB_CACHE_POLICY.contentType).toBe("text/html");
  });

  it("keeps a day-long XML stale window", () => {
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

  it("ends release-sensitive cache windows at the next UTC midnight", () => {
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
      expect(edgeCachePolicyFor(path, "", before)?.retainSeconds).toBeLessThanOrEqual(30);
      expect(edgeCachePolicyFor(path, "", before)?.crawlerFreshSeconds).toBe(30);
      expect(edgeCachePolicyFor(path, "", after)?.retainSeconds).toBeGreaterThan(30);
    }
    expect(edgeCachePolicyFor("/album/drift", "", before)).toBe(PAGE_CACHE_POLICY);
    expect(releaseBoundFeedCacheControl(before)).toContain("s-maxage=30");
    expect(releaseBoundFeedCacheControl(after)).toBe(PAGE_CACHE_POLICY.cacheControl);
  });

  it("caps long retention at midnight even when the browser stale window ends earlier", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    for (const path of ["/", "/tracks", "/fresh", "/artist/drift", "/label/hospital"]) {
      const policy = edgeCachePolicyFor(path, "", now);
      expect(policy?.retainSeconds).toBe(43_200);
      expect(policy?.crawlerFreshSeconds).toBe(
        path.startsWith("/artist/") || path.startsWith("/label/") ? 43_200 : 60,
      );
      expect(policy?.cacheControl).toBe(
        path.startsWith("/artist/") || path.startsWith("/label/")
          ? "public, max-age=0, s-maxage=300, stale-while-revalidate=3600"
          : "public, max-age=0, s-maxage=60, stale-while-revalidate=600",
      );
    }
  });

  it("routes each cacheable surface to its policy", () => {
    expect(edgeCachePolicyFor("/log", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/log/2026.A.7Q", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/artist/sub-focus", "")?.cacheControl).toBe(
      PAGE_CACHE_POLICY.cacheControl,
    );
    expect(edgeCachePolicyFor("/", "")?.cacheControl).toBe(HUB_CACHE_POLICY.cacheControl);
    expect(edgeCachePolicyFor("/artists", "")).toBe(HUB_CACHE_POLICY);
    expect(edgeCachePolicyFor("/fresh", "")?.cacheControl).toBe(HUB_CACHE_POLICY.cacheControl);

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

  beforeEach(() => {
    release.id = "current-build";
    void takeWaitUntilPromises();
  });

  afterEach(async () => {
    await Promise.all(takeWaitUntilPromises());
    vi.useRealTimers();
  });

  describe.each([
    {
      age: 6 * 86_400,
      crawlerStatus: "fresh",
      fresh: 300,
      path: "/track/mb_abc",
      policy: PAGE_CACHE_POLICY,
      retention: 604_800,
      tail: 3_900,
    },
    {
      age: 7_200,
      crawlerStatus: "stale",
      fresh: 60,
      path: "/artists",
      policy: HUB_CACHE_POLICY,
      retention: 86_400,
      tail: 660,
    },
  ])("HTML retention on $path", ({ policy, path, age, retention, fresh, tail, crawlerStatus }) => {
    it.each([
      { body: "stored", headers: new Headers(), status: crawlerStatus },
      { body: "rendered", headers: new Headers({ "sec-fetch-mode": "navigate" }), status: "miss" },
      { body: "rendered", headers: new Headers({ "sec-fetch-dest": "document" }), status: "miss" },
    ])(
      "answers $status beyond the browser stale window for $headers",
      async ({ headers, status, body }) => {
        const fake = installFakeCache();
        const url = `https://www.fluncle.com${path}`;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
        try {
          await withEdgeCache(new Request(url), async () => html("stored"), policy);
          await Promise.all(takeWaitUntilPromises());
          expect(fake.entries.get(url)?.headers.get("cache-control")).toBe(
            `public, s-maxage=${retention}`,
          );
          vi.setSystemTime(Date.now() + age * 1000);
          const render = vi.fn(async () => html("rendered"));
          const response = await withEdgeCache(new Request(url, { headers }), render, policy);
          expect(response.headers.get("x-edge-cache")).toBe(status);
          expect(response.headers.get("cache-control")).toBe(policy.cacheControl);
          expect(await response.text()).toBe(body);
          const tasks = takeWaitUntilPromises();
          expect(tasks).toHaveLength(status === "fresh" ? 0 : 1);
          await Promise.all(tasks);
          expect(render).toHaveBeenCalledTimes(status === "fresh" ? 0 : 1);
          const next = await withEdgeCache(new Request(url, { headers }), render, policy);
          expect(next.headers.get("x-edge-cache")).toBe("fresh");
          expect(await next.text()).toBe(status === "fresh" ? "stored" : "rendered");
        } finally {
          fake.restore();
        }
      },
    );

    it.each([
      { age: 0, body: "stored", renders: 0, status: "fresh" },
      { age: fresh, body: "stored", renders: 1, status: "stale" },
      { age: tail, body: "rendered", renders: 1, status: "miss" },
    ])("a same-build browser gets $status at age $age", async ({ age, status, body, renders }) => {
      const fake = installFakeCache();
      const request = new Request(`https://www.fluncle.com${path}`, {
        headers: new Headers({ "sec-fetch-mode": "navigate" }),
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
      try {
        await withEdgeCache(request, async () => html("stored"), policy);
        await Promise.all(takeWaitUntilPromises());
        vi.setSystemTime(Date.now() + age * 1000);
        const render = vi.fn(async () => html("rendered"));
        const response = await withEdgeCache(request, render, policy);
        expect(response.headers.get("x-edge-cache")).toBe(status);
        expect(await response.text()).toBe(body);
        await Promise.all(takeWaitUntilPromises());
        expect(render).toHaveBeenCalledTimes(renders);
      } finally {
        fake.restore();
      }
    });

    it("misses at the retention deadline even if the Cache API returns the entry", async () => {
      const fake = installFakeCache();
      const request = new Request(`https://www.fluncle.com${path}`);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
      try {
        await withEdgeCache(request, async () => html("stored"), policy);
        await Promise.all(takeWaitUntilPromises());
        vi.setSystemTime(Date.now() + retention * 1000);
        const response = await withEdgeCache(request, async () => html("rendered"), policy);
        expect(response.headers.get("x-edge-cache")).toBe("miss");
        expect(await response.text()).toBe("rendered");
      } finally {
        fake.restore();
      }
    });
  });

  it.each([
    { body: "old-build", headers: new Headers(), status: "fresh" },
    { body: "new-build", headers: new Headers({ "sec-fetch-mode": "navigate" }), status: "miss" },
    { body: "new-build", headers: new Headers({ "sec-fetch-dest": "document" }), status: "miss" },
  ])(
    "answers $status for a different HTML build with $headers",
    async ({ headers, status, body }) => {
      const fake = installFakeCache();
      const url = "https://www.fluncle.com/track/mb_abc";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
      try {
        release.id = "old-build";
        await withEdgeCache(new Request(url), async () => html("old-build"));
        await Promise.all(takeWaitUntilPromises());
        release.id = "new-build";
        vi.setSystemTime(Date.now() + 7_200_000);
        const render = vi.fn(async () => html("new-build"));
        const response = await withEdgeCache(new Request(url, { headers }), render);
        expect(response.headers.get("x-edge-cache")).toBe(status);
        expect(await response.text()).toBe(body);
        expect([...response.headers.keys()].filter((name) => name.startsWith("x-edge-"))).toEqual([
          "x-edge-cache",
        ]);
        const tasks = takeWaitUntilPromises();
        expect(tasks).toHaveLength(status === "fresh" ? 0 : 1);
        await Promise.all(tasks);
        const next = await withEdgeCache(new Request(url, { headers }), render);
        expect(next.headers.get("x-edge-cache")).toBe("fresh");
        expect(await next.text()).toBe(body);
        expect(render).toHaveBeenCalledTimes(status === "fresh" ? 0 : 1);
      } finally {
        fake.restore();
      }
    },
  );

  it.each([
    { body: "legacy", headers: new Headers(), status: "fresh" },
    { body: "current", headers: new Headers({ "sec-fetch-mode": "navigate" }), status: "miss" },
  ])(
    "answers $status for HTML without a build stamp with $headers",
    async ({ headers, status, body }) => {
      const fake = installFakeCache();
      const url = "https://www.fluncle.com/track/mb_abc";
      try {
        await withEdgeCache(new Request(url), async () => html("legacy"));
        await Promise.all(takeWaitUntilPromises());
        fake.entries.get(url)?.headers.delete("x-edge-build-id");
        const response = await withEdgeCache(new Request(url, { headers }), async () =>
          html("current"),
        );
        expect(response.headers.get("x-edge-cache")).toBe(status);
        expect(await response.text()).toBe(body);
      } finally {
        fake.restore();
      }
    },
  );

  it("returns retained stale HTML while a slow refresh is still pending", async () => {
    const fake = installFakeCache();
    const request = new Request("https://www.fluncle.com/artists");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    try {
      await withEdgeCache(request, async () => html("stored"), HUB_CACHE_POLICY);
      await Promise.all(takeWaitUntilPromises());
      vi.setSystemTime(Date.now() + 7_200_000);
      const refresh = Promise.withResolvers<Response>();
      const response = await withEdgeCache(request, () => refresh.promise, HUB_CACHE_POLICY);
      const tasks = takeWaitUntilPromises();
      expect(response.headers.get("x-edge-cache")).toBe("stale");
      expect(await response.text()).toBe("stored");
      expect(tasks).toHaveLength(1);
      refresh.resolve(html("updated"));
      await Promise.all(tasks);
      const next = await withEdgeCache(request, async () => html("unexpected"), HUB_CACHE_POLICY);
      expect(await next.text()).toBe("updated");
    } finally {
      fake.restore();
    }
  });

  it.each([
    { age: 7_200_000, build: "current-build", reason: "past its browser window" },
    { age: 0, build: "new-build", reason: "from another build" },
  ])("keeps crawler reuse when a browser replacement $reason fails", async ({ age, build }) => {
    const fake = installFakeCache();
    const url = "https://www.fluncle.com/track/mb_abc";
    const browser = new Request(url, { headers: { "sec-fetch-mode": "navigate" } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    try {
      await withEdgeCache(new Request(url), async () => html("stored"));
      await Promise.all(takeWaitUntilPromises());
      vi.setSystemTime(Date.now() + age);
      release.id = build;
      const failed = await withEdgeCache(
        browser,
        async () =>
          new Response("unavailable", {
            headers: { "content-type": "text/html" },
            status: 503,
          }),
      );
      expect(failed.status).toBe(503);
      expect(await failed.text()).toBe("unavailable");
      const render = vi.fn(async () => html("recovered"));
      const crawler = await withEdgeCache(new Request(url), render);
      expect(crawler.headers.get("x-edge-cache")).toBe("fresh");
      expect(await crawler.text()).toBe("stored");
      expect(takeWaitUntilPromises()).toHaveLength(0);
      expect(render).not.toHaveBeenCalled();
      const recovered = await withEdgeCache(browser, render);
      expect(recovered.headers.get("x-edge-cache")).toBe("miss");
      expect(await recovered.text()).toBe("recovered");
    } finally {
      fake.restore();
    }
  });

  it("uses a stable development build when the release is undefined", async () => {
    const fake = installFakeCache();
    const request = new Request("https://www.fluncle.com/track/mb_abc", {
      headers: new Headers({ "sec-fetch-mode": "navigate" }),
    });
    try {
      release.id = undefined;
      const render = vi.fn(async () => html("dev"));
      await withEdgeCache(request, render);
      await Promise.all(takeWaitUntilPromises());
      const response = await withEdgeCache(request, render);
      expect(response.headers.get("x-edge-cache")).toBe("fresh");
      expect(render).toHaveBeenCalledOnce();
    } finally {
      fake.restore();
    }
  });

  it.each([new Headers(), new Headers({ "sec-fetch-mode": "navigate" })])(
    "misses a release-sensitive entry from the previous UTC day for %s",
    async (headers) => {
      const fake = installFakeCache();
      const request = new Request("https://www.fluncle.com/artist/drift", { headers });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-20T23:59:00Z"));
      try {
        await withEdgeCache(request, async () => html("yesterday"), PAGE_CACHE_POLICY);
        await Promise.all(takeWaitUntilPromises());
        fake.entries
          .get(request.url)
          ?.headers.set("x-edge-expires-at", String(Date.parse("2026-07-22T00:00:00Z")));
        vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
        const response = await withEdgeCache(
          request,
          async () => html("today"),
          edgeCachePolicyFor("/artist/drift", ""),
        );
        expect(response.headers.get("x-edge-cache")).toBe("miss");
        expect(await response.text()).toBe("today");
      } finally {
        fake.restore();
      }
    },
  );

  it.each(["private", 'private="Set-Cookie"', "public, no-store", "NO-STORE, max-age=0"])(
    "never stores or overrides a render carrying %s",
    async (cacheControl) => {
      const fake = installFakeCache();
      const request = new Request("https://www.fluncle.com/track/mb_abc");
      const render = vi.fn(
        async () =>
          new Response("private", {
            headers: { "cache-control": cacheControl, "content-type": "text/html" },
          }),
      );
      try {
        for (let i = 0; i < 2; i++) {
          const response = await withEdgeCache(request, render);
          expect(response.headers.get("cache-control")).toBe(cacheControl);
          expect(response.headers.get("x-edge-cache")).toBe("miss");
          await Promise.all(takeWaitUntilPromises());
        }
        expect(fake.entries.size).toBe(0);
        expect(render).toHaveBeenCalledTimes(2);
      } finally {
        fake.restore();
      }
    },
  );

  it.each(["private", "no-store"])(
    "evicts a public entry when its background render becomes %s",
    async (cacheControl) => {
      const fake = installFakeCache();
      const request = new Request("https://www.fluncle.com/artists");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
      try {
        await withEdgeCache(request, async () => html("public"), HUB_CACHE_POLICY);
        await Promise.all(takeWaitUntilPromises());
        vi.setSystemTime(Date.now() + 61_000);
        const render = async () =>
          new Response("private", {
            headers: { "cache-control": cacheControl, "content-type": "text/html" },
          });
        const stale = await withEdgeCache(request, render, HUB_CACHE_POLICY);
        expect(stale.headers.get("x-edge-cache")).toBe("stale");
        await Promise.all(takeWaitUntilPromises());
        expect(fake.entries.size).toBe(0);
        const response = await withEdgeCache(request, render, HUB_CACHE_POLICY);
        expect(response.headers.get("x-edge-cache")).toBe("miss");
        expect(response.headers.get("cache-control")).toBe(cacheControl);
      } finally {
        fake.restore();
      }
    },
  );

  it("caps storage retention at midnight after time spent rendering", async () => {
    const fake = installFakeCache();
    const request = new Request("https://www.fluncle.com/artist/drift");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T23:59:30Z"));
    try {
      const policy = edgeCachePolicyFor("/artist/drift", "");
      await withEdgeCache(
        request,
        async () => {
          vi.setSystemTime(new Date("2026-07-20T23:59:40Z"));
          return html("artist");
        },
        policy,
      );
      await Promise.all(takeWaitUntilPromises());
      expect(fake.entries.get(request.url)?.headers.get("cache-control")).toBe(
        "public, s-maxage=20",
      );
      expect(fake.entries.get(request.url)?.headers.get("x-edge-expires-at")).toBe(
        String(Date.parse("2026-07-21T00:00:00Z")),
      );
    } finally {
      fake.restore();
    }
  });

  it("keeps a release-day entry until its stored midnight expiry", async () => {
    const fake = installFakeCache();
    const request = new Request("https://www.fluncle.com/artist/drift");
    const render = vi.fn(async () => html("artist"));
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
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

  it.each(["current-build", "new-build"])(
    "keeps hub crawler freshness at sixty seconds across %s",
    async (build) => {
      const fake = installFakeCache();
      const request = new Request("https://www.fluncle.com/artists");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
      try {
        await withEdgeCache(request, async () => html("stored"), HUB_CACHE_POLICY);
        await Promise.all(takeWaitUntilPromises());
        release.id = build;
        const render = vi.fn(async () => html("updated"));
        vi.setSystemTime(Date.now() + 30_000);
        const fresh = await withEdgeCache(request, render, HUB_CACHE_POLICY);
        expect(fresh.headers.get("x-edge-cache")).toBe("fresh");
        expect(await fresh.text()).toBe("stored");
        expect(takeWaitUntilPromises()).toHaveLength(0);
        expect(render).not.toHaveBeenCalled();

        vi.setSystemTime(Date.now() + 30_000);
        const stale = await withEdgeCache(request, render, HUB_CACHE_POLICY);
        expect(stale.headers.get("x-edge-cache")).toBe("stale");
        expect(await stale.text()).toBe("stored");
        const tasks = takeWaitUntilPromises();
        expect(tasks).toHaveLength(1);
        await Promise.all(tasks);
        expect(render).toHaveBeenCalledOnce();
        const next = await withEdgeCache(request, render, HUB_CACHE_POLICY);
        expect(next.headers.get("x-edge-cache")).toBe("fresh");
        expect(await next.text()).toBe("updated");
      } finally {
        fake.restore();
      }
    },
  );

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

  it("keeps XML freshness and expiry independent of builds and browser navigation", async () => {
    const fake = installFakeCache();
    const request = new Request("https://www.fluncle.com/sitemap.xml", {
      headers: new Headers({ "sec-fetch-mode": "navigate" }),
    });
    const render = vi.fn(
      async () =>
        new Response("<sitemapindex/>", {
          headers: { "content-type": "application/xml; charset=utf-8" },
        }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    try {
      const miss = await withEdgeCache(request, render, SITEMAP_CACHE_POLICY);
      await Promise.all(takeWaitUntilPromises());
      expect(miss.headers.get("x-edge-cache")).toBe("miss");
      expect(miss.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      );
      expect(fake.entries.get(request.url)?.headers.get("cache-control")).toBe(
        "public, s-maxage=90000",
      );
      release.id = "next-build";
      const hit = await withEdgeCache(request, render, SITEMAP_CACHE_POLICY);
      expect(hit.headers.get("x-edge-cache")).toBe("fresh");
      expect(await hit.text()).toBe("<sitemapindex/>");
      expect(render).toHaveBeenCalledOnce();
      vi.setSystemTime(Date.now() + 3_600_000);
      const stale = await withEdgeCache(request, render, SITEMAP_CACHE_POLICY);
      expect(stale.headers.get("x-edge-cache")).toBe("stale");
      expect(stale.headers.get("cache-control")).toBe(SITEMAP_CACHE_POLICY.cacheControl);
      await Promise.all(takeWaitUntilPromises());
      vi.setSystemTime(Date.now() + 90_000_000);
      const expired = await withEdgeCache(request, render, SITEMAP_CACHE_POLICY);
      expect(expired.headers.get("x-edge-cache")).toBe("miss");
      expect(render).toHaveBeenCalledTimes(3);
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

  it("bounds global purges and logs failures without rejecting the caller", async () => {
    vi.useFakeTimers();
    env.CF_CACHE_PURGE_ZONE_ID = "test-zone";
    env.CF_CACHE_PURGE_TOKEN = "test-token";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Promise<Response>(() => {});
      }),
    );

    try {
      const pending = purgePathsNow(["/log/004.7.2I"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toBeUndefined();
      await Promise.all(takeWaitUntilPromises());
      expect(signal?.aborted).toBe(true);
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        expect.objectContaining({
          cause: expect.stringContaining("timeout"),
          event: "edge-cache.purge-error",
        }),
      ]);
    } finally {
      vi.useRealTimers();
      logged.mockRestore();
    }
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

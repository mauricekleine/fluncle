import { beforeEach, describe, expect, it, vi } from "vitest";

// The crawler-facing read surfaces (the feeds, the sitemap, the IndexNow key, and
// the OG image card) must answer with a `Cache-Control` so a repeat poll is served
// by the CDN instead of paying a fresh cross-region Turso read (and, for the card, a
// full WASM raster). This locks the exact header literal per surface — a typo like
// `max-age=8640` would silently under-cache.

// Empty result sets are enough: we assert the header, not the body. `getDb` is async
// and each `db.execute` resolves `{ rows: [] }`; `typedRows` passes rows through.
const getDb = vi.hoisted(() =>
  vi.fn(async () => ({ execute: vi.fn(async () => ({ rows: [] as unknown[] })) })),
);
const getTrackByIdOrLogId = vi.hoisted(() => vi.fn());

vi.mock("../lib/server/db", () => ({
  getDb,
  typedRows: (rows: unknown[]) => rows,
}));
vi.mock("../lib/server/artists", () => ({
  ARTIST_INDEX_MIN_FINDINGS: 3,
  listArtistSitemapRows: vi.fn(async () => []),
  parseArtistsJson: () => [],
}));
vi.mock("../lib/server/galaxies-map", () => ({
  GALAXY_INDEX_MIN_FINDINGS: 3,
  isGalaxyMapFullyNamed: vi.fn(async () => false),
  listPublicGalaxies: vi.fn(async () => []),
}));
vi.mock("../lib/server/tracks", () => ({
  getMixChainDepth: vi.fn(async () => ({ open: false })),
  getTrackByIdOrLogId,
}));
// Raster nothing in the test: a fake ImageResponse just carries the passed headers.
// The fonts are the real bundled bytes from lib/server/satori-render (Vite's
// `?inline` resolves under vitest), so nothing font-side needs mocking.
vi.mock("workers-og", () => ({
  ImageResponse: class {
    headers: Headers;
    constructor(_html: unknown, options: { headers?: HeadersInit }) {
      this.headers = new Headers(options.headers);
    }
  },
}));

type Ctx = { params: Record<string, string>; request: Request };
type Handler = (ctx: Ctx) => Promise<{ headers: { get: (name: string) => string | null } }>;

async function handlerFor(importer: Promise<{ Route: unknown }>): Promise<Handler> {
  const { Route } = await importer;
  const handlers = (Route as { options: { server?: { handlers?: { GET?: Handler } } } }).options
    .server?.handlers;
  if (!handlers?.GET) {
    throw new Error("route has no GET handler");
  }
  return handlers.GET;
}

const ctx: Ctx = {
  params: { logId: "020.F.1A" },
  request: new Request("https://www.fluncle.com/"),
};

const FEED_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

describe("Cache-Control on the crawler-facing surfaces", () => {
  beforeEach(() => {
    getTrackByIdOrLogId.mockReset();
  });

  it.each([
    ["rss.xml", () => import("./rss[.]xml"), FEED_CACHE],
    ["atom.xml", () => import("./atom[.]xml"), FEED_CACHE],
    ["feed.json", () => import("./feed[.]json"), FEED_CACHE],
    [
      "sitemap.xml",
      () => import("./sitemap[.]xml"),
      "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
    ],
    ["indexnow key", () => import("./8337c1b41068549f248bf56f1fc465df[.]txt"), FEED_CACHE],
  ])("%s answers with its exact Cache-Control", async (_name, importer, expected) => {
    const handler = await handlerFor(importer());
    const res = await handler(ctx);

    expect(res.headers.get("Cache-Control")).toBe(expected);
  });

  it("the OG image card answers with the long, non-immutable Cache-Control", async () => {
    getTrackByIdOrLogId.mockResolvedValue({
      addedAt: "2026-06-18T00:00:00.000Z",
      artists: ["Fluncle"],
      logId: "020.F.1A",
      title: "A Finding",
    });
    const handler = await handlerFor(import("./api/og.$logId"));
    const res = await handler(ctx);

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
    );
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
  });
});

// The SSR HTML surfaces are the other half of the cache-header contract. They do not
// answer from a route handler — `server.ts` wraps them in `withEdgeCache`, which stamps
// the directive from the policy `edgeCachePolicyFor` picked. So the literal to lock here
// is the policy's, plus the routing decision that says which pages get which one. The
// behaviour behind them (store/serve/stale/never-store) is proven in
// `lib/server/edge-cache.test.ts`.
describe("Cache-Control on the edge-cached HTML surfaces", () => {
  it("the detail pages carry the short-fresh, hour-tailed directive", async () => {
    const { PAGE_CACHE_POLICY, edgeCachePolicyFor } = await import("../lib/server/edge-cache");

    expect(PAGE_CACHE_POLICY.cacheControl).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    );
    // Not a day: the document references build-scoped `/assets/<hash>.js`, so a stale tail
    // longer than the deploy cadence serves HTML whose chunks are already 404s.
    expect(PAGE_CACHE_POLICY.cacheControl).not.toContain("86400");
    expect(edgeCachePolicyFor("/log/2026.A.7Q", "")).toBe(PAGE_CACHE_POLICY);
    expect(edgeCachePolicyFor("/artist/sub-focus", "")).toBe(PAGE_CACHE_POLICY);
  });

  it("the hub, index, static, legal and docs pages carry the minute-fresh directive", async () => {
    const { HUB_CACHE_POLICY, edgeCachePolicyFor } = await import("../lib/server/edge-cache");

    expect(HUB_CACHE_POLICY.cacheControl).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=600",
    );

    for (const path of [
      // The paginated catalogue hubs.
      "/",
      "/artists",
      "/albums",
      "/labels",
      "/tracks",
      "/fresh",
      // The stable public pages enrolled at the hub policy (previously emitted no directive).
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

    // A lone ?page=N on a paginated hub is the same policy (its key folds the page).
    expect(edgeCachePolicyFor("/artists", "?page=3")).toBe(HUB_CACHE_POLICY);
  });

  it("no directive is minted for a query variant or a private surface", async () => {
    const { edgeCachePolicyFor } = await import("../lib/server/edge-cache");

    // The cache key drops the query, so a non-lone-page variant must never be shared-cached.
    expect(edgeCachePolicyFor("/artists", "?page=2&sort=old")).toBeUndefined();
    expect(edgeCachePolicyFor("/artists", "?page=0")).toBeUndefined();
    expect(edgeCachePolicyFor("/tracks", "?galaxy=drift")).toBeUndefined();
    // Any query on a bare-URL-only page (a `?platform=` on /reach, a `?page=` on a galaxy).
    expect(edgeCachePolicyFor("/reach", "?platform=tiktok")).toBeUndefined();
    expect(edgeCachePolicyFor("/galaxies/drift", "?page=2")).toBeUndefined();
    // Nor an account/admin/interactive/live surface.
    expect(edgeCachePolicyFor("/account", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/admin/tracks", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/status", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/galaxy", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/mix", "")).toBeUndefined();
  });
});

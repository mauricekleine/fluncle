import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() =>
  vi.fn(async () => ({ execute: vi.fn(async () => ({ rows: [] as unknown[] })) })),
);
const getTrackByIdOrLogId = vi.hoisted(() => vi.fn());

vi.mock("../lib/server/db", () => ({
  getDb,
  typedRow: (rows: unknown[]) => rows[0],
  typedRows: (rows: unknown[]) => rows,
}));
vi.mock("../lib/server/artists", () => ({
  ARTIST_INDEX_MIN_FINDINGS: 3,
  countIndexableArtists: vi.fn(async () => 0),
  listArtistSitemapRows: vi.fn(async () => []),
  maxArtistSitemapLastmod: vi.fn(async () => undefined),
  parseArtistsJson: () => [],
}));
vi.mock("../lib/server/galaxies-map", () => ({
  GALAXY_INDEX_MIN_FINDINGS: 3,
  countPublicIndexableGalaxies: vi.fn(async () => 0),
  isGalaxyMapFullyNamed: vi.fn(async () => false),
  listPublicGalaxies: vi.fn(async () => []),
}));
vi.mock("../lib/server/tracks", () => ({
  getMixChainDepth: vi.fn(async () => ({ open: false })),
  getTrackByIdOrLogId,
}));

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

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
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
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

  it("the hub OG card answers with the long, non-immutable Cache-Control", async () => {
    const handler = await handlerFor(import("./api/og.hub"));
    const res = await handler({
      params: {},
      request: new Request("https://www.fluncle.com/api/og/hub?hub=artists"),
    });

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
    );
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
  });
});

describe("Cache-Control on the edge-cached HTML surfaces", () => {
  it("the detail pages carry the short-fresh, hour-tailed directive", async () => {
    const { PAGE_CACHE_POLICY, edgeCachePolicyFor } = await import("../lib/server/edge-cache");

    expect(PAGE_CACHE_POLICY.cacheControl).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    );

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
      "/artists",
      "/albums",
      "/labels",
      "/tracks",
      "/fresh",

      "/",
      "/findings",
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

    expect(edgeCachePolicyFor("/artists", "?page=3")).toBe(HUB_CACHE_POLICY);
  });

  it("no directive is minted for a query variant or a private surface", async () => {
    const { edgeCachePolicyFor } = await import("../lib/server/edge-cache");

    expect(edgeCachePolicyFor("/artists", "?page=2&sort=old")).toBeUndefined();
    expect(edgeCachePolicyFor("/artists", "?page=0")).toBeUndefined();
    expect(edgeCachePolicyFor("/tracks", "?galaxy=drift")).toBeUndefined();

    expect(edgeCachePolicyFor("/reach", "?platform=tiktok")).toBeUndefined();
    expect(edgeCachePolicyFor("/galaxies/drift", "?page=2")).toBeUndefined();

    expect(edgeCachePolicyFor("/account", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/admin/tracks", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/status", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/galaxy", "")).toBeUndefined();
    expect(edgeCachePolicyFor("/mix", "")).toBeUndefined();
  });
});

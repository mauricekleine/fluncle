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
vi.mock("../lib/server/tracks", () => ({ getTrackByIdOrLogId }));
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

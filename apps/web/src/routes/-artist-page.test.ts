import { beforeEach, describe, expect, it, vi } from "vitest";

// The artist page's indexability gate: `noindex` (and sitemap absence) must key
// off the CANONICAL `track_artists`-join count (`countArtistFindings`) — the same
// source the sitemap + `/artists` index use — NOT the fallback-inclusive grid
// count. Otherwise a pre-backfill artist whose findings live only in the
// `artists_json` cache renders an indexable page while being absent from the
// sitemap + index (an orphaned indexable page). These tests pin that contract.

const getArtistBySlug = vi.hoisted(() => vi.fn());
const getPublicArtistSocials = vi.hoisted(() => vi.fn());
const countArtistFindings = vi.hoisted(() => vi.fn());
const getFindingsByArtist = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artists")>()),
  countArtistFindings,
  getArtistBySlug,
  getPublicArtistSocials,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByArtist,
}));

const { Route, resolveArtistPageData } = await import("./artist.$slug");

const ARTIST = {
  id: "artist-drift",
  mbid: undefined,
  name: "Drift",
  slug: "drift",
  spotifyUrl: undefined,
  wikidataQid: undefined,
};

// A minimal grid finding — only the fields the resolver passes through matter.
function finding(logId: string) {
  return { artists: ["Drift"], logId, title: "Untitled", trackId: `t-${logId}` };
}

function robotsMeta(data: unknown): string | undefined {
  const head = Route.options.head?.({ loaderData: data } as never) as
    | { meta?: Array<{ content?: string; name?: string }> }
    | undefined;

  return head?.meta?.find((entry) => entry.name === "robots")?.content;
}

describe("resolveArtistPageData (the artist page indexability gate)", () => {
  beforeEach(() => {
    getArtistBySlug.mockReset();
    getPublicArtistSocials.mockReset();
    countArtistFindings.mockReset();
    getFindingsByArtist.mockReset();
    getPublicArtistSocials.mockResolvedValue([]);
    getArtistBySlug.mockResolvedValue(ARTIST);
  });

  it("noindexes a page whose findings are only in artists_json (matching its sitemap absence)", async () => {
    // The grid shows three covers via the artists_json fallback …
    getFindingsByArtist.mockResolvedValue([
      finding("001.1.1A"),
      finding("002.1.1A"),
      finding("003.1.1A"),
    ]);
    // … but the canonical track_artists join has none yet (pre-backfill), so the
    // page is below the threshold — noindex + out of the sitemap.
    countArtistFindings.mockResolvedValue(0);

    const data = await resolveArtistPageData("drift");

    expect(data.status).toBe("found");
    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    // The grid still displays the fallback findings (completeness) …
    expect(data.findings).toHaveLength(3);
    // … but indexability keys off the canonical join count, so the page is noindex.
    expect(data.indexable).toBe(false);
    expect(robotsMeta(data)).toBe("noindex, follow");
  });

  it("indexes a page once the canonical join count clears the threshold", async () => {
    getFindingsByArtist.mockResolvedValue([
      finding("001.1.1A"),
      finding("002.1.1A"),
      finding("003.1.1A"),
    ]);
    countArtistFindings.mockResolvedValue(3);

    const data = await resolveArtistPageData("drift");

    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.indexable).toBe(true);
    // Past the gate: no robots override, so the page is indexable.
    expect(robotsMeta(data)).toBeUndefined();
  });

  it("reports a missing artist without touching the finding counts", async () => {
    getArtistBySlug.mockResolvedValue(undefined);

    const data = await resolveArtistPageData("nobody");

    expect(data).toEqual({ status: "missing" });
    expect(getFindingsByArtist).not.toHaveBeenCalled();
    expect(countArtistFindings).not.toHaveBeenCalled();
  });
});

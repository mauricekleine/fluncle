import { beforeEach, describe, expect, it, vi } from "vitest";

// The artist page's two findings gates, both keyed off the CANONICAL `track_artists`-join count
// (`countArtistFindings`) — the same source the sitemap + `/artists` index use:
//
//   1. EXISTENCE (slice 003, TEMPORARY until slice 004): a findings-free artist — a row that
//      carries NO certified finding through the canonical join — 404s, even though a row exists.
//      Slice 003 mints crawl-only `artists` rows off the Spotify anchor, so this gate is what keeps
//      them off the public surface (consistent with their sitemap/index absence). `grep
//      artistHasCertifiedFindingSql`.
//   2. INDEXABILITY: a page that DOES exist is `noindex` (and out of the sitemap) below
//      ARTIST_INDEX_MIN_FINDINGS, again by the canonical count, so it is never an orphaned
//      indexable page.
//
// Both key off the same count as the sitemap + index, so page reachability, indexability and
// sitemap membership never disagree. These tests pin that contract.

const getArtistBySlug = vi.hoisted(() => vi.fn());
const getPublicArtistSocials = vi.hoisted(() => vi.fn());
const countArtistFindings = vi.hoisted(() => vi.fn());
const getFindingsByArtist = vi.hoisted(() => vi.fn());
const getArtistNeighbours = vi.hoisted(() => vi.fn());
const listArtistCatalogue = vi.hoisted(() => vi.fn());

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

// The grouped catalogue read is DB-backed; stub it so the resolver stays a pure unit (its
// grouping + bounds are covered by catalogue-groups.test.ts and the scale integration test).
vi.mock("@/lib/server/catalogue-groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/catalogue-groups")>()),
  listArtistCatalogue,
}));

/** The empty grouped catalogue — an artist the crawler has not touched. */
const NO_CATALOGUE = { groups: [], page: 1, pageCount: 1, totalGroups: 0, totalTracks: 0 };

// The dossier's neighbours are DB-backed; stub them so the resolver stays a pure
// unit (the ranking itself is covered by artist-dossier.test.ts).
vi.mock("@/lib/server/artist-dossier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artist-dossier")>()),
  getArtistNeighbours,
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
// `addedAt`/`bpm`/`key` feed the dossier signature; a bare finding leaves them
// undefined, which the signature degrades cleanly on.
function finding(logId: string, extra: { addedAt?: string; bpm?: number; key?: string } = {}) {
  return { artists: ["Drift"], logId, title: "Untitled", trackId: `t-${logId}`, ...extra };
}

function headMeta(data: unknown): Array<{ content?: string; name?: string; property?: string }> {
  const head = Route.options.head?.({ loaderData: data } as never) as
    | { meta?: Array<{ content?: string; name?: string; property?: string }> }
    | undefined;

  return head?.meta ?? [];
}

function robotsMeta(data: unknown): string | undefined {
  return headMeta(data).find((entry) => entry.name === "robots")?.content;
}

/** The `<meta name="description">` — the same string og:/twitter: description carry. */
function metaDescription(data: unknown): string | undefined {
  return headMeta(data).find((entry) => entry.name === "description")?.content;
}

describe("resolveArtistPageData (the artist page indexability gate)", () => {
  beforeEach(() => {
    getArtistBySlug.mockReset();
    getPublicArtistSocials.mockReset();
    countArtistFindings.mockReset();
    getFindingsByArtist.mockReset();
    getArtistNeighbours.mockReset();
    listArtistCatalogue.mockReset();
    getPublicArtistSocials.mockResolvedValue([]);
    getArtistNeighbours.mockResolvedValue([]);
    listArtistCatalogue.mockResolvedValue(NO_CATALOGUE);
    getArtistBySlug.mockResolvedValue(ARTIST);
  });

  it("404s a findings-free artist — a crawl-minted row with no certified finding", async () => {
    // The artist ROW exists (slice 003 minted it off a crawled track's Spotify anchor) …
    getArtistBySlug.mockResolvedValue(ARTIST);
    getFindingsByArtist.mockResolvedValue([]);
    // … but the canonical track_artists→findings join has none, so the artist is not public until
    // slice 004: the page 404s exactly as when no row existed, matching its sitemap/index absence.
    countArtistFindings.mockResolvedValue(0);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toEqual({ status: "missing" });
  });

  it("still 404s a zero-canonical-count artist even when the artists_json grid has covers", async () => {
    // The completeness fallback (`getFindingsByArtist` reads `artists_json`) could show covers, but
    // the EXISTENCE gate keys off the canonical count alone — so a page absent from the sitemap +
    // index is never a reachable orphan. It 404s, it does not render noindex.
    getFindingsByArtist.mockResolvedValue([
      finding("001.1.1A"),
      finding("002.1.1A"),
      finding("003.1.1A"),
    ]);
    countArtistFindings.mockResolvedValue(0);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toEqual({ status: "missing" });
  });

  it("renders (noindex) an artist with one or two certified findings, below the index threshold", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A"), finding("002.1.1A")]);
    // Two certified findings: past the EXISTENCE gate (row is public), below the INDEX threshold.
    countArtistFindings.mockResolvedValue(2);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data.status).toBe("found");
    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.findings).toHaveLength(2);
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

    const data = await resolveArtistPageData("drift", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.indexable).toBe(true);
    // Past the gate: no robots override, so the page is indexable.
    expect(robotsMeta(data)).toBeUndefined();
  });

  it("reports a missing artist without touching the finding counts", async () => {
    getArtistBySlug.mockResolvedValue(undefined);

    const data = await resolveArtistPageData("nobody", "name", 1);

    expect(data).toEqual({ status: "missing" });
    expect(getFindingsByArtist).not.toHaveBeenCalled();
    expect(countArtistFindings).not.toHaveBeenCalled();
    expect(getArtistNeighbours).not.toHaveBeenCalled();
  });

  it("assembles the dossier (signature + neighbours) from the findings", async () => {
    getFindingsByArtist.mockResolvedValue([
      finding("003.1.1A", { addedAt: "2026-03-10T00:00:00.000Z" }),
      finding("002.1.1A", { addedAt: "2026-02-01T00:00:00.000Z" }),
      finding("001.1.1A", { addedAt: "2026-01-05T00:00:00.000Z" }),
    ]);
    countArtistFindings.mockResolvedValue(3);
    getArtistNeighbours.mockResolvedValue([
      { imageUrl: "https://i.scdn.co/image/echo", name: "Echo", slug: "echo" },
    ]);

    const data = await resolveArtistPageData("drift", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.dossier.findingCount).toBe(3);
    // The earliest finding is when the artist first crossed his path.
    expect(data.dossier.firstFoundAt).toBe("2026-01-05T00:00:00.000Z");
    // The similar-artists row carries each neighbour's identity + avatar.
    expect(data.dossier.neighbours).toEqual([
      { imageUrl: "https://i.scdn.co/image/echo", name: "Echo", slug: "echo" },
    ]);
  });

  it("carries the artist's bio into the page data when the record has one, undefined otherwise", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    getArtistBySlug.mockResolvedValue({ ...ARTIST, bio: "Drift makes rollers for the deep end." });
    const withBio = await resolveArtistPageData("drift", "name", 1);
    if (withBio.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(withBio.bio).toBe("Drift makes rollers for the deep end.");

    getArtistBySlug.mockResolvedValue(ARTIST);
    const withoutBio = await resolveArtistPageData("drift", "name", 1);
    if (withoutBio.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(withoutBio.bio).toBeUndefined();
  });

  it("derives a ≤160-char meta description from the bio, and the template when there is none", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    // A bio over the meta cap: the description is bio-derived, trimmed to ≤160, and drops the
    // catalogue-count template entirely (the whole point — a unique description per entity).
    const bio =
      "Drift is a British drum and bass producer known for deep, rolling liquid cuts and a run " +
      "of releases across the scene's most respected labels over the past decade of the sound.";
    getArtistBySlug.mockResolvedValue({ ...ARTIST, bio });
    const withBio = await resolveArtistPageData("drift", "name", 1);

    const desc = metaDescription(withBio);
    expect(desc).toBeDefined();
    expect((desc ?? "").length).toBeLessThanOrEqual(160);
    expect(desc).not.toContain("each with a coordinate");
    expect(desc?.startsWith("Drift is a British drum and bass producer")).toBe(true);

    // No bio ⇒ the original template is preserved verbatim (no regression).
    getArtistBySlug.mockResolvedValue(ARTIST);
    const withoutBio = await resolveArtistPageData("drift", "name", 1);
    expect(metaDescription(withoutBio)).toBe(
      "Every Drift banger Fluncle has found and logged in the Galaxy, 1 so far, each with a coordinate.",
    );
  });
});

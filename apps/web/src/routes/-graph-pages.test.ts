import { beforeEach, describe, expect, it, vi } from "vitest";

// The graph pages' thin-content gate (`/label/<slug>` + `/album/<slug>`), pinned as a pure
// unit — the `-artist-page.test.ts` precedent.
//
// The contract: `noindex` (and sitemap absence) keys off the RENDERABLE track count — the
// findings PLUS the quieter uncertified rows, because both are real content on the page.
// The sitemap route filters on exactly the same sum (findingCount + catalogueCount), so a
// page that declares itself indexable is always in the sitemap and one that declares
// `noindex` never is. An indexable page that the sitemap orphans is the bug these pin.
//
// The second contract, and the one that matters more: a page with ZERO quieter rows renders
// them as NOTHING — no heading, no empty state, no dangling anything. That is the state of
// every page today (the archive is entirely certified), and it is asserted here.

const getLabelBySlug = vi.hoisted(() => vi.fn());
const getLabelForAlbum = vi.hoisted(() => vi.fn());
const getAlbumBySlug = vi.hoisted(() => vi.fn());
const listArtistsByLabel = vi.hoisted(() => vi.fn());
const listArtistsByAlbum = vi.hoisted(() => vi.fn());
const getFindingsByLabel = vi.hoisted(() => vi.fn());
const getFindingsByAlbum = vi.hoisted(() => vi.fn());
const listCatalogueTracksByLabel = vi.hoisted(() => vi.fn());
const listCatalogueTracksByAlbum = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/labels")>()),
  getLabelBySlug,
  getLabelForAlbum,
}));

vi.mock("@/lib/server/albums", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/albums")>()),
  getAlbumBySlug,
}));

vi.mock("@/lib/server/artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artists")>()),
  listArtistsByAlbum,
  listArtistsByLabel,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByAlbum,
  getFindingsByLabel,
  listCatalogueTracksByAlbum,
  listCatalogueTracksByLabel,
}));

const { resolveLabelPageData } = await import("./label.$slug");
const { resolveAlbumPageData } = await import("./album.$slug");

const LABEL = { id: "lbl_1", name: "Hospital Records", slug: "hospital-records" };
const ALBUM = { id: "alb_1", name: "Wormhole", slug: "wormhole" };

/** N coordinate-bearing findings, in the shape the page reads. */
function findings(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    addedAt: `2026-07-0${index + 1}T00:00:00.000Z`,
    albumImageUrl: undefined,
    artists: ["Nu:Tone"],
    logId: `001.1.${index}A`,
    title: `Tune ${index}`,
    trackId: `t${index}`,
  }));
}

/**
 * A slice of uncertified rows — no logId, ever. `total` is the entity's TRUE count, which the
 * SQL counts and the gate keys off; `rendered` is how many the page actually got (capped at
 * `GRAPH_PAGE_CATALOGUE_LIMIT`). They are the same number until an imprint gets crowded, and
 * the whole point of the pair is that they may then differ.
 */
function catalogue(total: number, rendered = total) {
  return {
    total,
    tracks: Array.from({ length: rendered }, (_value, index) => ({
      albumImageUrl: undefined,
      artists: ["Nu:Tone"],
      spotifyUrl: "https://open.spotify.com/track/x",
      title: `Deep cut ${index}`,
      trackId: `c${index}`,
    })),
  };
}

const NO_CATALOGUE = { total: 0, tracks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getLabelBySlug.mockResolvedValue(LABEL);
  getAlbumBySlug.mockResolvedValue(ALBUM);
  getLabelForAlbum.mockResolvedValue(LABEL);
  listArtistsByLabel.mockResolvedValue([]);
  listArtistsByAlbum.mockResolvedValue([]);
  getFindingsByLabel.mockResolvedValue([]);
  getFindingsByAlbum.mockResolvedValue([]);
  listCatalogueTracksByLabel.mockResolvedValue(NO_CATALOGUE);
  listCatalogueTracksByAlbum.mockResolvedValue(NO_CATALOGUE);
});

describe("the label page", () => {
  it("404s on a slug with no label entity", async () => {
    getLabelBySlug.mockResolvedValue(undefined);

    expect(await resolveLabelPageData("nope")).toEqual({ status: "missing" });
  });

  it("stays out of the index below the renderable-track floor", async () => {
    getFindingsByLabel.mockResolvedValue(findings(2));

    const data = await resolveLabelPageData("hospital-records");

    expect(data).toMatchObject({ indexable: false, status: "found" });
  });

  it("404s a label with no findings, however many crawled rows hang off it", async () => {
    // The catalogue DEEPENS a page, it never CREATES one. A label the crawler discovered has
    // a `labels` row (that row IS the ruling queue) and can carry hundreds of crawled tracks —
    // and no page, because Fluncle has never certified a thing on it. Without this, a wide
    // crawl publishes one indexable doorway page per discovered imprint.
    getFindingsByLabel.mockResolvedValue([]);
    listCatalogueTracksByLabel.mockResolvedValue(catalogue(400, 100));

    expect(await resolveLabelPageData("metalheadz")).toEqual({ status: "missing" });
  });

  it("gates on the entity's TRUE catalogue total, never the rendered slice", async () => {
    // A 3,000-row imprint and a 100-row one must not read as the same page to the gate.
    getFindingsByLabel.mockResolvedValue(findings(1));
    listCatalogueTracksByLabel.mockResolvedValue(catalogue(3000, 100));

    const data = await resolveLabelPageData("hospital-records");

    expect(data).toMatchObject({ indexable: true });
    // ...and the PAGE only ever carries the slice — the markup, the hydration payload and the
    // JSON-LD are all bounded by this one array.
    expect(data.status === "found" && data.catalogue).toHaveLength(100);
  });

  it("indexes at the floor, on findings alone", async () => {
    getFindingsByLabel.mockResolvedValue(findings(3));

    expect(await resolveLabelPageData("hospital-records")).toMatchObject({ indexable: true });
  });

  it("counts the quieter rows toward the floor (they are content on the page)", async () => {
    getFindingsByLabel.mockResolvedValue(findings(1));
    listCatalogueTracksByLabel.mockResolvedValue(catalogue(2));

    expect(await resolveLabelPageData("hospital-records")).toMatchObject({ indexable: true });
  });

  it("renders an EMPTY quieter section today (the catalogue is empty)", async () => {
    getFindingsByLabel.mockResolvedValue(findings(5));

    const data = await resolveLabelPageData("hospital-records");

    // Empty, not absent-and-headed: the component returns nothing for an empty list, so
    // there is no dangling heading to leave behind.
    expect(data).toMatchObject({ catalogue: [], indexable: true });
  });
});

describe("the album page", () => {
  it("404s on a slug with no album entity", async () => {
    getAlbumBySlug.mockResolvedValue(undefined);

    expect(await resolveAlbumPageData("nope")).toEqual({ status: "missing" });
  });

  it("404s an album with no findings — the same rule the label page carries", async () => {
    getFindingsByAlbum.mockResolvedValue([]);
    listCatalogueTracksByAlbum.mockResolvedValue(catalogue(12));

    expect(await resolveAlbumPageData("wormhole")).toEqual({ status: "missing" });
  });

  it("stays out of the index below the renderable-track floor", async () => {
    getFindingsByAlbum.mockResolvedValue(findings(1));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ indexable: false });
  });

  it("counts the quieter rows toward the floor — a one-finding record with a tracklist indexes", async () => {
    getFindingsByAlbum.mockResolvedValue(findings(1));
    listCatalogueTracksByAlbum.mockResolvedValue(catalogue(9));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ indexable: true });
  });

  it("carries the album → label edge that closes the graph", async () => {
    getFindingsByAlbum.mockResolvedValue(findings(3));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ label: LABEL });
  });

  it("degrades to no label edge when no track on the record carries one", async () => {
    getLabelForAlbum.mockResolvedValue(undefined);
    getFindingsByAlbum.mockResolvedValue(findings(3));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ label: undefined });
  });
});

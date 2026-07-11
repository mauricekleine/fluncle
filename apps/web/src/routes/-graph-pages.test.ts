import { beforeEach, describe, expect, it, vi } from "vitest";

// The graph pages' thin-content gate (`/label/<slug>` + `/album/<slug>`), pinned as a pure
// unit — the `-artist-page.test.ts` precedent.
//
// The contract: `noindex` (and sitemap absence) keys off the RENDERABLE track count — the
// findings PLUS the quieter uncertified rows, because both are real content on the page. The
// sitemap route filters on exactly the same sum (findingCount + catalogueCount), so a page that
// declares itself indexable is always in the sitemap and one that declares `noindex` never is.
// An indexable page that the sitemap orphans is the bug these pin.
//
// The label's quieter rows are now GROUPED (by artist), so its catalogue read returns a
// `CatalogueGroupPage` and the gate keys off that page's SQL-counted `totalTracks` — the
// entity's TRUE uncertified total, never the rendered page. The album's rows are a flat
// tracklist still (an album is one record), so it keeps the `{ total, tracks }` slice.
//
// The second contract, and the one that matters more: a page with ZERO quieter rows renders
// them as NOTHING — no heading, no empty state, no dangling anything. That is the state of every
// page today (the archive is entirely certified), and it is asserted here.

const getLabelBySlug = vi.hoisted(() => vi.fn());
const getLabelForAlbum = vi.hoisted(() => vi.fn());
const getAlbumBySlug = vi.hoisted(() => vi.fn());
const listArtistsByLabel = vi.hoisted(() => vi.fn());
const listArtistsByAlbum = vi.hoisted(() => vi.fn());
const getFindingsByLabel = vi.hoisted(() => vi.fn());
const getFindingsByAlbum = vi.hoisted(() => vi.fn());
const listLabelCatalogue = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/server/catalogue-groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/catalogue-groups")>()),
  listLabelCatalogue,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByAlbum,
  getFindingsByLabel,
  listCatalogueTracksByAlbum,
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
 * A LABEL's grouped catalogue page. `totalTracks` is the entity's TRUE uncertified total (the SQL
 * counts it and the gate keys off it); `rendered` is how many tracks this one page carries after
 * the grouping's bound. They are the same until a label gets crowded, and the whole point of the
 * pair is that they may then differ — the gate must never key off the rendered page.
 */
function labelCatalogue(totalTracks: number, rendered = totalTracks) {
  return {
    groups:
      rendered > 0
        ? [
            {
              name: "Nu:Tone",
              recordCount: 1,
              records: [
                {
                  name: "Deep cuts",
                  releaseDate: undefined,
                  slug: undefined,
                  tracks: Array.from({ length: rendered }, (_value, index) => ({
                    artists: ["Nu:Tone"],
                    spotifyUrl: "https://open.spotify.com/track/x",
                    title: `Deep cut ${index}`,
                    trackId: `c${index}`,
                  })),
                },
              ],
              slug: undefined,
              truncated: totalTracks > rendered,
            },
          ]
        : [],
    page: 1,
    pageCount: 1,
    totalGroups: rendered > 0 ? 1 : 0,
    totalTracks,
  };
}

/** An ALBUM's flat tracklist slice — no logId, ever. `total` is the entity's TRUE count. */
function albumCatalogue(total: number, rendered = total) {
  return {
    total,
    tracks: Array.from({ length: rendered }, (_value, index) => ({
      artists: ["Nu:Tone"],
      spotifyUrl: "https://open.spotify.com/track/x",
      title: `Deep cut ${index}`,
      trackId: `c${index}`,
    })),
  };
}

const NO_LABEL_CATALOGUE = labelCatalogue(0);
const NO_ALBUM_CATALOGUE = { total: 0, tracks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getLabelBySlug.mockResolvedValue(LABEL);
  getAlbumBySlug.mockResolvedValue(ALBUM);
  getLabelForAlbum.mockResolvedValue(LABEL);
  listArtistsByLabel.mockResolvedValue([]);
  listArtistsByAlbum.mockResolvedValue([]);
  getFindingsByLabel.mockResolvedValue([]);
  getFindingsByAlbum.mockResolvedValue([]);
  listLabelCatalogue.mockResolvedValue(NO_LABEL_CATALOGUE);
  listCatalogueTracksByAlbum.mockResolvedValue(NO_ALBUM_CATALOGUE);
});

describe("the label page", () => {
  it("404s on a slug with no label entity", async () => {
    getLabelBySlug.mockResolvedValue(undefined);

    expect(await resolveLabelPageData("nope", "name", 1)).toEqual({ status: "missing" });
  });

  it("stays out of the index below the renderable-track floor", async () => {
    getFindingsByLabel.mockResolvedValue(findings(2));

    const data = await resolveLabelPageData("hospital-records", "name", 1);

    expect(data).toMatchObject({ indexable: false, status: "found" });
  });

  it("SERVES a label with no findings — a discography is a page", async () => {
    // THE REVERSAL. A label the crawler discovered carries a `labels` row (that row IS the
    // operator's ruling queue) and can carry hundreds of crawled releases. That is a real,
    // useful page — an honest record of what the label put out — and it indexes. It used to 404
    // on the rule "the catalogue deepens a page, it never creates one".
    //
    // What made the old page a DOORWAY was never its existence; it was the HOLLOW RENDERING —
    // a "Nothing logged off this one yet." heading over a wall of Spotify outlinks. Conditional
    // sections fix that at the source: no findings, no findings section, no apology.
    getFindingsByLabel.mockResolvedValue([]);
    listLabelCatalogue.mockResolvedValue(labelCatalogue(400, 100));

    const data = await resolveLabelPageData("metalheadz", "name", 1);

    expect(data).toMatchObject({ indexable: true, status: "found" });
    // Nothing reaches the findings band, so nothing renders there.
    expect(data.status === "found" && data.findings).toEqual([]);
  });

  it("keeps a 2-row discovered label OUT of the index (thin is still thin)", async () => {
    // The floor does the job the 404 rule overreached at. Two crawled rows and nothing else is a
    // stub: it still serves 200 (deep links, link equity), it is just `noindex, follow` and
    // absent from the sitemap. This is the case the operator drew the line at.
    getFindingsByLabel.mockResolvedValue([]);
    listLabelCatalogue.mockResolvedValue(labelCatalogue(2));

    expect(await resolveLabelPageData("two-row-label", "name", 1)).toMatchObject({
      indexable: false,
      status: "found",
    });
  });

  it("gates on the entity's TRUE catalogue total, never the rendered page", async () => {
    // A 3,000-row label and a 100-row one must not read as the same page to the gate — so the
    // gate keys off `totalTracks` (SQL-counted over the whole label), while the PAGE only ever
    // carries one bounded group page.
    getFindingsByLabel.mockResolvedValue(findings(1));
    listLabelCatalogue.mockResolvedValue(labelCatalogue(3000, 100));

    const data = await resolveLabelPageData("hospital-records", "name", 1);

    expect(data).toMatchObject({ indexable: true });
    expect(data.status === "found" && data.catalogue.totalTracks).toBe(3000);
  });

  it("indexes at the floor, on findings alone", async () => {
    getFindingsByLabel.mockResolvedValue(findings(3));

    expect(await resolveLabelPageData("hospital-records", "name", 1)).toMatchObject({
      indexable: true,
    });
  });

  it("counts the quieter rows toward the floor (they are content on the page)", async () => {
    getFindingsByLabel.mockResolvedValue(findings(1));
    listLabelCatalogue.mockResolvedValue(labelCatalogue(2));

    expect(await resolveLabelPageData("hospital-records", "name", 1)).toMatchObject({
      indexable: true,
    });
  });

  it("renders an EMPTY quieter section today (the catalogue is empty)", async () => {
    getFindingsByLabel.mockResolvedValue(findings(5));

    const data = await resolveLabelPageData("hospital-records", "name", 1);

    // Empty, not absent-and-headed: no groups, so the band renders nothing at all.
    expect(data.status === "found" && data.catalogue.groups).toEqual([]);
    expect(data).toMatchObject({ indexable: true });
  });

  it("404s on a page past the end of the pager (never a duplicate of page 1)", async () => {
    const { CataloguePageOutOfRangeError } = await import("@/lib/server/catalogue-groups");
    listLabelCatalogue.mockRejectedValue(new CataloguePageOutOfRangeError());

    expect(await resolveLabelPageData("hospital-records", "name", 99)).toEqual({
      status: "missing",
    });
  });
});

describe("the album page", () => {
  it("404s on a slug with no album entity", async () => {
    getAlbumBySlug.mockResolvedValue(undefined);

    expect(await resolveAlbumPageData("nope")).toEqual({ status: "missing" });
  });

  it("SERVES an album with no findings — the same rule the label page carries", async () => {
    // A tracklist is a page. Unreachable today (an `albums` row is minted only off a certified
    // finding), but the two graph pages hold the same rule so neither drifts when the crawler's
    // write paths widen.
    getFindingsByAlbum.mockResolvedValue([]);
    listCatalogueTracksByAlbum.mockResolvedValue(albumCatalogue(12));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({
      findings: [],
      indexable: true,
      status: "found",
    });
  });

  it("stays out of the index below the renderable-track floor", async () => {
    getFindingsByAlbum.mockResolvedValue(findings(1));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ indexable: false });
  });

  it("counts the quieter rows toward the floor — a one-finding record with a tracklist indexes", async () => {
    getFindingsByAlbum.mockResolvedValue(findings(1));
    listCatalogueTracksByAlbum.mockResolvedValue(albumCatalogue(9));

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

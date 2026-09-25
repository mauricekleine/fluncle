import { beforeEach, describe, expect, it, vi } from "vitest";

const getLabelBySlug = vi.hoisted(() => vi.fn());
const getLabelForAlbum = vi.hoisted(() => vi.fn());

const getConfirmedAliasNames = vi.hoisted(() => vi.fn(async () => []));

const resolveLabelAliasRedirect = vi.hoisted(() => vi.fn(async () => undefined));
const getAlbumBySlug = vi.hoisted(() => vi.fn());
const listArtistsByLabel = vi.hoisted(() => vi.fn());
const listArtistsByAlbum = vi.hoisted(() => vi.fn());
const getFindingsByLabel = vi.hoisted(() => vi.fn());
const getFindingsByAlbum = vi.hoisted(() => vi.fn());
const listLabelCatalogue = vi.hoisted(() => vi.fn());
const listLabelUpcoming = vi.hoisted(() => vi.fn());
const listCatalogueTracksByAlbum = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/labels")>()),
  getConfirmedAliasNames,
  getLabelBySlug,
  getLabelForAlbum,
  resolveLabelAliasRedirect,
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
  listLabelUpcoming,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByAlbum,
  getFindingsByLabel,
  listCatalogueTracksByAlbum,
}));

const { Route: LabelRoute } = await import("./label.$slug");

const { resolveLabelPageData } = await import("./-label-page-data");
const { resolveAlbumPageData } = await import("./-album-page-data");

function labelMetaDescription(data: unknown): string | undefined {
  const head = LabelRoute.options.head?.({ loaderData: data } as never) as
    | { meta?: Array<{ content?: string; name?: string }> }
    | undefined;

  return head?.meta?.find((entry) => entry.name === "description")?.content;
}

function labelHeadTitle(data: unknown): string | undefined {
  const head = LabelRoute.options.head?.({ loaderData: data } as never) as
    | { meta?: Array<{ title?: string }> }
    | undefined;

  return head?.meta?.find((entry) => entry.title !== undefined)?.title;
}

const LABEL = {
  id: "lbl_1",
  name: "Hospital Records",
  renderableTrackCount: 0,
  slug: "hospital-records",
};
const ALBUM = { id: "alb_1", name: "Wormhole", slug: "wormhole" };

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
  listLabelUpcoming.mockResolvedValue({
    findings: [],
    page: 1,
    pageCount: 1,
    total: 0,
    tracks: [],
  });
  listCatalogueTracksByAlbum.mockResolvedValue(NO_ALBUM_CATALOGUE);
});

describe("the label page", () => {
  it("passes upcoming rows into their own page block", async () => {
    listLabelUpcoming.mockResolvedValue({
      findings: [],
      page: 1,
      pageCount: 1,
      total: 1,
      tracks: [{ artists: ["Nu:Tone"], title: "Next", trackId: "future" }],
    });
    const data = await resolveLabelPageData("hospital-records", "name", 1);
    expect(
      data.status === "found" ? data.upcoming.tracks.map((track) => track.trackId) : [],
    ).toEqual(["future"]);
  });

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
    getFindingsByLabel.mockResolvedValue([]);
    getLabelBySlug.mockResolvedValue({ ...LABEL, renderableTrackCount: 400 });
    listLabelCatalogue.mockResolvedValue(labelCatalogue(400, 100));

    const data = await resolveLabelPageData("metalheadz", "name", 1);

    expect(data).toMatchObject({ indexable: true, status: "found" });

    expect(data.status === "found" && data.findings).toEqual([]);
  });

  it("keeps a 2-row discovered label OUT of the index (thin is still thin)", async () => {
    getFindingsByLabel.mockResolvedValue([]);
    listLabelCatalogue.mockResolvedValue(labelCatalogue(2));

    expect(await resolveLabelPageData("two-row-label", "name", 1)).toMatchObject({
      indexable: false,
      status: "found",
    });
  });

  it("gates on the entity's full count, never the rendered page slice", async () => {
    getLabelBySlug.mockResolvedValue({ ...LABEL, renderableTrackCount: 3001 });
    getFindingsByLabel.mockResolvedValue(findings(1));
    listLabelCatalogue.mockResolvedValue(labelCatalogue(3000, 100));

    const data = await resolveLabelPageData("hospital-records", "name", 1);

    expect(data).toMatchObject({ indexable: true });
    expect(data.status === "found" && data.catalogue.totalTracks).toBe(3000);
  });

  it("indexes at the floor, on findings alone", async () => {
    getLabelBySlug.mockResolvedValue({ ...LABEL, renderableTrackCount: 3 });
    getFindingsByLabel.mockResolvedValue(findings(3));

    expect(await resolveLabelPageData("hospital-records", "name", 1)).toMatchObject({
      indexable: true,
    });
  });

  it("carries the label's bio into the page data when the record has one, undefined otherwise", async () => {
    getFindingsByLabel.mockResolvedValue(findings(1));

    getLabelBySlug.mockResolvedValue({ ...LABEL, bio: "London's liquid drum and bass home." });
    const withBio = await resolveLabelPageData("hospital-records", "name", 1);
    expect(withBio.status === "found" && withBio.bio).toBe("London's liquid drum and bass home.");

    getLabelBySlug.mockResolvedValue(LABEL);
    const withoutBio = await resolveLabelPageData("hospital-records", "name", 1);
    expect(withoutBio.status === "found" && withoutBio.bio).toBeUndefined();
  });

  it("derives a ≤160-char meta description from the bio, and the template when there is none", async () => {
    getFindingsByLabel.mockResolvedValue(findings(1));

    const bio =
      "Hospital Records is a British drum and bass label founded in 1996 by London Elektricity, " +
      "long the definitive home of liquid and soulful drum and bass across a deep back catalogue.";
    getLabelBySlug.mockResolvedValue({ ...LABEL, bio });
    const withBio = await resolveLabelPageData("hospital-records", "name", 1);

    const desc = labelMetaDescription(withBio);
    expect(desc).toBeDefined();
    expect((desc ?? "").length).toBeLessThanOrEqual(160);
    expect(desc).not.toContain("each with a coordinate");
    expect(desc?.startsWith("Hospital Records is a British drum and bass label")).toBe(true);

    getLabelBySlug.mockResolvedValue(LABEL);
    const withoutBio = await resolveLabelPageData("hospital-records", "name", 1);
    expect(labelMetaDescription(withoutBio)).toBe(
      "Drum & bass tracks on Hospital Records that Fluncle recommends, 1 so far, with the artists behind them.",
    );
  });

  it("counts the quieter rows toward the floor (they are content on the page)", async () => {
    getLabelBySlug.mockResolvedValue({ ...LABEL, renderableTrackCount: 3 });
    getFindingsByLabel.mockResolvedValue(findings(1));
    listLabelCatalogue.mockResolvedValue(labelCatalogue(2));

    expect(await resolveLabelPageData("hospital-records", "name", 1)).toMatchObject({
      indexable: true,
    });
  });

  it("renders an EMPTY quieter section today (the catalogue is empty)", async () => {
    getLabelBySlug.mockResolvedValue({ ...LABEL, renderableTrackCount: 5 });
    getFindingsByLabel.mockResolvedValue(findings(5));

    const data = await resolveLabelPageData("hospital-records", "name", 1);

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

  it("varies BOTH the title and the description by page (the /labels hub rule)", async () => {
    const bio =
      "Hospital Records is a British drum and bass label founded in 1996 by London Elektricity.";
    getLabelBySlug.mockResolvedValue({ ...LABEL, bio });
    getFindingsByLabel.mockResolvedValue(findings(1));
    listLabelCatalogue.mockResolvedValue({ ...labelCatalogue(4), page: 3, pageCount: 5 });

    const paged = await resolveLabelPageData("hospital-records", "name", 3);

    expect(labelHeadTitle(paged)).toBe("Hospital Records, page 3 · Fluncle");
    expect(labelMetaDescription(paged)).toBe(
      "Page 3 of the drum & bass artists released on Hospital Records that Fluncle holds.",
    );

    listLabelCatalogue.mockResolvedValue(labelCatalogue(4));
    const first = await resolveLabelPageData("hospital-records", "name", 1);

    expect(labelHeadTitle(first)).toBe("Hospital Records · Fluncle");
    expect(labelMetaDescription(first)?.startsWith("Hospital Records is a British")).toBe(true);
  });
});

describe("the album page", () => {
  it("404s on a slug with no album entity", async () => {
    getAlbumBySlug.mockResolvedValue(undefined);

    expect(await resolveAlbumPageData("nope")).toEqual({ status: "missing" });
  });

  it("SERVES a findings-free album — a discography is a page (the album twin of the label reversal)", async () => {
    getFindingsByAlbum.mockResolvedValue([]);
    listCatalogueTracksByAlbum.mockResolvedValue(albumCatalogue(12));

    const data = await resolveAlbumPageData("wormhole");

    expect(data).toMatchObject({ indexable: true, status: "found" });

    expect(data.status === "found" && data.findings).toEqual([]);
  });

  it("keeps a 1-row findings-free album OUT of the index (thin is still thin)", async () => {
    getFindingsByAlbum.mockResolvedValue([]);
    listCatalogueTracksByAlbum.mockResolvedValue(albumCatalogue(1));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({
      indexable: false,
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

  it("carries the catalogue number through to the page when the record has one", async () => {
    getAlbumBySlug.mockResolvedValue({ ...ALBUM, discogsCatno: "RAMM123" });
    getFindingsByAlbum.mockResolvedValue(findings(3));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ catalogNumber: "RAMM123" });
  });

  it("carries no catalogue number until the Discogs facts sweep has ruled on the record", async () => {
    getFindingsByAlbum.mockResolvedValue(findings(3));

    expect(await resolveAlbumPageData("wormhole")).toMatchObject({ catalogNumber: undefined });
  });
});

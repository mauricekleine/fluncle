import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolCtx, type ToolDef } from "./registry";

// Slice F's browse tools exercised through the registry handler layer: the `list_*` A–Z index reads
// and the paginated `list_*_catalogue` reads. Their server reads are partial-mocked (the rest of
// each module stays real, so registry.ts's other imports resolve) so the executes run hermetically.

const listArtistsBrowsePageMock = vi.hoisted(() => vi.fn());
const getArtistBySlugMock = vi.hoisted(() => vi.fn());
const listAlbumsBrowsePageMock = vi.hoisted(() => vi.fn());
const getAlbumBySlugMock = vi.hoisted(() => vi.fn());
const listLabelsBrowsePageMock = vi.hoisted(() => vi.fn());
const getLabelBySlugMock = vi.hoisted(() => vi.fn());
const listArtistCatalogueMock = vi.hoisted(() => vi.fn());
const listLabelCatalogueMock = vi.hoisted(() => vi.fn());
const listCatalogueTracksByAlbumMock = vi.hoisted(() => vi.fn());

vi.mock("../artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../artists")>()),
  getArtistBySlug: getArtistBySlugMock,
  listArtistsBrowsePage: listArtistsBrowsePageMock,
  toArtistSlug: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
}));
vi.mock("../albums", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../albums")>()),
  albumSlug: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  getAlbumBySlug: getAlbumBySlugMock,
  listAlbumsBrowsePage: listAlbumsBrowsePageMock,
}));
vi.mock("../labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../labels")>()),
  getLabelBySlug: getLabelBySlugMock,
  labelSlug: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  listLabelsBrowsePage: listLabelsBrowsePageMock,
}));
vi.mock("../catalogue-groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../catalogue-groups")>()),
  listArtistCatalogue: listArtistCatalogueMock,
  listLabelCatalogue: listLabelCatalogueMock,
}));
vi.mock("../tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tracks")>()),
  listCatalogueTracksByAlbum: listCatalogueTracksByAlbumMock,
}));

const { SHARED_TOOLS } = await import("./registry");

const MCP: ToolCtx = { transport: "mcp" };
const CHAT: ToolCtx = { transport: "chat" };

function tool(name: string): ToolDef {
  const def = SHARED_TOOLS.find((candidate) => candidate.name === name);

  if (!def) {
    throw new Error(`tool ${name} missing`);
  }

  return def;
}

/** One catalogue track row (the anti-join read's item shape). */
function catTrack(id: string) {
  return {
    artists: [`Artist ${id}`],
    spotifyUrl: `https://sp/${id}`,
    title: `Track ${id}`,
    trackId: id,
  };
}

beforeEach(() => {
  for (const m of [
    listArtistsBrowsePageMock,
    getArtistBySlugMock,
    listAlbumsBrowsePageMock,
    getAlbumBySlugMock,
    listLabelsBrowsePageMock,
    getLabelBySlugMock,
    listArtistCatalogueMock,
    listLabelCatalogueMock,
    listCatalogueTracksByAlbumMock,
  ]) {
    m.mockReset();
  }
});

describe("list_artists / list_albums / list_labels — the A–Z browse index", () => {
  it("passes the page through and world-serves the index rows with certified flags", async () => {
    listArtistsBrowsePageMock.mockResolvedValue({
      items: [
        { certified: true, name: "Aktive", slug: "aktive", trackCount: 9 },
        { certified: false, name: "Bou", slug: "bou", trackCount: 4 },
      ],
      page: 3,
      pageCount: 12,
      total: 570,
    });

    const result = (await tool("list_artists").execute({ page: 3 }, MCP)) as {
      items: unknown[];
      ok: boolean;
      page: number;
      pageCount: number;
      total: number;
    };

    expect(listArtistsBrowsePageMock).toHaveBeenCalledWith(3);
    expect(result).toEqual({
      items: [
        { certified: true, name: "Aktive", slug: "aktive", trackCount: 9 },
        { certified: false, name: "Bou", slug: "bou", trackCount: 4 },
      ],
      ok: true,
      page: 3,
      pageCount: 12,
      total: 570,
    });
  });

  it("defaults a missing/invalid page to 1 and serves chat the same shape", async () => {
    listLabelsBrowsePageMock.mockResolvedValue({
      items: [{ certified: false, name: "Sofa Sound", slug: "sofa-sound", trackCount: 3 }],
      page: 1,
      pageCount: 4,
      total: 160,
    });

    const result = (await tool("list_labels").execute({ page: 0 }, CHAT)) as { page: number };

    expect(listLabelsBrowsePageMock).toHaveBeenCalledWith(1);
    expect(result.page).toBe(1);
  });

  it("pages albums — page N reaches the Nth slice", async () => {
    listAlbumsBrowsePageMock.mockImplementation((page: number) =>
      Promise.resolve({
        items: [{ certified: false, name: `Album p${page}`, slug: `a${page}`, trackCount: 5 }],
        page,
        pageCount: 9,
        total: 430,
      }),
    );

    const first = (await tool("list_albums").execute({ page: 1 }, MCP)) as {
      items: { name: string }[];
    };
    const second = (await tool("list_albums").execute({ page: 2 }, MCP)) as {
      items: { name: string }[];
    };

    expect(first.items[0]?.name).toBe("Album p1");
    expect(second.items[0]?.name).toBe("Album p2");
  });
});

describe("list_artist_catalogue — pagination over the grouped read", () => {
  it("passes page to the grouped read and returns the whole flattened group page", async () => {
    getArtistBySlugMock.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
    // A group page whose flattened rows exceed the old 24-row cap — all must survive.
    const tracks = Array.from({ length: 30 }, (_, i) => catTrack(`t${i}`));
    listArtistCatalogueMock.mockResolvedValue({
      groups: [{ name: "A Record", releaseDate: undefined, slug: "a-record", tracks }],
      page: 2,
      pageCount: 5,
      totalGroups: 60,
      totalTracks: 900,
    });

    const result = (await tool("list_artist_catalogue").execute(
      { name: "Netsky", page: 2 },
      MCP,
    )) as {
      catalogue: unknown[];
      page: number;
      pageCount: number;
      total: number;
    };

    expect(listArtistCatalogueMock).toHaveBeenCalledWith("art-1", "name", 2);
    expect(result.catalogue).toHaveLength(30); // NOT truncated to 24 — the fix
    expect(result).toMatchObject({ page: 2, pageCount: 5, total: 900 });
  });

  it("an unresolved name is the honest empty, never an error", async () => {
    getArtistBySlugMock.mockResolvedValue(undefined);

    const result = (await tool("list_artist_catalogue").execute({ name: "Nobody" }, MCP)) as {
      catalogue: unknown[];
      ok: boolean;
    };

    expect(listArtistCatalogueMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ catalogue: [], ok: true });
  });
});

describe("list_label_catalogue — pagination over the grouped read", () => {
  it("a page past the end is the honest empty page, not a thrown error", async () => {
    const { CataloguePageOutOfRangeError } = await import("../catalogue-groups");
    getLabelBySlugMock.mockResolvedValue({ id: "lbl-1", name: "Hospital", slug: "hospital" });
    listLabelCatalogueMock.mockRejectedValue(new CataloguePageOutOfRangeError());

    const result = (await tool("list_label_catalogue").execute(
      { name: "Hospital", page: 99 },
      MCP,
    )) as {
      catalogue: unknown[];
      ok: boolean;
    };

    expect(result).toMatchObject({ catalogue: [], ok: true });
  });
});

describe("list_album_catalogue — pagination over the bounded flat read", () => {
  it("slices the album's tracks by page so rows past the first page are reachable", async () => {
    getAlbumBySlugMock.mockResolvedValue({ id: "alb-1", name: "Colours", slug: "colours" });
    const tracks = Array.from({ length: 50 }, (_, i) => catTrack(`c${i}`));
    listCatalogueTracksByAlbumMock.mockResolvedValue({ total: 50, tracks });

    const first = (await tool("list_album_catalogue").execute(
      { name: "Colours", page: 1 },
      MCP,
    )) as {
      catalogue: { title: string }[];
      pageCount: number;
      total: number;
    };
    const second = (await tool("list_album_catalogue").execute(
      { name: "Colours", page: 2 },
      MCP,
    )) as {
      catalogue: { title: string }[];
    };

    expect(first.catalogue).toHaveLength(24);
    expect(first.catalogue[0]?.title).toBe("Track c0");
    expect(first).toMatchObject({ pageCount: 3, total: 50 }); // ceil(50/24) = 3
    expect(second.catalogue[0]?.title).toBe("Track c24"); // the second page starts past row 24
  });
});

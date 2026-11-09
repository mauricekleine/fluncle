import { beforeEach, describe, expect, it, vi } from "vitest";
import { get, readJson, warmOrpcRouter } from "./orpc-test-kit";

const getAlbumDetail = vi.fn();
const listAlbumsApiPage = vi.fn();
const getLabelDetail = vi.fn();
const listLabelsApiPage = vi.fn();
const getArtistListItemBySlug = vi.fn();
const listArtistsApiPage = vi.fn();

vi.mock("./albums", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./albums")>()),
  getAlbumDetail: (...args: unknown[]) => getAlbumDetail(...args),
  listAlbumsApiPage: (...args: unknown[]) => listAlbumsApiPage(...args),
}));

vi.mock("./labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./labels")>()),
  getLabelDetail: (...args: unknown[]) => getLabelDetail(...args),
  listLabelsApiPage: (...args: unknown[]) => listLabelsApiPage(...args),
}));

vi.mock("./artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artists")>()),
  getArtistListItemBySlug: (...args: unknown[]) => getArtistListItemBySlug(...args),
  listArtistsApiPage: (...args: unknown[]) => listArtistsApiPage(...args),
}));

const getEditionByNumber = vi.fn();
const getPublicGalaxyBySlug = vi.fn();
const getGraphPreview = vi.fn();

vi.mock("./editions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./editions")>()),
  getEditionByNumber: (...args: unknown[]) => getEditionByNumber(...args),
}));

vi.mock("./galaxies-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./galaxies-map")>()),
  getPublicGalaxyBySlug: (...args: unknown[]) => getPublicGalaxyBySlug(...args),
}));

vi.mock("./graph-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph-preview")>()),
  getGraphPreview: (...args: unknown[]) => getGraphPreview(...args),
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => ({ execute: async () => ({ rows: [] }) }),
}));

warmOrpcRouter();

const EMPTY_PAGE = { items: [], page: 1, pageCount: 1, total: 0 };

const ENTITY = {
  certified: true,
  findingCount: 3,
  name: "Hospital Records",
  slug: "a",
  trackCount: 40,
};

beforeEach(() => {
  for (const mock of [
    getAlbumDetail,
    listAlbumsApiPage,
    getLabelDetail,
    listLabelsApiPage,
    getArtistListItemBySlug,
    listArtistsApiPage,
    getEditionByNumber,
    getPublicGalaxyBySlug,
    getGraphPreview,
  ]) {
    mock.mockReset();
  }
});

const DETAIL_CASES = [
  { envelopeKey: "album", kind: "album", lookup: getAlbumDetail, path: "albums" },
  { envelopeKey: "label", kind: "label", lookup: getLabelDetail, path: "labels" },
  { envelopeKey: "artist", kind: "artist", lookup: getArtistListItemBySlug, path: "artists" },
] as const;

describe.each(DETAIL_CASES)(
  "oRPC public read — GET /$path/{slug}",
  ({ envelopeKey, kind, lookup, path }) => {
    it("serves the entity in the { ok: true } envelope, looked up by the path slug", async () => {
      const entity = { ...ENTITY, slug: "hospital-records" };
      lookup.mockResolvedValueOnce(entity);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        get(`https://www.fluncle.com/api/v1/${path}/hospital-records`),
      );

      expect(response?.status).toBe(200);
      expect(await readJson(response)).toEqual({ [envelopeKey]: entity, ok: true });
      expect(lookup).toHaveBeenCalledWith("hospital-records");
    });

    it("404s an unknown slug with the not_found envelope naming the slug", async () => {
      lookup.mockResolvedValueOnce(undefined);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(get(`https://www.fluncle.com/api/v1/${path}/nope`));

      expect(response?.status).toBe(404);
      expect(await readJson(response)).toEqual({
        code: "not_found",
        message: `No ${kind} with slug "nope"`,
        ok: false,
      });
    });

    it("500s an unexpected fault generically — the raw detail never reaches the wire", async () => {
      lookup.mockRejectedValueOnce(new Error("turso fell over"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        get(`https://www.fluncle.com/api/v1/${path}/hospital-records`),
      );

      expect(response?.status).toBe(500);
      const body = await readJson(response);
      expect(body).toEqual({ code: "error", message: "Internal error", ok: false });
      expect(JSON.stringify(body)).not.toContain("turso fell over");
      errSpy.mockRestore();
    });
  },
);

const LIST_CASES = [
  { envelopeKey: "albums", list: listAlbumsApiPage, path: "albums" },
  { envelopeKey: "labels", list: listLabelsApiPage, path: "labels" },
  { envelopeKey: "artists", list: listArtistsApiPage, path: "artists" },
] as const;

describe.each(LIST_CASES)("oRPC public read — GET /$path", ({ envelopeKey, list, path }) => {
  it("serves the page envelope with its paging fields", async () => {
    list.mockResolvedValueOnce({ items: [ENTITY], page: 2, pageCount: 3, total: 120 });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`https://www.fluncle.com/api/v1/${path}?page=2`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      [envelopeKey]: [ENTITY],
      ok: true,
      page: 2,
      pageCount: 3,
      total: 120,
    });
    expect(list).toHaveBeenCalledWith(2);
  });

  it.each(["abc", "0", "-3", "1.5"])("degrades page=%s to page 1 (never 400s)", async (page) => {
    list.mockResolvedValueOnce(EMPTY_PAGE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      get(`https://www.fluncle.com/api/v1/${path}?page=${encodeURIComponent(page)}`),
    );

    expect(response?.status).toBe(200);
    expect(list).toHaveBeenCalledWith(1);
  });
});

describe("oRPC public read — GET /newsletter/editions/{number} (get_edition)", () => {
  it.each(["0", "-1", "abc"])(
    "404s a non-positive or non-numeric number (%s) without a lookup",
    async (number) => {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        get(`https://www.fluncle.com/api/v1/newsletter/editions/${number}`),
      );

      expect(response?.status).toBe(404);
      expect(await readJson(response)).toEqual({
        code: "edition_not_found",
        message: "Edition not found",
        ok: false,
      });
      expect(getEditionByNumber).not.toHaveBeenCalled();
    },
  );

  it("404s an edition number that does not exist", async () => {
    getEditionByNumber.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/newsletter/editions/7"));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "edition_not_found",
      message: "Edition not found",
      ok: false,
    });
    expect(getEditionByNumber).toHaveBeenCalledWith(7);
  });

  it("500s an unexpected fault generically", async () => {
    getEditionByNumber.mockRejectedValueOnce(new Error("turso fell over"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/newsletter/editions/7"));

    expect(response?.status).toBe(500);
    expect(await readJson(response)).toEqual({
      code: "error",
      message: "Internal error",
      ok: false,
    });
    errSpy.mockRestore();
  });
});

describe("oRPC public read — GET /galaxies/{slug} (get_galaxy)", () => {
  it("404s an unknown galaxy with the not_found envelope", async () => {
    const { GalaxyNotFoundError } = await import("./galaxies-map");
    getPublicGalaxyBySlug.mockRejectedValueOnce(
      new GalaxyNotFoundError('No galaxy with slug "nope"'),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/galaxies/nope"));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "not_found",
      message: 'No galaxy with slug "nope"',
      ok: false,
    });
  });

  it.each([
    { expected: [24, 0], query: "" },
    { expected: [10, 48], query: "?limit=10&offset=48" },
    { expected: [100, 0], query: "?limit=5000&offset=-4" },
    { expected: [24, 0], query: "?limit=0&offset=abc" },
  ])("pages the findings with limit/offset parsed from '$query'", async ({ expected, query }) => {
    const { GalaxyNotFoundError } = await import("./galaxies-map");
    getPublicGalaxyBySlug.mockRejectedValueOnce(new GalaxyNotFoundError("stop"));

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get(`https://www.fluncle.com/api/v1/galaxies/deep-space${query}`));

    expect(getPublicGalaxyBySlug).toHaveBeenCalledWith("deep-space", ...expected);
  });

  it("500s an unexpected fault generically", async () => {
    getPublicGalaxyBySlug.mockRejectedValueOnce(new Error("turso fell over"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/galaxies/deep-space"));

    expect(response?.status).toBe(500);
    expect(await readJson(response)).toEqual({
      code: "error",
      message: "Internal error",
      ok: false,
    });
    errSpy.mockRestore();
  });
});

describe("oRPC public read — GET /graph/{kind}/{slug} (get_graph_preview)", () => {
  it("404s an unknown entity with the not_found envelope", async () => {
    const { GraphEntityNotFoundError } = await import("./graph-preview");
    getGraphPreview.mockRejectedValueOnce(
      new GraphEntityNotFoundError('No label with slug "nope"'),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/graph/label/nope"));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "not_found",
      message: 'No label with slug "nope"',
      ok: false,
    });
    expect(getGraphPreview).toHaveBeenCalledWith("label", "nope");
  });

  it("rejects a kind outside the graph entity set before any lookup", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/graph/track/nope"));

    expect(response?.status).toBe(400);
    expect(getGraphPreview).not.toHaveBeenCalled();
  });

  it("500s an unexpected fault generically", async () => {
    getGraphPreview.mockRejectedValueOnce(new Error("turso fell over"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/graph/artist/someone"));

    expect(response?.status).toBe(500);
    expect(await readJson(response)).toEqual({
      code: "error",
      message: "Internal error",
      ok: false,
    });
    errSpy.mockRestore();
  });
});

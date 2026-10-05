import { beforeEach, describe, expect, it, vi } from "vitest";
import { albumPageTitle, artistPageTitle, labelPageTitle } from "@/lib/page-meta";

const getPublicArtistBySlug = vi.hoisted(() => vi.fn());
const getLabelBySlug = vi.hoisted(() => vi.fn());
const getAlbumBySlug = vi.hoisted(() => vi.fn());
const hasPublicGraphTracks = vi.hoisted(() => vi.fn(async () => true));
const getFindingsByArtist = vi.hoisted(() => vi.fn(async () => []));
const getFindingsByLabel = vi.hoisted(() => vi.fn(async () => []));
const getFindingsByAlbum = vi.hoisted(() => vi.fn());
const listCatalogueTracksByAlbum = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artists")>()),
  getPublicArtistBySlug,
}));

vi.mock("@/lib/server/labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/labels")>()),
  getLabelBySlug,
}));

vi.mock("@/lib/server/albums", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/albums")>()),
  getAlbumBySlug,
}));

vi.mock("@/lib/server/hub-counts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/hub-counts")>()),
  hasPublicGraphTracks,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByAlbum,
  getFindingsByArtist,
  getFindingsByLabel,
  listCatalogueTracksByAlbum,
}));

const { Route } = await import("./oembed");

async function oembedTitle(path: string): Promise<string> {
  const handlers = Route.options.server?.handlers as
    | { GET: (ctx: { request: Request }) => Promise<Response> }
    | undefined;

  if (!handlers) {
    throw new Error("oembed route has no GET handler");
  }

  const url = `https://www.fluncle.com/oembed?url=${encodeURIComponent(`https://www.fluncle.com${path}`)}`;
  const response = await handlers.GET({ request: new Request(url) });
  const payload = (await response.json()) as { title: string };

  return payload.title;
}

function track(artists: string[]) {
  return { albumImageUrl: undefined, artists, title: "Tune" };
}

describe("oEmbed titles match the page titles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("titles an artist embed like the artist page", async () => {
    getPublicArtistBySlug.mockResolvedValue({ id: "a1", imageUrl: undefined, name: "Grimesy" });

    expect(await oembedTitle("/artist/grimesy")).toBe(artistPageTitle("Grimesy"));
  });

  it("titles a label embed like the label page", async () => {
    getLabelBySlug.mockResolvedValue({
      id: "l1",
      logoImageUrl: undefined,
      name: "Freak Recordings",
    });

    expect(await oembedTitle("/label/freak-recordings")).toBe(labelPageTitle("Freak Recordings"));
  });

  it("credits the album artist only when the whole tracklist shares them", async () => {
    getAlbumBySlug.mockResolvedValue({ id: "r1", name: "Big Ting EP", releaseDate: "2026-03-01" });
    getFindingsByAlbum.mockResolvedValue([track(["Seba"])]);
    listCatalogueTracksByAlbum.mockResolvedValue({ total: 1, tracks: [track(["Seba"])] });

    expect(await oembedTitle("/album/big-ting-ep")).toBe(
      albumPageTitle({ artist: "Seba", name: "Big Ting EP", releaseDate: "2026-03-01" }),
    );

    listCatalogueTracksByAlbum.mockResolvedValue({ total: 2, tracks: [track(["Seba"])] });

    expect(await oembedTitle("/album/big-ting-ep")).toBe(
      albumPageTitle({ artist: undefined, name: "Big Ting EP", releaseDate: "2026-03-01" }),
    );
  });
});

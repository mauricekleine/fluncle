import { beforeEach, describe, expect, it, vi } from "vitest";

// The hub OG card's two contracts: the `?hub=` param is validated BEFORE any DB read
// (an unknown or absent hub is a plain 404 — no count query, no WASM raster), and a
// valid hub renders exactly its own count read, mirrored into the page's masthead line.

const countIndexableAlbums = vi.hoisted(() => vi.fn(async () => 0));
const countIndexableArtists = vi.hoisted(() => vi.fn(async () => 0));
const countIndexableLabels = vi.hoisted(() => vi.fn(async () => 0));
const countAllTracks = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("@/lib/server/albums", () => ({ countIndexableAlbums }));
vi.mock("@/lib/server/artists", () => ({ countIndexableArtists }));
vi.mock("@/lib/server/labels", () => ({ countIndexableLabels }));
vi.mock("@/lib/server/tracks-hub", () => ({ countAllTracks }));

// Raster nothing: a fake ImageResponse just carries the html + headers it was handed,
// so the assertions read the markup and the Cache-Control without paying for resvg.
vi.mock("workers-og", () => ({
  ImageResponse: class {
    headers: Headers;
    html: string;
    status = 200;
    constructor(html: string, options: { headers?: HeadersInit }) {
      this.html = html;
      this.headers = new Headers(options.headers);
    }
  },
}));

type CardResponse = {
  headers: Headers;
  html?: string;
  status: number;
};

async function getCard(query: string): Promise<CardResponse> {
  const { serverHandlers } = await import("./og.hub");

  return (await serverHandlers.GET({
    request: new Request(`https://www.fluncle.com/api/og/hub${query}`),
  })) as unknown as CardResponse;
}

const COUNTS = [countIndexableAlbums, countIndexableArtists, countIndexableLabels, countAllTracks];

describe("the hub OG card", () => {
  beforeEach(() => {
    for (const count of COUNTS) {
      count.mockClear();
      count.mockResolvedValue(0);
    }
  });

  it.each([["?hub=galaxies"], ["?hub="], [""]])(
    "404s an invalid hub (%s) before any DB read",
    async (query) => {
      const res = await getCard(query);

      expect(res.status).toBe(404);
      for (const count of COUNTS) {
        expect(count).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["artists", countIndexableArtists, "1,234 drum & bass artists, A to Z."],
    ["albums", countIndexableAlbums, "1,234 drum & bass records, A to Z."],
    ["labels", countIndexableLabels, "1,234 drum & bass labels, A to Z."],
    ["tracks", countAllTracks, "1,234 drum & bass tracks, newest first."],
  ])("renders %s from its own count read", async (hub, count, line) => {
    count.mockResolvedValue(1234);

    const res = await getCard(`?hub=${hub}`);

    expect(res.status).toBe(200);
    expect(count).toHaveBeenCalledTimes(1);
    // Only the asked hub's counter runs — the other three stay untouched.
    for (const other of COUNTS) {
      if (other !== count) {
        expect(other).not.toHaveBeenCalled();
      }
    }
    expect(res.html).toContain(line);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
    );
  });

  it("drops the count clause at a count of one (the masthead's own rule)", async () => {
    countIndexableArtists.mockResolvedValue(1);

    const res = await getCard("?hub=artists");

    expect(res.html).toContain("Drum & bass artists, A to Z.");
    expect(res.html).not.toContain("1 drum");
  });
});

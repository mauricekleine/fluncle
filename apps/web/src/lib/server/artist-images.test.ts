import { afterEach, expect, it, vi } from "vitest";

vi.mock("./musicbrainz", () => ({ mbFetch: vi.fn() }));

import { fetchArtistImages } from "./artist-images";
import { mbFetch } from "./musicbrainz";

const mbFetchMock = vi.mocked(mbFetch);
const artist = (
  id: string,
  name = "Example Artist",
  mbid: string | null = null,
  deezerTrackId: string | null = null,
) => ({ deezerTrackId, mbid, name, spotifyArtistId: id });
const iframe = (id: string) => `https://open.spotify.com/embed/artist/${id}`;
const ids = [
  "0TnOYISbd1XYRBk9myaseg",
  "1uNFoZAHBGtllmzznpCI3s",
  "4dpARuHxo51G3z768sgnrY",
  "6eUKZXaKkcviH0Ku9w2n3V",
  "66CXWjxzNUsdJxJ2JdwvnR",
  "2FXC3k01G6Gw61bmprjgqS",
  "3TVXtAsR1Inumwj472S9r4",
  "2YZyLoL8N0Wb9xBt1NhZWg",
  "5K4W6rqBFWDnAN6FQUkS6x",
  "7dGJo4pcD2V6oG8kP0tJRR",
];
const deezerImage = (hash: string) =>
  `https://cdn-images.dzcdn.net/images/artist/${hash}/1000x1000.jpg`;
const oembed = (id: string, thumbnail?: string) =>
  new Response(
    JSON.stringify({ iframe_url: iframe(id), thumbnail_url: thumbnail, title: "Example Artist" }),
  );

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  mbFetchMock.mockReset();
});

it("rewrites the oEmbed fixture to the 640px Spotify image and caches it", async () => {
  const thumbnail =
    "https://image-cdn-ak.spotifycdn.com/image/ab67616100005174e75db75543a89589514259b2";
  const master = "https://i.scdn.co/image/ab6761610000e5ebe75db75543a89589514259b2";
  const fetchMock = stubFetch((url, init) => {
    if (url === master && init?.method === "HEAD") {
      return new Response(null, { headers: { "content-type": "image/jpeg" }, status: 200 });
    }
    expect(url).toContain("https://open.spotify.com/oembed?");
    return oembed(ids[0] ?? "", thumbnail);
  });

  const first = await fetchArtistImages([artist(ids[0] ?? "")]);
  const second = await fetchArtistImages([artist(ids[0] ?? "")]);
  expect(first.images.get(ids[0] ?? "")).toBe(master);
  expect(second.images.get(ids[0] ?? "")).toBe(master);
  expect((await fetch(master, { method: "HEAD" })).headers.get("content-type")).toBe("image/jpeg");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.every(([url]) => !url.includes("api.spotify.com"))).toBe(true);
});

it("uses a MusicBrainz linked Deezer artist without a track lookup", async () => {
  mbFetchMock.mockResolvedValueOnce({
    data: { relations: [{ url: { resource: "https://www.deezer.com/artist/123" } }] },
    rateLimited: false,
  });
  const fetchMock = stubFetch((url) => {
    if (url.startsWith("https://open.spotify.com/oembed?")) {
      return new Response("", { status: 404 });
    }
    expect(url).toBe("https://api.deezer.com/artist/123");
    return new Response(
      JSON.stringify({ id: 123, name: "An Alias", picture_xl: deezerImage("linked") }),
    );
  });
  const result = await fetchArtistImages([artist(ids[1] ?? "", "Example Artist", "mbid-1")]);
  expect(result.images.get(ids[1] ?? "")).toBe(deezerImage("linked"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("corroborates a name with a verified track contributor and exact Deezer artist id", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.startsWith("https://open.spotify.com/oembed?")) {
      return oembed(ids[2] ?? "");
    }
    if (url.endsWith("/track/456")) {
      return new Response(JSON.stringify({ contributors: [{ id: 123, name: "Example Artist" }] }));
    }
    expect(url).toBe("https://api.deezer.com/artist/123");
    return new Response(
      JSON.stringify({ id: 123, name: "Example Artist", picture_xl: deezerImage("portrait") }),
    );
  });
  const result = await fetchArtistImages([artist(ids[2] ?? "", "Example Artist", null, "456")]);
  expect(result.images.get(ids[2] ?? "")).toBe(deezerImage("portrait"));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("leaves two exact-name track contributors ambiguous", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.startsWith("https://open.spotify.com/oembed?")) {
      return oembed(ids[3] ?? "");
    }
    expect(url).toBe("https://api.deezer.com/track/456");
    return new Response(
      JSON.stringify({
        contributors: [
          { id: 1, name: "Example Artist" },
          { id: 2, name: "Example Artist" },
        ],
      }),
    );
  });
  const result = await fetchArtistImages([artist(ids[3] ?? "", "Example Artist", null, "456")]);
  expect(result.missingIds).toContain(ids[3]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("treats MusicBrainz 404 and Deezer code 800 as misses", async () => {
  mbFetchMock.mockResolvedValueOnce({ data: null, rateLimited: false, status: 404 });
  const fetchMock = stubFetch((url) => {
    if (url.startsWith("https://open.spotify.com/oembed?")) {
      return oembed(ids[4] ?? "");
    }
    return new Response(JSON.stringify({ error: { code: 800, message: "Data not found" } }));
  });
  const result = await fetchArtistImages([
    artist(ids[4] ?? "", "Example Artist", "mbid-404", "456"),
  ]);
  expect(result.missingIds).toContain(ids[4]);
  expect(result.failures.size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  ["exhausted 503", { data: null, rateLimited: true, status: 503 }, true],
  ["network error", { data: null, rateLimited: false }, false],
])(
  "defers a MusicBrainz %s without declaring an image absent",
  async (_case, mbResult, limited) => {
    mbFetchMock.mockResolvedValueOnce(mbResult);
    const fetchMock = stubFetch((url) => {
      expect(url).toContain("https://open.spotify.com/oembed?");
      return oembed(ids[9] ?? "");
    });
    const id = "0OdUWJ0sBjDrqHygGUXeCF";
    const result = await fetchArtistImages([artist(id, "Example Artist", "mbid-transient")]);
    expect(result.deferredIds).toContain(id);
    expect(result.missingIds.size).toBe(0);
    expect(result.failures.size).toBe(0);
    expect(result.rateLimited).toBe(limited);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("defers a failed MusicBrainz response parse", async () => {
  const id = "2FXC3k01G6Gw61bmprjgqS";
  mbFetchMock.mockRejectedValueOnce(new SyntaxError("Invalid JSON"));
  stubFetch(() => oembed(id));
  const result = await fetchArtistImages([artist(id, "Example Artist", "mbid-invalid")]);
  expect(result.deferredIds).toContain(id);
  expect(result.failures.size).toBe(0);
  expect(result.missingIds.size).toBe(0);
});

it("skips Deezer after code 4 while later artists still reach oEmbed", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.includes(ids[5] ?? "")) {
      return oembed(ids[5] ?? "");
    }
    if (url.includes(ids[6] ?? "")) {
      return oembed(ids[6] ?? "", "https://i.scdn.co/image/artist-six");
    }
    return new Response(JSON.stringify({ error: { code: 4, message: "Quota exceeded" } }));
  });
  const result = await fetchArtistImages([
    artist(ids[5] ?? "", "Example Artist", null, "456"),
    artist(ids[6] ?? "", "Example Artist", null, "789"),
  ]);
  expect(result.checkedCount).toBe(2);
  expect(result.deferredIds.has(ids[5] ?? "")).toBe(true);
  expect(result.failures.size).toBe(0);
  expect(result.images.has(ids[6] ?? "")).toBe(true);
  expect(result.rateLimited).toBe(true);
  expect(
    fetchMock.mock.calls.filter(([url]) => url.startsWith("https://api.deezer.com/")),
  ).toHaveLength(1);
});

it("skips Deezer after HTTP 429 while later oEmbed images still fill", async () => {
  const firstId = "0OdUWJ0sBjDrqHygGUXeCF";
  const secondId = "1Xyo4u8uXC1ZmMpatF05PJ";
  const fetchMock = stubFetch((url) => {
    if (url.includes(firstId)) {
      return oembed(firstId);
    }
    if (url.includes(secondId)) {
      return oembed(secondId, "https://i.scdn.co/image/second");
    }
    return new Response(null, { status: 429 });
  });
  const result = await fetchArtistImages([
    artist(firstId, "Example Artist", null, "456"),
    artist(secondId, "Example Artist", null, "789"),
  ]);
  expect(result.deferredIds.has(firstId)).toBe(true);
  expect(result.failures.size).toBe(0);
  expect(result.images.has(secondId)).toBe(true);
  expect(
    fetchMock.mock.calls.filter(([url]) => url.startsWith("https://api.deezer.com/")),
  ).toHaveLength(1);
});

it.each([429, 503])("defers an oEmbed %i while Deezer has no image", async (status) => {
  const id = status === 429 ? "3nFkdlSjzX9mRTtwJOzDYB" : "0du5cEVh5yTK9QJze8zA0C";
  stubFetch(() => new Response(null, { status }));
  const result = await fetchArtistImages([artist(id)]);
  expect(result.deferredIds).toContain(id);
  expect(result.missingIds.size).toBe(0);
  expect(result.failures.size).toBe(0);
  expect(result.rateLimited).toBe(true);
});

it("treats an oEmbed identity mismatch as a miss and tries the linked Deezer artist", async () => {
  const id = "1HY2Jd0NmPuamShAr6KMms";
  mbFetchMock.mockResolvedValueOnce({
    data: { relations: [{ url: { resource: "https://www.deezer.com/artist/123" } }] },
    rateLimited: false,
  });
  const fetchMock = stubFetch((url) => {
    if (url.startsWith("https://open.spotify.com/oembed?")) {
      return oembed(ids[0] ?? "", "https://i.scdn.co/image/wrong-artist");
    }
    return new Response(JSON.stringify({ id: 123, picture_xl: deezerImage("correct") }));
  });
  const result = await fetchArtistImages([artist(id, "Example Artist", "linked-mbid")]);
  expect(result.images.get(id)).toBe(deezerImage("correct"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("rejects Deezer's empty and md5 placeholder hashes", async () => {
  mbFetchMock
    .mockResolvedValueOnce({
      data: { relations: [{ url: { resource: "https://www.deezer.com/artist/901" } }] },
      rateLimited: false,
    })
    .mockResolvedValueOnce({
      data: { relations: [{ url: { resource: "https://www.deezer.com/artist/902" } }] },
      rateLimited: false,
    });
  stubFetch((url) => {
    if (url.includes(ids[7] ?? "")) {
      return oembed(ids[7] ?? "");
    }
    if (url.includes(ids[8] ?? "")) {
      return oembed(ids[8] ?? "");
    }
    const id = url.endsWith("/901") ? 901 : 902;
    return new Response(
      JSON.stringify({
        id,
        picture_xl: deezerImage(id === 901 ? "" : "d41d8cd98f00b204e9800998ecf8427e"),
      }),
    );
  });
  const result = await fetchArtistImages([
    artist(ids[7] ?? "", "Example Artist", "mbid-a"),
    artist(ids[8] ?? "", "Example Artist", "mbid-b"),
  ]);
  expect(result.missingIds).toEqual(new Set([ids[7], ids[8]]));
  expect(result.images.size).toBe(0);
});

it("rejects a thumbnail on an unallowlisted host", async () => {
  const fetchMock = stubFetch((url) => {
    expect(url).toContain("https://open.spotify.com/oembed?");
    return oembed(ids[9] ?? "", "https://elsewhere.example/image/ab67616100005174abc");
  });
  const result = await fetchArtistImages([artist(ids[9] ?? "")]);
  expect(result.missingIds).toContain(ids[9]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

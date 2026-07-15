import { beforeEach, describe, expect, it, vi } from "vitest";

// Fluncle's Telescope — the mirror's contract: a pure, ordered, full-replace reflection
// of the diversified ear top into the PRIVATE playlist; lazy one-time creation; one GET
// when nothing changed; never a throw (the sync rides the rank sweep and the operator's
// certify/dismiss acts, which must not fail on a Spotify hiccup).

const settings = new Map<string, string>();
const spotifyCalls: { init?: RequestInit; path: string }[] = [];
let earRows: { spotifyUrl: null | string; trackId: string }[] = [];
let playlistItems: string[] = [];
let failFetch = false;

vi.mock("./catalogue", () => ({
  listCatalogueTracks: vi.fn(() => Promise.resolve(earRows)),
}));

vi.mock("./settings", () => ({
  getSetting: vi.fn((key: string) => Promise.resolve(settings.get(key))),
  setSetting: vi.fn((key: string, value: string) => {
    settings.set(key, value);

    return Promise.resolve();
  }),
}));

vi.mock("./log", () => ({ logEvent: vi.fn() }));

vi.mock("./spotify", () => ({
  getSpotifyAccessToken: vi.fn(() => Promise.resolve("token")),
  spotifyFetch: vi.fn((path: string, _token: string, init?: RequestInit) => {
    spotifyCalls.push({ init, path });

    if (failFetch) {
      return Promise.reject(new Error("spotify down"));
    }

    if (path === "/me") {
      return Promise.resolve(new Response(JSON.stringify({ id: "fluncle" })));
    }

    if (path.startsWith("/users/fluncle/playlists")) {
      return Promise.resolve(new Response(JSON.stringify({ id: "pl-telescope" })));
    }

    if (path.startsWith("/playlists/") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ items: playlistItems.map((uri) => ({ track: { uri } })) })),
      );
    }

    return Promise.resolve(new Response("{}"));
  }),
}));

function track(id: string): { spotifyUrl: string; trackId: string } {
  return { spotifyUrl: `https://open.spotify.com/track/${id}`, trackId: id };
}

beforeEach(() => {
  settings.clear();
  spotifyCalls.length = 0;
  earRows = [];
  playlistItems = [];
  failFetch = false;
});

describe("spotifyUriFromUrl", () => {
  it("parses an open.spotify.com track URL and rejects everything else", async () => {
    const { spotifyUriFromUrl } = await import("./telescope-playlist");

    expect(spotifyUriFromUrl("https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh")).toBe(
      "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
    );
    expect(spotifyUriFromUrl("https://example.com/nope")).toBeNull();
    expect(spotifyUriFromUrl(null)).toBeNull();
  });
});

describe("syncTelescopePlaylist", () => {
  it("creates the PRIVATE playlist once, stores its id, and PUTs the ordered mirror", async () => {
    const { syncTelescopePlaylist, TELESCOPE_PLAYLIST_SETTING } =
      await import("./telescope-playlist");

    earRows = [track("1111111111111111111111"), track("2222222222222222222222")];

    const result = await syncTelescopePlaylist();

    expect(result).toEqual({ changed: true, ok: true, size: 2 });
    expect(settings.get(TELESCOPE_PLAYLIST_SETTING)).toBe("pl-telescope");

    const create = spotifyCalls.find((call) => call.path === "/users/fluncle/playlists");
    expect(create).toBeDefined();
    expect(JSON.parse((create?.init?.body as string) ?? "{}")).toMatchObject({ public: false });

    const put = spotifyCalls.find((call) => call.init?.method === "PUT");
    expect(JSON.parse((put?.init?.body as string) ?? "{}").uris).toEqual([
      "spotify:track:1111111111111111111111",
      "spotify:track:2222222222222222222222",
    ]);
  });

  it("an unchanged mirror is one GET and no PUT", async () => {
    const { syncTelescopePlaylist, TELESCOPE_PLAYLIST_SETTING } =
      await import("./telescope-playlist");

    settings.set(TELESCOPE_PLAYLIST_SETTING, "pl-telescope");
    earRows = [track("1111111111111111111111")];
    playlistItems = ["spotify:track:1111111111111111111111"];

    const result = await syncTelescopePlaylist();

    expect(result).toEqual({ changed: false, ok: true, size: 1 });
    expect(spotifyCalls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("a re-ordering IS a change — the order is the ranking", async () => {
    const { syncTelescopePlaylist, TELESCOPE_PLAYLIST_SETTING } =
      await import("./telescope-playlist");

    settings.set(TELESCOPE_PLAYLIST_SETTING, "pl-telescope");
    earRows = [track("2222222222222222222222"), track("1111111111111111111111")];
    playlistItems = [
      "spotify:track:1111111111111111111111",
      "spotify:track:2222222222222222222222",
    ];

    const result = await syncTelescopePlaylist();

    expect(result).toMatchObject({ changed: true, ok: true });
  });

  it("an anchor-less row never reaches the playlist", async () => {
    const { syncTelescopePlaylist, TELESCOPE_PLAYLIST_SETTING } =
      await import("./telescope-playlist");

    settings.set(TELESCOPE_PLAYLIST_SETTING, "pl-telescope");
    earRows = [track("1111111111111111111111"), { spotifyUrl: null, trackId: "mb_unanchored" }];

    const result = await syncTelescopePlaylist();

    expect(result).toMatchObject({ ok: true, size: 1 });
  });

  it("a Spotify failure reports { ok: false } and never throws", async () => {
    const { syncTelescopePlaylist, TELESCOPE_PLAYLIST_SETTING } =
      await import("./telescope-playlist");

    settings.set(TELESCOPE_PLAYLIST_SETTING, "pl-telescope");
    earRows = [track("1111111111111111111111")];
    failFetch = true;

    const result = await syncTelescopePlaylist();

    expect(result).toMatchObject({ ok: false });
  });
});

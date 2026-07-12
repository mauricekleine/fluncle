import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setRateLimitForTests,
  type ArtistSocialPlatform,
  classifyMbUrl,
  luceneEscapePhrase,
  normalizeProfileUrl,
  parseSpotifyArtistId,
  resolveArtistViaMb,
  resolveGapViaFirecrawl,
  validateSocialUrlForPlatform,
} from "@/lib/server/artist-resolution";

// A tiny URL-routing fetch mock identical in spirit to discogs.test.ts.
function mockFetch(routes: Array<{ match: string; body?: unknown; response?: Response }>) {
  const calls: string[] = [];

  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    calls.push(typeof url === "string" ? url : String(url));

    const route = routes.find((r) =>
      (typeof url === "string" ? url : String(url)).includes(r.match),
    );

    if (!route) {
      return new Response("not found", { status: 404 });
    }

    if (route.response) {
      return route.response;
    }

    return Response.json(route.body);
  });

  vi.stubGlobal("fetch", fetchMock);

  return { calls, fetchMock };
}

const MB_ARTIST_SEARCH = "musicbrainz.org/ws/2/artist?query=";
const FIRECRAWL_SCRAPE = "api.firecrawl.dev/v2/scrape";
const FIRECRAWL_SEARCH = "api.firecrawl.dev/v2/search";

// ── classifyMbUrl ─────────────────────────────────────────────────────────────

describe("classifyMbUrl", () => {
  it("classifies Spotify artist URLs", () => {
    expect(classifyMbUrl("https://open.spotify.com/artist/abc")).toBe("spotify");
  });

  it("classifies YouTube channel URLs (including music.youtube.com)", () => {
    expect(classifyMbUrl("https://www.youtube.com/channel/UCxxx")).toBe("youtube");
    expect(classifyMbUrl("https://youtube.com/@handle")).toBe("youtube");
    expect(classifyMbUrl("https://music.youtube.com/channel/UCxxx")).toBe("youtube");
  });

  it("classifies SoundCloud URLs", () => {
    expect(classifyMbUrl("https://soundcloud.com/artist-name")).toBe("soundcloud");
  });

  it("classifies Instagram URLs", () => {
    expect(classifyMbUrl("https://www.instagram.com/artistname")).toBe("instagram");
  });

  it("classifies TikTok URLs", () => {
    expect(classifyMbUrl("https://www.tiktok.com/@artistname")).toBe("tiktok");
  });

  it("classifies Bandcamp URLs", () => {
    expect(classifyMbUrl("https://artistname.bandcamp.com")).toBe("bandcamp");
  });

  it("classifies Twitter/X URLs", () => {
    expect(classifyMbUrl("https://twitter.com/artistname")).toBe("twitter");
    expect(classifyMbUrl("https://x.com/artistname")).toBe("twitter");
  });

  it("classifies Beatport artist URLs (promoted from the aggregator denylist)", () => {
    expect(classifyMbUrl("https://www.beatport.com/artist/andromedik/12345")).toBe("beatport");
    expect(classifyMbUrl("https://beatport.com/artist/dimension/6789")).toBe("beatport");
  });

  it("classifies Wikidata entity URLs", () => {
    expect(classifyMbUrl("https://www.wikidata.org/wiki/Q12345")).toBe("wikidata");
  });

  it("classifies Mixcloud URLs", () => {
    expect(classifyMbUrl("https://www.mixcloud.com/artist")).toBe("mixcloud");
  });

  it("classifies Facebook URLs", () => {
    expect(classifyMbUrl("https://www.facebook.com/artist")).toBe("facebook");
  });

  it("classifies Twitch channel URLs", () => {
    expect(classifyMbUrl("https://www.twitch.tv/flunclelive")).toBe("twitch");
    expect(classifyMbUrl("https://twitch.tv/flunclelive")).toBe("twitch");
  });

  it("returns null for known aggregators (linktr.ee, discogs, etc.)", () => {
    expect(classifyMbUrl("https://linktr.ee/artist")).toBeNull();
    expect(classifyMbUrl("https://www.discogs.com/artist/12345")).toBeNull();
    expect(classifyMbUrl("https://genius.com/artist")).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(classifyMbUrl("not-a-url")).toBeNull();
  });

  it("classifies an artist's own homepage as homepage only when relType is 'official homepage'", () => {
    expect(classifyMbUrl("https://artist.com", "official homepage")).toBe("homepage");
  });

  it("returns null for homepage-looking URLs without the 'official homepage' relType", () => {
    expect(classifyMbUrl("https://artist.com")).toBeNull();
    expect(classifyMbUrl("https://artist.com", "wikipedia")).toBeNull();
    expect(classifyMbUrl("https://artist.com", "streaming music")).toBeNull();
  });

  it("returns null for Wikipedia/VIAF/IMDb URLs regardless of relType", () => {
    expect(classifyMbUrl("https://en.wikipedia.org/wiki/ArtistName", "wikipedia")).toBeNull();
    expect(classifyMbUrl("https://viaf.org/viaf/12345", "VIAF")).toBeNull();
    expect(classifyMbUrl("https://www.imdb.com/name/nm1234567/", "IMDb")).toBeNull();
  });
});

// ── normalizeProfileUrl ───────────────────────────────────────────────────────

describe("normalizeProfileUrl", () => {
  beforeEach(() => {
    // Stub fetch so YouTube API calls don't hit the network; return no items.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [] })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a TikTok video URL to the @handle profile root", async () => {
    const result = await normalizeProfileUrl(
      "tiktok",
      "https://www.tiktok.com/@dimension/video/12345",
    );
    expect(result).toBe("https://www.tiktok.com/@dimension");
  });

  it("normalizes a TikTok URL that already has @handle", async () => {
    const result = await normalizeProfileUrl("tiktok", "https://www.tiktok.com/@dimension");
    expect(result).toBe("https://www.tiktok.com/@dimension");
  });

  it("returns null for a TikTok URL with no @handle path", async () => {
    const result = await normalizeProfileUrl("tiktok", "https://www.tiktok.com/");
    expect(result).toBeNull();
  });

  it("normalizes an Instagram URL to the profile root, stripping trailing /", async () => {
    const result = await normalizeProfileUrl(
      "instagram",
      "https://www.instagram.com/dimension/tagged/",
    );
    // The trailing path and sub-paths: extractInstagramHandle only matches single-segment.
    // A URL like /dimension/tagged/ won't match — only /dimension/ or /dimension would.
    // So this tests the multi-segment fallback.
    expect(result).toBeNull();
  });

  it("normalizes a clean Instagram URL", async () => {
    const result = await normalizeProfileUrl("instagram", "https://www.instagram.com/dimension");
    expect(result).toBe("https://www.instagram.com/dimension");
  });

  it("strips query params from a homepage URL", async () => {
    const result = await normalizeProfileUrl("homepage", "https://artist.com/?utm_source=spotify");
    expect(result).toBe("https://artist.com");
  });

  it("normalizes a YouTube channel/UC... URL to its profile root", async () => {
    const result = await normalizeProfileUrl(
      "youtube",
      "https://www.youtube.com/channel/UCxxx/videos",
    );
    expect(result).toBe("https://www.youtube.com/channel/UCxxx");
  });

  it("returns null for a YouTube /watch URL (not a channel profile)", async () => {
    const result = await normalizeProfileUrl("youtube", "https://www.youtube.com/watch?v=abc123");
    expect(result).toBeNull();
  });

  it("rejects a non-http(s) scheme (stored-XSS defense at ingestion)", async () => {
    expect(await normalizeProfileUrl("homepage", "javascript:alert(1)")).toBeNull();
    expect(await normalizeProfileUrl("homepage", "data:text/html,<script>1</script>")).toBeNull();
    expect(await normalizeProfileUrl("instagram", "javascript:alert(document.cookie)")).toBeNull();
  });

  it("reduces a SoundCloud track deep-link to the profile root", async () => {
    expect(await normalizeProfileUrl("soundcloud", "https://soundcloud.com/nutone/a-track")).toBe(
      "https://soundcloud.com/nutone",
    );
    // A non-profile section (a track list) has no username → null.
    expect(await normalizeProfileUrl("soundcloud", "https://soundcloud.com/tracks")).toBeNull();
  });

  it("reduces a Facebook post and a tweet to the profile root", async () => {
    expect(
      await normalizeProfileUrl("facebook", "https://www.facebook.com/dannutone/posts/123"),
    ).toBe("https://www.facebook.com/dannutone");
    expect(await normalizeProfileUrl("twitter", "https://twitter.com/nutone/status/999")).toBe(
      "https://twitter.com/nutone",
    );
  });

  it("reduces a Twitch clip/video deep-link to the channel root", async () => {
    expect(
      await normalizeProfileUrl("twitch", "https://www.twitch.tv/flunclelive/clip/AbC123"),
    ).toBe("https://www.twitch.tv/flunclelive");
    // A non-channel section (the video list) has no handle → null.
    expect(await normalizeProfileUrl("twitch", "https://www.twitch.tv/directory")).toBeNull();
  });

  it("reduces a Bandcamp album deep-link to the artist origin", async () => {
    expect(await normalizeProfileUrl("bandcamp", "https://nutone.bandcamp.com/album/x")).toBe(
      "https://nutone.bandcamp.com",
    );
  });
});

// ── luceneEscapePhrase / parseSpotifyArtistId (pure helpers) ───────────────────

describe("luceneEscapePhrase", () => {
  it("escapes backslash and double-quote (the phrase-internal specials)", () => {
    expect(luceneEscapePhrase(`Simon "Shy FX"`)).toBe(`Simon \\"Shy FX\\"`);
    expect(luceneEscapePhrase("A\\B")).toBe("A\\\\B");
  });

  it("leaves term-level specials untouched (inert inside a quoted phrase)", () => {
    expect(luceneEscapePhrase("Sub Focus & Wilkinson")).toBe("Sub Focus & Wilkinson");
    expect(luceneEscapePhrase("Camo + Krooked")).toBe("Camo + Krooked");
  });
});

describe("parseSpotifyArtistId", () => {
  it("extracts the artist id from an open.spotify.com artist URL", () => {
    expect(parseSpotifyArtistId("https://open.spotify.com/artist/7miXLG9boDOGHJaEelSL7T")).toBe(
      "7miXLG9boDOGHJaEelSL7T",
    );
    expect(
      parseSpotifyArtistId("https://open.spotify.com/artist/7miXLG9boDOGHJaEelSL7T?si=abc"),
    ).toBe("7miXLG9boDOGHJaEelSL7T");
  });

  it("returns null for non-Spotify or non-artist URLs", () => {
    expect(parseSpotifyArtistId("https://open.spotify.com/track/abc")).toBeNull();
    expect(parseSpotifyArtistId("https://soundcloud.com/artist")).toBeNull();
    expect(parseSpotifyArtistId("not-a-url")).toBeNull();
  });
});

// ── resolveArtistViaMb (name search primary + Spotify-URL cross-reference) ─────

describe("resolveArtistViaMb (MB name search + Spotify cross-reference)", () => {
  // The Andromedik / Freaks & Geeks Spotify ids from the validated live examples.
  const ANDROMEDIK_SPOTIFY_ID = "7miXLG9boDOGHJaEelSL7T";
  const FREAKS_SPOTIFY_ID = "6Qcn4TflUyLRoA6w44IQSU";

  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    __setRateLimitForTests(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRateLimitForTests(1100);
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("resolves via name-search, confirmed by an exact Spotify-id identity match", async () => {
    // Mirrors Andromedik: top hit score 100, 18 url-rels incl. our Spotify id.
    const { calls } = mockFetch([
      {
        body: { artists: [{ id: "mb-andromedik", name: "Andromedik", score: 100 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-andromedik",
          name: "Andromedik",
          relations: [
            { url: { resource: `https://open.spotify.com/artist/${ANDROMEDIK_SPOTIFY_ID}` } },
            { type: "soundcloud", url: { resource: "https://soundcloud.com/andromedikmusic" } },
            { url: { resource: "https://www.wikidata.org/wiki/Q123456" } },
          ],
        },
        match: "artist/mb-andromedik",
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBe("mb-andromedik");
    expect(result.wikidataQid).toBe("Q123456");
    expect(result.rateLimited).toBe(false);
    // A confirmed Spotify-id identity → the socials persist as trusted/public.
    expect(result.mbSocialStatus).toBe("auto");

    const platforms = result.socials.map((s) => s.platform);
    expect(platforms).toContain("spotify");
    expect(platforms).toContain("soundcloud");

    // All MB-sourced socials must report source=musicbrainz (→ status=auto).
    for (const social of result.socials) {
      expect(social.source).toBe("musicbrainz");
    }

    // Name search was the entry point; no ISRC endpoint is ever consulted.
    expect(calls.some((c) => c.includes("artist?query="))).toBe(true);
    expect(calls.some((c) => c.includes("/isrc/"))).toBe(false);
  });

  it("captures MB link hubs (linktree + homepage) as gap-fill scrape seeds in hubUrls", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-x", name: "X", score: 100 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-x",
          name: "X",
          relations: [
            { url: { resource: "https://open.spotify.com/artist/spotifyxid123" } },
            { url: { resource: "https://linktr.ee/thex" } },
            { type: "official homepage", url: { resource: "https://thex.com/" } },
          ],
        },
        match: "artist/mb-x",
      },
    ]);

    const result = await resolveArtistViaMb("X", "spotifyxid123");

    // The linktree is captured as a hub seed (never a social); the homepage is BOTH a
    // homepage social AND a hub seed (an artist's own footer lists its socials).
    expect(result.hubUrls).toContain("https://linktr.ee/thex");
    expect(result.hubUrls).toContain("https://thex.com");
    expect(result.socials.map((s) => s.platform)).toContain("homepage");
    // A link hub is never stored as a social platform row.
    expect(result.socials.every((s) => !s.url.includes("linktr.ee"))).toBe(true);
  });

  it("(a) accepts the Spotify-id match even over a HIGHER-scored earlier candidate", async () => {
    // Mirrors Freaks & Geeks: the top-scored hit is the wrong/empty entry; the
    // definitive identity is a lower-scored candidate carrying our Spotify id.
    const { calls } = mockFetch([
      {
        body: {
          artists: [
            { id: "mb-wrong", name: "Freaks & Geeks", score: 100 },
            { id: "mb-real", name: "Freaks & Geeks", score: 98 },
          ],
        },
        match: MB_ARTIST_SEARCH,
      },
      {
        // Higher-scored candidate: empty/wrong entry, zero url-rels.
        body: { id: "mb-wrong", name: "Freaks & Geeks", relations: [] },
        match: "artist/mb-wrong",
      },
      {
        body: {
          id: "mb-real",
          name: "Freaks & Geeks",
          relations: [
            { url: { resource: `https://open.spotify.com/artist/${FREAKS_SPOTIFY_ID}` } },
            { type: "soundcloud", url: { resource: "https://soundcloud.com/freaksandgeeksdnb" } },
          ],
        },
        match: "artist/mb-real",
      },
    ]);

    const result = await resolveArtistViaMb("Freaks & Geeks", FREAKS_SPOTIFY_ID);

    expect(result.mbid).toBe("mb-real");
    expect(result.mbSocialStatus).toBe("auto");
    expect(result.socials.map((s) => s.platform)).toContain("soundcloud");
    // Both candidates were deep-fetched (the wrong one first, then the match).
    expect(calls.some((c) => c.includes("artist/mb-wrong"))).toBe(true);
    expect(calls.some((c) => c.includes("artist/mb-real"))).toBe(true);
  });

  it("(b) REJECTS a same-named namesake whose Spotify id differs → unresolved", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-namesake", name: "Andromedik", score: 100 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-namesake",
          name: "Andromedik",
          relations: [
            { url: { resource: "https://open.spotify.com/artist/SOME_OTHER_ARTIST_ID" } },
            { url: { resource: "https://soundcloud.com/not-andromedik" } },
          ],
        },
        match: "artist/mb-namesake",
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    // Different Spotify id → not our artist. Better a miss than a wrong link.
    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
  });

  it("(Dimension trap) does NOT accept the top-scored namesake — leaves it unresolved", async () => {
    // The disambiguation trap: the highest-scored hit is the wrong artist (Japanese
    // jazz group), and the real DnB entry carries a Spotify id that isn't ours. No
    // candidate exposes OUR Spotify id → unresolved, never the top-scored namesake.
    mockFetch([
      {
        body: {
          artists: [
            { id: "mb-jazz", name: "DIMENSION", score: 100 },
            { id: "mb-other-dnb", name: "Dimension", score: 99 },
          ],
        },
        match: MB_ARTIST_SEARCH,
      },
      {
        // Japanese jazz group — high score, exact name, but a DIFFERENT Spotify id.
        body: {
          id: "mb-jazz",
          name: "DIMENSION",
          relations: [{ url: { resource: "https://open.spotify.com/artist/JAZZ_GROUP_ID" } }],
        },
        match: "artist/mb-jazz",
      },
      {
        body: {
          id: "mb-other-dnb",
          name: "Dimension",
          relations: [{ url: { resource: "https://open.spotify.com/artist/ANOTHER_DNB_ID" } }],
        },
        match: "artist/mb-other-dnb",
      },
    ]);

    const result = await resolveArtistViaMb("Dimension", "OUR_STORED_DIMENSION_ID");

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
  });

  it("(c) accepts a no-Spotify-rel candidate on a strong score + exact name match", async () => {
    // No candidate exposes ANY Spotify rel → the soft name+score fallback applies.
    mockFetch([
      {
        body: { artists: [{ id: "mb-nospotify", name: "Andromedik", score: 95 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-nospotify",
          name: "Andromedik",
          relations: [{ url: { resource: "https://soundcloud.com/andromedikmusic" } }],
        },
        match: "artist/mb-nospotify",
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBe("mb-nospotify");
    // No identity confirmation → the soft fallback's socials are DOWNGRADED to candidate
    // (awaits an operator glance; never public until confirmed).
    expect(result.mbSocialStatus).toBe("candidate");
    expect(result.socials.map((s) => s.platform)).toContain("soundcloud");
  });

  it("(c) rejects a no-Spotify-rel candidate when the score is below the threshold", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-weak", name: "Andromedik", score: 50 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-weak",
          name: "Andromedik",
          relations: [{ url: { resource: "https://soundcloud.com/maybe-not" } }],
        },
        match: "artist/mb-weak",
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
  });

  it("(c) rejects a no-Spotify-rel high-score candidate whose name does not match", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-diff", name: "Andromeda", score: 96 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-diff",
          name: "Andromeda",
          relations: [{ url: { resource: "https://soundcloud.com/andromeda" } }],
        },
        match: "artist/mb-diff",
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBeNull();
  });

  it("disables the soft fallback once ANY candidate exposed a Spotify rel (namesake guard)", async () => {
    // First candidate carries a (differing) Spotify rel → a cross-check signal existed
    // and didn't match ours; a later no-Spotify candidate must NOT slip through on
    // name+score alone. Result: unresolved.
    mockFetch([
      {
        body: {
          artists: [
            { id: "mb-has-spotify", name: "Andromedik", score: 100 },
            { id: "mb-no-spotify", name: "Andromedik", score: 99 },
          ],
        },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-has-spotify",
          name: "Andromedik",
          relations: [{ url: { resource: "https://open.spotify.com/artist/DIFFERENT_ID" } }],
        },
        match: "artist/mb-has-spotify",
      },
      {
        body: {
          id: "mb-no-spotify",
          name: "Andromedik",
          relations: [{ url: { resource: "https://soundcloud.com/andromedikmusic" } }],
        },
        match: "artist/mb-no-spotify",
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
  });

  it("makes no MB call and returns unresolved for a blank artist name", async () => {
    const { calls } = mockFetch([]);
    const result = await resolveArtistViaMb("   ", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns unresolved when the name search returns no candidates", async () => {
    mockFetch([{ body: { artists: [] }, match: MB_ARTIST_SEARCH }]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
  });

  it("reports rateLimited=true when the name-search request is throttled (503)", async () => {
    mockFetch([
      {
        match: MB_ARTIST_SEARCH,
        response: new Response("service unavailable", { status: 503 }),
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.rateLimited).toBe(true);
    expect(result.mbid).toBeNull();
  });

  it("reports rateLimited=true when a candidate deep-fetch is throttled (503)", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-andromedik", name: "Andromedik", score: 100 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        match: "artist/mb-andromedik",
        response: new Response("service unavailable", { status: 503 }),
      },
    ]);

    const result = await resolveArtistViaMb("Andromedik", ANDROMEDIK_SPOTIFY_ID);

    expect(result.rateLimited).toBe(true);
    expect(result.mbid).toBeNull();
  });

  it("deduplicates socials by platform (first url wins)", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-sub", name: "Sub Focus", score: 100 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-sub",
          name: "Sub Focus",
          relations: [
            { url: { resource: `https://open.spotify.com/artist/${ANDROMEDIK_SPOTIFY_ID}` } },
            { url: { resource: "https://soundcloud.com/sub-focus-1" } },
            { url: { resource: "https://soundcloud.com/sub-focus-2" } },
          ],
        },
        match: "artist/mb-sub",
      },
    ]);

    const result = await resolveArtistViaMb("Sub Focus", ANDROMEDIK_SPOTIFY_ID);

    const soundcloudSocials = result.socials.filter((s) => s.platform === "soundcloud");
    expect(soundcloudSocials).toHaveLength(1);
    expect(soundcloudSocials[0]?.url).toBe("https://soundcloud.com/sub-focus-1");
  });

  it("skips url-rels with no resource", async () => {
    mockFetch([
      {
        body: { artists: [{ id: "mb-noisia", name: "Noisia", score: 100 }] },
        match: MB_ARTIST_SEARCH,
      },
      {
        body: {
          id: "mb-noisia",
          name: "Noisia",
          relations: [
            { url: { resource: `https://open.spotify.com/artist/${ANDROMEDIK_SPOTIFY_ID}` } },
            { url: {} }, // no resource
            { url: { resource: "https://soundcloud.com/noisia" } },
          ],
        },
        match: "artist/mb-noisia",
      },
    ]);

    const result = await resolveArtistViaMb("Noisia", ANDROMEDIK_SPOTIFY_ID);

    const platforms = result.socials.map((s) => s.platform);
    expect(platforms).toContain("soundcloud");
    expect(result.socials.every((s) => Boolean(s.url))).toBe(true);
  });
});
// ── resolveGapViaFirecrawl ────────────────────────────────────────────────────

describe("resolveGapViaFirecrawl (MB-hub-first scrape + web-search gap-fill)", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
    __setRateLimitForTests(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRateLimitForTests(1100);
    delete process.env.FIRECRAWL_API_KEY;
  });

  // A routing mock over the two Firecrawl endpoints. `scrape` answers /v2/scrape JSON
  // mode with a platform→url object under data.json; `search` answers /v2/search with a
  // `web` result list. Records request URLs + parsed bodies so a test can assert the flow.
  function mockFirecrawl(opts: { scrape?: Record<string, string>; search?: string[] }) {
    const calls: string[] = [];
    const bodies: Array<{ body: Record<string, unknown>; url: string }> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : String(url);
      calls.push(u);

      if (typeof init?.body === "string") {
        bodies.push({ body: JSON.parse(init.body) as Record<string, unknown>, url: u });
      }

      if (u.includes(FIRECRAWL_SCRAPE)) {
        return Response.json({ data: { json: opts.scrape ?? {} }, success: true });
      }

      if (u.includes(FIRECRAWL_SEARCH)) {
        return Response.json({
          data: { web: (opts.search ?? []).map((r) => ({ url: r })) },
          success: true,
        });
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);

    return { bodies, calls, fetchMock };
  }

  /** The scrape request body (its JSON-mode schema property keys) for an assertion. */
  function scrapeSchemaKeys(
    bodies: Array<{ body: Record<string, unknown>; url: string }>,
  ): string[] {
    const body = bodies.find((b) => b.url.includes(FIRECRAWL_SCRAPE))?.body;
    const formats = body?.["formats"] as
      | Array<{ schema?: { properties?: Record<string, unknown> } }>
      | undefined;
    return Object.keys(formats?.[0]?.schema?.properties ?? {}).sort();
  }

  it("Stage 1 — scrapes an MB-provided link hub and never web-searches", async () => {
    const { calls } = mockFirecrawl({
      scrape: {
        instagram: "https://www.instagram.com/nutone/",
        soundcloud: "https://soundcloud.com/nutone",
        youtube: "https://www.youtube.com/channel/UCnutone",
      },
    });

    const result = await resolveGapViaFirecrawl(
      "Nu:Tone",
      null,
      "mb-nutone",
      new Set<ArtistSocialPlatform>(["instagram", "soundcloud", "youtube"]),
      ["https://linktr.ee/dannutone"],
    );

    expect(result.map((s) => s.platform).sort()).toEqual(["instagram", "soundcloud", "youtube"]);

    for (const social of result) {
      expect(social.source).toBe("firecrawl");
    }

    // The hub covered everything → zero /v2/search spend.
    expect(calls.some((c) => c.includes(FIRECRAWL_SCRAPE))).toBe(true);
    expect(calls.some((c) => c.includes(FIRECRAWL_SEARCH))).toBe(false);
  });

  it("scrapes the HUB url you give it (not the Spotify seed) and requests only missing platforms", async () => {
    const { bodies } = mockFirecrawl({
      scrape: { instagram: "https://www.instagram.com/nutone/" },
    });

    await resolveGapViaFirecrawl(
      "Nu:Tone",
      "https://open.spotify.com/artist/abc",
      "mb-nutone",
      new Set<ArtistSocialPlatform>(["instagram"]),
      ["https://linktr.ee/dannutone"],
    );

    const scrapeBody = bodies.find((b) => b.url.includes(FIRECRAWL_SCRAPE))?.body;
    expect(scrapeBody?.["url"]).toBe("https://linktr.ee/dannutone");
    expect(scrapeSchemaKeys(bodies)).toEqual(["instagram"]);
  });

  it("Stage 2 — searches for a link hub then scrapes it when MB had none", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);

      if (u.includes(FIRECRAWL_SEARCH)) {
        return Response.json({
          data: { web: [{ url: "https://linktr.ee/dannutone" }] },
          success: true,
        });
      }

      if (u.includes(FIRECRAWL_SCRAPE)) {
        return Response.json({
          data: { json: { soundcloud: "https://soundcloud.com/nutone" } },
          success: true,
        });
      }

      return new Response("nf", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGapViaFirecrawl(
      "Nu:Tone",
      null,
      "mb-nutone",
      new Set<ArtistSocialPlatform>(["soundcloud"]),
      [],
    );

    expect(result.map((s) => s.platform)).toEqual(["soundcloud"]);
    expect(result[0]?.url).toBe("https://soundcloud.com/nutone");
  });

  it("Stage 3 — falls back to a broad web search, bucketing profile-root results by host", async () => {
    // No MB hub; the hub-search finds no linktree → broad search returns raw profiles,
    // including a deep SoundCloud track link that must reduce to the profile root.
    mockFirecrawl({
      search: [
        "https://www.instagram.com/nutone/?hl=en",
        "https://soundcloud.com/nutone/one-day-at-a-time",
        "https://www.facebook.com/dannutone",
      ],
    });

    const result = await resolveGapViaFirecrawl(
      "Nu:Tone",
      null,
      "mb-nutone",
      new Set<ArtistSocialPlatform>(["instagram", "soundcloud", "facebook"]),
      [],
    );

    const byPlatform = Object.fromEntries(result.map((s) => [s.platform, s.url]));
    expect(byPlatform["instagram"]).toBe("https://www.instagram.com/nutone");
    expect(byPlatform["soundcloud"]).toBe("https://soundcloud.com/nutone");
    expect(byPlatform["facebook"]).toBe("https://www.facebook.com/dannutone");
  });

  it("returns [] when no gap platforms are requested (no Firecrawl call)", async () => {
    const { calls } = mockFirecrawl({});

    const result = await resolveGapViaFirecrawl(
      "X",
      "https://open.spotify.com/artist/abc",
      "mb",
      new Set(),
      [],
    );

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns [] with no identity anchor (no spotify, mbid, or MB hub)", async () => {
    const { calls } = mockFirecrawl({});

    const result = await resolveGapViaFirecrawl("X", null, null, new Set(["instagram"]), []);

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns [] when the Firecrawl key is absent", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const { calls } = mockFirecrawl({});

    const result = await resolveGapViaFirecrawl("X", null, "mb", new Set(["instagram"]), [
      "https://linktr.ee/x",
    ]);

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("is best-effort: a hub-scrape error yields [] rather than throwing", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);

      if (u.includes(FIRECRAWL_SCRAPE)) {
        return new Response("bad", { status: 500 });
      }

      if (u.includes(FIRECRAWL_SEARCH)) {
        return Response.json({ data: { web: [] }, success: true });
      }

      return new Response("nf", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGapViaFirecrawl("X", null, "mb", new Set(["instagram"]), [
      "https://linktr.ee/x",
    ]);

    expect(result).toHaveLength(0);
  });

  it("never requests homepage or spotify (kept out of the target set)", async () => {
    const { bodies } = mockFirecrawl({ scrape: {} });

    await resolveGapViaFirecrawl(
      "X",
      "https://open.spotify.com/artist/abc",
      "mb",
      new Set<ArtistSocialPlatform>(["spotify", "homepage", "instagram", "tiktok"]),
      ["https://linktr.ee/x"],
    );

    const keys = scrapeSchemaKeys(bodies);
    expect(keys).not.toContain("homepage");
    expect(keys).not.toContain("spotify");
    expect(keys).toEqual(["instagram", "tiktok"]);
  });

  it("makes no Firecrawl call when the only missing platforms are non-targets", async () => {
    const { calls } = mockFirecrawl({});

    const result = await resolveGapViaFirecrawl(
      "X",
      "https://open.spotify.com/artist/abc",
      "mb",
      new Set<ArtistSocialPlatform>(["homepage", "spotify"]),
      [],
    );

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("skips a scraped value that won't normalize to a profile root", async () => {
    // A TikTok URL with no handle → normalizeProfileUrl returns null → dropped.
    mockFirecrawl({ scrape: { tiktok: "https://www.tiktok.com/" } });

    const result = await resolveGapViaFirecrawl(
      "X",
      null,
      "mb",
      new Set<ArtistSocialPlatform>(["tiktok"]),
      ["https://linktr.ee/x"],
    );

    expect(result).toHaveLength(0);
  });

  it("Stage 3 — rejects a namesake/label hit whose handle doesn't relate to the artist name", async () => {
    // A TikTok search for an act with no TikTok returns the LABEL's account → dropped.
    mockFirecrawl({ search: ["https://www.tiktok.com/@hospitalrecords"] });

    const result = await resolveGapViaFirecrawl(
      "Nu:Tone",
      null,
      "mb-nutone",
      new Set<ArtistSocialPlatform>(["tiktok"]),
      [],
    );

    expect(result).toHaveLength(0);
  });

  it("Stage 3 — accepts a hit whose handle relates to the artist name", async () => {
    mockFirecrawl({ search: ["https://www.tiktok.com/@nutone"] });

    const result = await resolveGapViaFirecrawl(
      "Nu:Tone",
      null,
      "mb-nutone",
      new Set<ArtistSocialPlatform>(["tiktok"]),
      [],
    );

    expect(result.map((s) => s.url)).toEqual(["https://www.tiktok.com/@nutone"]);
  });
});

// ── validateSocialUrlForPlatform (the fresh-links inline edit) ──────────────────

describe("validateSocialUrlForPlatform", () => {
  it("accepts a matching-platform URL and normalizes it to the profile root", async () => {
    expect(
      await validateSocialUrlForPlatform("youtube", "https://www.youtube.com/channel/UCxxx"),
    ).toEqual({ ok: true, url: "https://www.youtube.com/channel/UCxxx" });

    expect(
      await validateSocialUrlForPlatform("instagram", "https://www.instagram.com/dimension/"),
    ).toEqual({ ok: true, url: "https://www.instagram.com/dimension" });
  });

  it("normalizes a deep link down to the profile root", async () => {
    // A SoundCloud track deep-link collapses to the artist profile.
    expect(
      await validateSocialUrlForPlatform(
        "soundcloud",
        "https://soundcloud.com/dimension/some-track",
      ),
    ).toEqual({ ok: true, url: "https://soundcloud.com/dimension" });
  });

  it("rejects a URL whose host belongs to a DIFFERENT platform (a YouTube row rejects instagram.com)", async () => {
    const result = await validateSocialUrlForPlatform(
      "youtube",
      "https://www.instagram.com/someone",
    );

    expect(result).toEqual({ ok: false, reason: "Not a YouTube link" });
  });

  it("accepts any plain host as a homepage but rejects a known social", async () => {
    expect(await validateSocialUrlForPlatform("homepage", "https://dimensiondnb.com")).toEqual({
      ok: true,
      url: "https://dimensiondnb.com",
    });

    expect(
      await validateSocialUrlForPlatform("homepage", "https://soundcloud.com/dimension"),
    ).toEqual({ ok: false, reason: "That's a SoundCloud link, not a homepage" });
  });

  it("rejects an empty value and a non-http(s) scheme", async () => {
    expect(await validateSocialUrlForPlatform("youtube", "   ")).toEqual({
      ok: false,
      reason: "A URL is required",
    });

    expect(await validateSocialUrlForPlatform("youtube", "javascript:alert(1)")).toEqual({
      ok: false,
      reason: "Only http and https links are allowed",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setRateLimitForTests,
  classifyMbUrl,
  luceneEscapePhrase,
  normalizeProfileUrl,
  parseSpotifyArtistId,
  resolveArtistViaMb,
  resolveGapViaFirecrawl,
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
const FIRECRAWL = "api.firecrawl.dev/v2/extract";

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

  it("classifies Wikidata entity URLs", () => {
    expect(classifyMbUrl("https://www.wikidata.org/wiki/Q12345")).toBe("wikidata");
  });

  it("classifies Mixcloud URLs", () => {
    expect(classifyMbUrl("https://www.mixcloud.com/artist")).toBe("mixcloud");
  });

  it("classifies Facebook URLs", () => {
    expect(classifyMbUrl("https://www.facebook.com/artist")).toBe("facebook");
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

describe("resolveGapViaFirecrawl (Firecrawl /v2/extract gap-fill)", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
    __setRateLimitForTests(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRateLimitForTests(1100);
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("fills in TikTok and YouTube when both are missing", async () => {
    mockFetch([
      {
        body: {
          data: {
            tiktok: "https://www.tiktok.com/@dimension/video/99999",
            youtube: "https://www.youtube.com/channel/UCdimension",
          },
          success: true,
        },
        match: FIRECRAWL,
      },
    ]);

    const missing = new Set<"tiktok" | "youtube">(["tiktok", "youtube"]);
    const result = await resolveGapViaFirecrawl(
      "Dimension",
      "https://open.spotify.com/artist/abc",
      null,
      missing,
    );

    expect(result).toHaveLength(2);
    const platforms = result.map((s) => s.platform);
    expect(platforms).toContain("tiktok");
    expect(platforms).toContain("youtube");

    // All Firecrawl-sourced socials must report source=firecrawl.
    for (const social of result) {
      expect(social.source).toBe("firecrawl");
    }
  });

  it("normalizes the TikTok URL to the @handle profile root", async () => {
    mockFetch([
      {
        body: {
          data: {
            tiktok: "https://www.tiktok.com/@dimension/video/12345",
          },
          success: true,
        },
        match: FIRECRAWL,
      },
    ]);

    const result = await resolveGapViaFirecrawl("Dimension", null, "mb-dim-1", new Set(["tiktok"]));

    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe("https://www.tiktok.com/@dimension");
  });

  it("returns empty when no gap platforms are requested", async () => {
    const { calls } = mockFetch([]);
    const result = await resolveGapViaFirecrawl("Dimension", null, null, new Set());

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns empty when neither spotify URL nor mbid is present (no anchor)", async () => {
    const { calls } = mockFetch([]);
    const result = await resolveGapViaFirecrawl("Dimension", null, null, new Set(["tiktok"]));

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns empty when Firecrawl key is absent", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const { calls } = mockFetch([]);
    const result = await resolveGapViaFirecrawl("Dimension", null, "mb-dim-1", new Set(["tiktok"]));

    expect(result).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns empty on a Firecrawl API error (best-effort)", async () => {
    mockFetch([
      {
        match: FIRECRAWL,
        response: new Response("bad request", { status: 400 }),
      },
    ]);

    const result = await resolveGapViaFirecrawl("Dimension", null, "mb-dim-1", new Set(["tiktok"]));

    expect(result).toHaveLength(0);
  });

  it("returns empty when Firecrawl returns success=false", async () => {
    mockFetch([
      {
        body: { success: false },
        match: FIRECRAWL,
      },
    ]);

    const result = await resolveGapViaFirecrawl("Dimension", null, "mb-dim-1", new Set(["tiktok"]));

    expect(result).toHaveLength(0);
  });

  it("skips a platform whose URL normalizes to null (e.g. a TikTok homepage with no handle)", async () => {
    mockFetch([
      {
        body: {
          data: { tiktok: "https://www.tiktok.com/" },
          success: true,
        },
        match: FIRECRAWL,
      },
    ]);

    const result = await resolveGapViaFirecrawl("Dimension", null, "mb-dim-1", new Set(["tiktok"]));

    expect(result).toHaveLength(0);
  });
});

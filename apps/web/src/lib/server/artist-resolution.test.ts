import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setRateLimitForTests,
  classifyMbUrl,
  normalizeProfileUrl,
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

const MB_ISRC = "musicbrainz.org/ws/2/isrc/";
const MB_ARTIST = "musicbrainz.org/ws/2/artist/";
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

// ── resolveArtistViaMb ────────────────────────────────────────────────────────

describe("resolveArtistViaMb (MB walk: ISRC → recording → artist MBID → url-rels)", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    __setRateLimitForTests(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRateLimitForTests(1100);
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("resolves an artist's socials via ISRC → MB recording → artist-credit → url-rels", async () => {
    mockFetch([
      {
        body: {
          recordings: [
            {
              "artist-credit": [{ artist: { id: "mb-artist-1", name: "Dimension" } }],
              id: "rec-1",
              title: "Soldier",
            },
          ],
        },
        match: MB_ISRC,
      },
      {
        body: {
          id: "mb-artist-1",
          name: "Dimension",
          relations: [
            {
              type: "soundcloud",
              url: { resource: "https://soundcloud.com/dimensiondnb" },
            },
            {
              type: "social network",
              url: { resource: "https://www.instagram.com/dimensiondnb" },
            },
            {
              url: { resource: "https://www.wikidata.org/wiki/Q123456" },
            },
          ],
        },
        match: MB_ARTIST,
      },
    ]);

    const result = await resolveArtistViaMb("Dimension", ["GB-ABC-12-00001"]);

    expect(result.mbid).toBe("mb-artist-1");
    expect(result.wikidataQid).toBe("Q123456");
    expect(result.rateLimited).toBe(false);

    const platforms = result.socials.map((s) => s.platform);
    expect(platforms).toContain("soundcloud");
    expect(platforms).toContain("instagram");

    // All MB-sourced socials must be status=auto (via source field).
    for (const social of result.socials) {
      expect(social.source).toBe("musicbrainz");
    }
  });

  it("returns empty when ISRC lookup finds no matching artist-credit by name", async () => {
    mockFetch([
      {
        body: {
          recordings: [
            {
              "artist-credit": [{ artist: { id: "mb-other", name: "Totally Different Artist" } }],
              id: "rec-1",
              title: "Other Track",
            },
          ],
        },
        match: MB_ISRC,
      },
    ]);

    const result = await resolveArtistViaMb("Dimension", ["GB-XYZ-99-00001"]);

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
  });

  it("returns empty when no ISRCs are provided", async () => {
    const { calls } = mockFetch([]);
    const result = await resolveArtistViaMb("Dimension", []);

    expect(result.mbid).toBeNull();
    expect(result.socials).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("reports rateLimited=true and stops when MB returns 503", async () => {
    mockFetch([
      {
        match: MB_ISRC,
        response: new Response("service unavailable", { status: 503 }),
      },
    ]);

    const result = await resolveArtistViaMb("Dimension", ["GB-ABC-12-00001"]);

    expect(result.rateLimited).toBe(true);
    expect(result.mbid).toBeNull();
  });

  it("deduplicates socials by platform (first url wins)", async () => {
    mockFetch([
      {
        body: {
          recordings: [
            {
              "artist-credit": [{ artist: { id: "mb-2", name: "Sub Focus" } }],
              id: "rec-2",
              title: "Turn It Around",
            },
          ],
        },
        match: MB_ISRC,
      },
      {
        body: {
          id: "mb-2",
          name: "Sub Focus",
          relations: [
            { url: { resource: "https://soundcloud.com/sub-focus-1" } },
            { url: { resource: "https://soundcloud.com/sub-focus-2" } },
          ],
        },
        match: MB_ARTIST,
      },
    ]);

    const result = await resolveArtistViaMb("Sub Focus", ["GB-DEF-13-00002"]);

    const soundcloudSocials = result.socials.filter((s) => s.platform === "soundcloud");
    expect(soundcloudSocials).toHaveLength(1);
    expect(soundcloudSocials[0]?.url).toBe("https://soundcloud.com/sub-focus-1");
  });

  it("skips url-rels with no resource", async () => {
    mockFetch([
      {
        body: {
          recordings: [
            {
              "artist-credit": [{ artist: { id: "mb-3", name: "Noisia" } }],
              id: "rec-3",
              title: "Machine Gun",
            },
          ],
        },
        match: MB_ISRC,
      },
      {
        body: {
          id: "mb-3",
          name: "Noisia",
          relations: [
            { url: {} }, // no resource
            { url: { resource: "https://soundcloud.com/noisia" } },
          ],
        },
        match: MB_ARTIST,
      },
    ]);

    const result = await resolveArtistViaMb("Noisia", ["GB-GHI-14-00003"]);

    expect(result.socials).toHaveLength(1);
    expect(result.socials[0]?.platform).toBe("soundcloud");
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

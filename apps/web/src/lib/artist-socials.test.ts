// The client-safe artist-socials surface (lib/artist-socials.ts) is pure and dep-free by
// design — it renders the /admin/artists platform Select and the inline editor's instant
// host-vs-platform gate in CLIENT code, so it must never drag the server module in. These
// tests pin the two guards the render/Save path leans on (`isHttpUrl`, `urlHostMatchesPlatform`)
// and the platform vocabulary. The SERVER stays authoritative (artist-resolution +
// artists.assertHttpUrl); this layer is only the cheap pre-round-trip check.
import { describe, expect, it } from "vitest";
import {
  ARTIST_SOCIAL_PLATFORMS,
  type ArtistSocialPlatform,
  isHttpUrl,
  urlHostMatchesPlatform,
} from "./artist-socials";

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://open.spotify.com/artist/abc")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(isHttpUrl("  https://example.com  ")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("mailto:a@b.com")).toBe(false);
  });

  it("rejects unparseable strings and the empty string", () => {
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false); // no scheme
  });
});

describe("ARTIST_SOCIAL_PLATFORMS", () => {
  it("has no duplicate platform keys", () => {
    expect(new Set(ARTIST_SOCIAL_PLATFORMS).size).toBe(ARTIST_SOCIAL_PLATFORMS.length);
  });

  it("leads with spotify (the operator's add-platform Select order)", () => {
    expect(ARTIST_SOCIAL_PLATFORMS[0]).toBe("spotify");
  });

  it("includes homepage as the catch-all platform", () => {
    expect(ARTIST_SOCIAL_PLATFORMS).toContain("homepage");
  });
});

describe("urlHostMatchesPlatform", () => {
  const cases: Array<[ArtistSocialPlatform, string]> = [
    ["spotify", "https://open.spotify.com/artist/abc"],
    ["youtube", "https://youtube.com/@artist"],
    ["youtube", "https://youtu.be/abc"],
    ["mixcloud", "https://www.mixcloud.com/artist/"],
    ["soundcloud", "https://soundcloud.com/artist"],
    ["instagram", "https://instagram.com/artist"],
    ["tiktok", "https://www.tiktok.com/@artist"],
    ["beatport", "https://www.beatport.com/artist/x/1"],
    ["twitter", "https://x.com/artist"],
    ["twitter", "https://twitter.com/artist"],
    ["facebook", "https://facebook.com/artist"],
    ["twitch", "https://twitch.tv/artist"],
  ];

  it.each(cases)("accepts a matching host for %s", (platform, url) => {
    expect(urlHostMatchesPlatform(platform, url)).toBe(true);
  });

  it("strips a www./music. prefix before matching the host", () => {
    expect(urlHostMatchesPlatform("spotify", "https://open.spotify.com/artist/abc")).toBe(true);
    // music.youtube.com → youtube.com after the prefix strip
    expect(urlHostMatchesPlatform("youtube", "https://music.youtube.com/channel/abc")).toBe(true);
  });

  it("matches a bandcamp subdomain (artist.bandcamp.com)", () => {
    expect(urlHostMatchesPlatform("bandcamp", "https://artist.bandcamp.com/")).toBe(true);
  });

  it("rejects a plainly-wrong paste — an instagram URL in a youtube row", () => {
    expect(urlHostMatchesPlatform("youtube", "https://instagram.com/artist")).toBe(false);
  });

  it("is loose: an unrecognized host defers to the server (passes)", () => {
    expect(urlHostMatchesPlatform("spotify", "https://some-unknown-host.example/artist")).toBe(
      true,
    );
  });

  it("treats an unparseable URL as unrecognized (defers to the server)", () => {
    expect(urlHostMatchesPlatform("spotify", "not a url")).toBe(true);
  });

  it("homepage accepts any host that is NOT a recognized social", () => {
    expect(urlHostMatchesPlatform("homepage", "https://artist-official-site.example")).toBe(true);
  });

  it("homepage rejects a recognized social host (that link belongs in its own row)", () => {
    expect(urlHostMatchesPlatform("homepage", "https://instagram.com/artist")).toBe(false);
  });
});

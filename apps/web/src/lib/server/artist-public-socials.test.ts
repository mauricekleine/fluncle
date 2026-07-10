import { beforeEach, describe, expect, it, vi } from "vitest";

// The public socials render boundary (`getPublicArtistSocials`): only auto/confirmed
// links surface, and they sort the artist's own homepage/website FIRST, then every
// other platform alphabetically by key. The DB is mocked with a row-returning
// `execute`, so a test never hits a real database.

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

const { getPublicArtistSocials } = await import("./artists");

beforeEach(() => {
  execute.mockReset();
});

describe("getPublicArtistSocials — the public render boundary", () => {
  it("puts the homepage first, then the rest alphabetically by platform", async () => {
    // Deliberately shuffled input, mixing statuses; the query returns every row and
    // the boundary orders + filters them.
    execute.mockResolvedValue({
      rows: [
        { platform: "youtube", status: "auto", url: "https://youtube.com/@x" },
        { platform: "homepage", status: "confirmed", url: "https://x.example" },
        { platform: "spotify", status: "auto", url: "https://open.spotify.com/artist/x" },
        { platform: "bandcamp", status: "confirmed", url: "https://x.bandcamp.com" },
        { platform: "instagram", status: "auto", url: "https://instagram.com/x" },
      ],
    });

    const links = await getPublicArtistSocials("artist-x");

    expect(links.map((link) => link.platform)).toEqual([
      "homepage",
      "bandcamp",
      "instagram",
      "spotify",
      "youtube",
    ]);
  });

  it("keeps alphabetical order when no homepage exists", async () => {
    execute.mockResolvedValue({
      rows: [
        { platform: "tiktok", status: "auto", url: "https://tiktok.com/@x" },
        { platform: "beatport", status: "auto", url: "https://beatport.com/artist/x/1" },
        { platform: "soundcloud", status: "confirmed", url: "https://soundcloud.com/x" },
      ],
    });

    const links = await getPublicArtistSocials("artist-x");

    expect(links.map((link) => link.platform)).toEqual(["beatport", "soundcloud", "tiktok"]);
  });

  it("drops candidate + unknown-platform rows before sorting", async () => {
    execute.mockResolvedValue({
      rows: [
        { platform: "instagram", status: "candidate", url: "https://instagram.com/x" },
        { platform: "myspace", status: "auto", url: "https://myspace.com/x" },
        { platform: "spotify", status: "auto", url: "https://open.spotify.com/artist/x" },
        { platform: "homepage", status: "auto", url: "" },
      ],
    });

    const links = await getPublicArtistSocials("artist-x");

    // Only the auto Spotify row survives (candidate IG, unknown Myspace, empty-url
    // homepage all dropped).
    expect(links.map((link) => link.platform)).toEqual(["spotify"]);
  });
});

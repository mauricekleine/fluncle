import { describe, expect, it } from "vitest";
import { mixPlaylistJsonLd } from "./mix-set";

const PAGE = "https://www.fluncle.com/mix?set=a.b";

describe("mixPlaylistJsonLd", () => {
  it("describes the chain as an ordered MusicPlaylist on the page URL", () => {
    const jsonLd = mixPlaylistJsonLd(
      [
        {
          artists: ["Calibre", "DRS"],
          spotifyUrl: "https://open.spotify.com/track/a",
          title: "Even If",
        },
        { artists: ["Alix Perez"], title: "Forsaken" },
      ],
      PAGE,
    );

    expect(jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "MusicPlaylist",
      name: "A Fluncle mix",
      numTracks: 2,
      track: [
        {
          "@type": "MusicRecording",
          byArtist: [
            { "@type": "MusicGroup", name: "Calibre" },
            { "@type": "MusicGroup", name: "DRS" },
          ],
          name: "Even If",
          position: 1,
          url: "https://open.spotify.com/track/a",
        },
        {
          "@type": "MusicRecording",
          byArtist: [{ "@type": "MusicGroup", name: "Alix Perez" }],
          name: "Forsaken",
          position: 2,
        },
      ],
      url: PAGE,
    });
  });

  it("leaves the track url out when the recording has no Spotify link", () => {
    const jsonLd = mixPlaylistJsonLd([{ artists: [], spotifyUrl: "", title: "Untitled" }], PAGE);
    const [track] = jsonLd.track as Record<string, unknown>[];

    expect(track).not.toHaveProperty("url");
    expect(track?.byArtist).toEqual([]);
  });
});

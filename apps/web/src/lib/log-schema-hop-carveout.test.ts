import { describe, expect, it } from "vitest";
import {
  artistBreadcrumbsJsonLd,
  breadcrumbsJsonLd,
  mixtapeAlbumJsonLd,
  musicAlbumJsonLd,
  musicGroupJsonLd,
  musicPlaylistJsonLd,
  musicRecordingJsonLd,
  observationAudioObjectJsonLd,
  recordLabelJsonLd,
} from "./log-schema";

const track = {
  addedAt: "2026-06-03T18:21:00.000Z",
  album: "Nobody Else (1991 Remix)",
  appleMusicUrl: "https://music.apple.com/us/album/nobody-else/123?i=456",
  artists: ["Axwell", "1991"],
  discogsReleaseUrl: "https://www.discogs.com/release/12345",
  durationMs: 215_000,
  isrc: "GBKCF1900759",
  logId: "004.7.2I",
  mbRecordingId: "b9a1e6f0-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
  spotifyUrl: "https://open.spotify.com/track/abc",
  tiktokUrl: "https://www.tiktok.com/@fluncle/video/1",
  title: "Nobody Else - 1991 Remix",
};

function urlsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return value.startsWith("http") ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(urlsIn);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(urlsIn);
  }

  return [];
}

describe("JSON-LD keeps the RAW Spotify link, never the hop", () => {
  const documents: Record<string, Record<string, unknown>> = {
    artistBreadcrumbs: artistBreadcrumbsJsonLd("Calibre"),
    breadcrumbs: breadcrumbsJsonLd("004.7.2I"),
    mixtapeAlbum: mixtapeAlbumJsonLd({
      addedAt: "2026-06-03T18:21:00.000Z",
      externalUrls: { mixcloud: "https://www.mixcloud.com/fluncle/one/" },
      logId: "019.F.1A",
      members: [{ artists: ["Calibre"], logId: "004.7.2I", title: "Nobody Else" }],
      sequenceNumber: 1,
      title: "Mixtape No. 1",
    } as never),
    musicAlbum: musicAlbumJsonLd({
      artists: [{ name: "Calibre", slug: "calibre" }],
      name: "Nobody Else",
      slug: "nobody-else",
      tracks: [track],
    } as never),
    musicGroup: musicGroupJsonLd(
      {
        name: "Calibre",
        slug: "calibre",
        socials: ["https://open.spotify.com/artist/abc"],
        spotifyUrl: "https://open.spotify.com/artist/abc",
      } as never,
      [{ artists: ["Calibre"], logId: "004.7.2I", title: "Nobody Else" }] as never,
    ),
    musicPlaylist: musicPlaylistJsonLd({ name: "Deep sector", slug: "deep-sector" }, [
      { artists: ["Calibre"], logId: "004.7.2I", title: "Nobody Else" },
    ] as never),
    musicRecording: musicRecordingJsonLd(track, "https://img/cover.jpg"),
    observationAudioObject: observationAudioObjectJsonLd({
      ...track,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1765534200000",
      observationDurationMs: 34_000,
      observationGeneratedAt: "2026-06-12T09:30:00.000Z",
    }),
    recordLabel: recordLabelJsonLd({
      artists: [{ name: "Calibre", slug: "calibre" }],
      name: "Signature",
      slug: "signature",
      tracks: [track],
    } as never),
  };

  for (const [name, document] of Object.entries(documents)) {
    it(`${name} emits no fluncle.com/out/ URL`, () => {
      const hops = urlsIn(document).filter((url) => url.includes("/out/"));

      expect(hops, `${name} routed an identity assertion through the Spotify hop`).toEqual([]);
    });
  }

  it("still asserts the RAW open.spotify.com link on the recording", () => {
    expect(urlsIn(documents.musicRecording)).toContain("https://open.spotify.com/track/abc");
  });
});

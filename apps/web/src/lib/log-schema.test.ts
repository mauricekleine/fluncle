import { describe, expect, it } from "vitest";
import { definitionalProse } from "./log-prose";
import {
  breadcrumbsJsonLd,
  mixtapeAlbumJsonLd,
  musicRecordingJsonLd,
  videoObjectJsonLd,
} from "./log-schema";

const track = {
  addedAt: "2026-06-03T18:21:00.000Z",
  album: "Nobody Else (1991 Remix)",
  artists: ["Axwell", "1991"],
  discogsReleaseUrl: "https://www.discogs.com/release/12345",
  durationMs: 215_000,
  isrc: "GBKCF1900759",
  logId: "004.7.2I",
  spotifyUrl: "https://open.spotify.com/track/abc",
  tiktokUrl: "https://www.tiktok.com/@fluncle/video/1",
  title: "Nobody Else - 1991 Remix",
};

describe("musicRecordingJsonLd (the log page schema)", () => {
  const jsonLd = musicRecordingJsonLd(track, "https://img/cover.jpg");

  it("is a MusicRecording with the coordinate in BOTH identifier forms", () => {
    expect(jsonLd["@type"]).toBe("MusicRecording");
    expect(jsonLd.identifier).toEqual([
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: "004.7.2I" },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: "fluncle://004.7.2I" },
    ]);
  });

  it("mirrors the visible definitional prose verbatim", () => {
    expect(jsonLd.description).toBe(definitionalProse(track));
    expect(jsonLd.description).toContain("004.7.2I is Fluncle's Log ID for");
    expect(jsonLd.description).toContain("fluncle://004.7.2I");
  });

  it("carries the Found date as datePublished and an ISO-8601 duration", () => {
    expect(jsonLd.datePublished).toBe("2026-06-03");
    expect(jsonLd.duration).toBe("PT3M35S");
  });

  it("includes isrcCode, inAlbum, and the TikTok + Discogs sameAs when present", () => {
    expect(jsonLd.isrcCode).toBe("GBKCF1900759");
    expect(jsonLd.inAlbum).toEqual({ "@type": "MusicAlbum", name: track.album });
    expect(jsonLd.sameAs).toEqual([track.spotifyUrl, track.tiktokUrl, track.discogsReleaseUrl]);
    expect(jsonLd.url).toBe("https://www.fluncle.com/log/004.7.2I");
  });

  it("omits the optional fields when the finding lacks them (the degraded render)", () => {
    const bare = musicRecordingJsonLd(
      {
        addedAt: track.addedAt,
        artists: track.artists,
        durationMs: track.durationMs,
        logId: track.logId,
        spotifyUrl: track.spotifyUrl,
        title: track.title,
      },
      "https://img/cover.jpg",
    );

    expect(bare).not.toHaveProperty("isrcCode");
    expect(bare).not.toHaveProperty("inAlbum");
    expect(bare.sameAs).toEqual([track.spotifyUrl]);
  });
});

describe("videoObjectJsonLd (the finding's video schema)", () => {
  const jsonLd = videoObjectJsonLd(track, {
    contentUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
    thumbnailUrl: "https://img/cover.jpg",
    uploadDate: "2026-06-12T09:30:00.000Z",
  });

  it("is a VideoObject pointing at the footage, named Artist — Title", () => {
    expect(jsonLd["@type"]).toBe("VideoObject");
    expect(jsonLd.contentUrl).toBe("https://found.fluncle.com/004.7.2I/footage.mp4");
    expect(jsonLd.thumbnailUrl).toBe("https://img/cover.jpg");
    expect(jsonLd.name).toBe("Axwell, 1991 — Nobody Else - 1991 Remix");
    expect(jsonLd.url).toBe("https://www.fluncle.com/log/004.7.2I");
  });

  it("mirrors the visible prose and dates the upload from the freshest stamp", () => {
    expect(jsonLd.description).toBe(definitionalProse(track));
    // A full ISO 8601 datetime WITH a timezone (Google's VideoObject requirement) —
    // not a bare date, which trips GSC's "invalid datetime"/"missing a timezone".
    expect(jsonLd.uploadDate).toBe("2026-06-12T09:30:00.000Z");
  });

  it("normalizes a bare-date uploadDate to a zoned datetime", () => {
    const dateOnly = videoObjectJsonLd(track, {
      contentUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
      thumbnailUrl: "https://img/cover.jpg",
      uploadDate: "2026-06-29",
    });

    expect(dateOnly.uploadDate).toBe("2026-06-29T00:00:00.000Z");
  });
});

describe("breadcrumbsJsonLd", () => {
  it("walks Fluncle → The log → the coordinate", () => {
    const jsonLd = breadcrumbsJsonLd("004.7.2I") as { itemListElement: Array<{ name: string }> };

    expect(jsonLd.itemListElement.map((item) => item.name)).toEqual([
      "Fluncle",
      "The log",
      "004.7.2I",
    ]);
  });
});

describe("mixtapeAlbumJsonLd", () => {
  it("renders a DJMixAlbum-shaped MusicAlbum with member log URLs", () => {
    const jsonLd = mixtapeAlbumJsonLd({
      addedAt: "2026-06-18T21:00:00.000Z",
      artists: ["Fluncle"],
      durationMs: 3_480_000,
      externalUrls: { mixcloud: "https://mixcloud.com/fluncle/test" },
      logId: "019.F.1A",
      memberCount: 1,
      members: [
        {
          ...track,
          addedToSpotify: true,
          enrichmentStatus: "done",
          postedToTelegram: true,
          trackId: "abc",
        },
      ],
      note: "A checkpoint in the archive.",
      status: "draft",
      title: "Checkpoint one",
      type: "mixtape",
    });

    expect(jsonLd["@type"]).toBe("MusicAlbum");
    expect(jsonLd.albumProductionType).toBe("https://schema.org/DJMixAlbum");
    expect(jsonLd.identifier).toEqual([
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: "019.F.1A" },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: "fluncle://019.F.1A" },
    ]);
    expect(jsonLd.url).toBe("https://www.fluncle.com/log/019.F.1A");
    expect(jsonLd.track).toMatchObject({
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          item: { url: "https://www.fluncle.com/log/004.7.2I" },
          position: 1,
        },
      ],
    });
  });
});

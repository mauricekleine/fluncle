import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "./json-ld";
import { definitionalProse } from "./log-prose";
import {
  artistBreadcrumbsJsonLd,
  breadcrumbsJsonLd,
  galaxyBreadcrumbsJsonLd,
  mixtapeAlbumJsonLd,
  musicGroupJsonLd,
  musicPlaylistJsonLd,
  musicRecordingJsonLd,
  videoObjectJsonLd,
} from "./log-schema";
import { fold } from "./server/track-match";

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

  it("leaves byArtist id-less when no artistSlugs are supplied", () => {
    expect(jsonLd.byArtist).toEqual([
      { "@type": "MusicGroup", name: "Axwell" },
      { "@type": "MusicGroup", name: "1991" },
    ]);
  });

  it("stamps @id on the byArtist node for a resolved artist (the cross-page graph)", () => {
    const stamped = musicRecordingJsonLd(
      { ...track, artistSlugs: { "1991": "1991" } },
      "https://img/cover.jpg",
    );

    expect(stamped.byArtist).toEqual([
      { "@type": "MusicGroup", name: "Axwell" },
      { "@id": "https://www.fluncle.com/artist/1991", "@type": "MusicGroup", name: "1991" },
    ]);
  });

  it("carries measured tempo + key as a recordingOf MusicComposition when both are present", () => {
    const measured = musicRecordingJsonLd(
      { ...track, bpm: 174.3, key: "F minor" },
      "https://img/cover.jpg",
    );

    // Tempo has no native schema.org property → additionalProperty PropertyValue,
    // rounded to match the visible BPM. Key rides the native `musicalKey` (Text).
    expect(measured.recordingOf).toEqual({
      "@type": "MusicComposition",
      additionalProperty: {
        "@type": "PropertyValue",
        name: "tempo",
        unitText: "BPM",
        value: 174,
      },
      musicalKey: "F minor",
      name: track.title,
    });
  });

  it("emits tempo only when the key is below the confidence floor (bpm present, key NULL)", () => {
    const tempoOnly = musicRecordingJsonLd({ ...track, bpm: 172 }, "https://img/cover.jpg");
    const composition = tempoOnly.recordingOf as Record<string, unknown>;

    expect(composition.additionalProperty).toEqual({
      "@type": "PropertyValue",
      name: "tempo",
      unitText: "BPM",
      value: 172,
    });
    // A NULL key is below the DSP floor — say nothing, never a guessed value.
    expect(composition).not.toHaveProperty("musicalKey");
  });

  it("emits key only when the tempo is absent (key present, bpm NULL)", () => {
    const keyOnly = musicRecordingJsonLd({ ...track, key: "A minor" }, "https://img/cover.jpg");
    const composition = keyOnly.recordingOf as Record<string, unknown>;

    expect(composition.musicalKey).toBe("A minor");
    expect(composition).not.toHaveProperty("additionalProperty");
  });

  it("omits recordingOf entirely when the finding carries neither tempo nor key", () => {
    // The base fixture has no bpm/key — the un-enriched finding says nothing.
    expect(jsonLd).not.toHaveProperty("recordingOf");
  });

  it("stamps @id on a case/accent-variant display name (folded match, not exact)", () => {
    // The slug map is keyed by the folded canonical name; the finding's display
    // name drifted (accent + casing). An exact-name lookup would silently drop the
    // link + the @id — the folded lookup still reconciles it.
    const drifted = musicRecordingJsonLd(
      { ...track, artistSlugs: { [fold("Axwell")]: "axwell" }, artists: ["ÁXWELL", "1991"] },
      "https://img/cover.jpg",
    );

    expect(drifted.byArtist).toEqual([
      { "@id": "https://www.fluncle.com/artist/axwell", "@type": "MusicGroup", name: "ÁXWELL" },
      { "@type": "MusicGroup", name: "1991" },
    ]);
  });
});

describe("musicPlaylistJsonLd (the galaxy lens schema)", () => {
  const jsonLd = musicPlaylistJsonLd({ name: "The Liquid Deep", slug: "the-liquid-deep" }, [
    { artists: ["Calibre"], logId: "004.7.2I", title: "Mr Majestic" },
    { artists: ["LSB", "DRS"], logId: "011.6.8K", title: "Missing You" },
  ]);

  it("is a MusicPlaylist named for the galaxy, with numTracks + the canonical URL", () => {
    expect(jsonLd["@type"]).toBe("MusicPlaylist");
    expect(jsonLd.name).toBe("The Liquid Deep · Fluncle's galaxies");
    expect(jsonLd.numTracks).toBe(2);
    expect(jsonLd.url).toBe("https://www.fluncle.com/galaxies/the-liquid-deep");
  });

  it("carries the members as MusicRecording refs by /log URL, in order (core-first)", () => {
    const track = jsonLd.track as {
      itemListElement: Array<{ item: { url: string }; position: number }>;
    };

    expect(track.itemListElement).toHaveLength(2);
    expect(track.itemListElement[0]?.position).toBe(1);
    expect(track.itemListElement[0]?.item.url).toBe("https://www.fluncle.com/log/004.7.2I");
    expect(track.itemListElement[1]?.item.url).toBe("https://www.fluncle.com/log/011.6.8K");
  });

  it("breadcrumbs Fluncle → Galaxies → the galaxy name", () => {
    const crumbs = galaxyBreadcrumbsJsonLd("The Liquid Deep").itemListElement as Array<{
      name: string;
    }>;

    expect(crumbs.map((c) => c.name)).toEqual(["Fluncle", "Galaxies", "The Liquid Deep"]);
  });
});

describe("musicGroupJsonLd (the artist page schema)", () => {
  const findings = [
    { artists: ["Dimension"], logId: "010.1.1A", title: "UK" },
    { artists: ["Dimension", "Sub Focus"], logId: "011.2.3B", title: "Desire" },
  ];
  const jsonLd = musicGroupJsonLd(
    {
      imageUrl: "https://img/dimension.jpg",
      mbid: "mbid-123",
      name: "Dimension",
      slug: "dimension",
      socials: ["https://open.spotify.com/artist/abc", "https://instagram.com/dimensiondnb"],
      spotifyUrl: "https://open.spotify.com/artist/abc",
      wikidataQid: "Q123",
    },
    findings,
  );

  it("is a MusicGroup carrying its own @id (twin of the /log byArtist node)", () => {
    expect(jsonLd["@type"]).toBe("MusicGroup");
    expect(jsonLd["@id"]).toBe("https://www.fluncle.com/artist/dimension");
    expect(jsonLd.url).toBe("https://www.fluncle.com/artist/dimension");
    expect(jsonLd.genre).toBe("Drum and Bass");
    expect(jsonLd.image).toBe("https://img/dimension.jpg");
  });

  it("orders sameAs Wikidata > MusicBrainz > Spotify > socials, de-duplicated", () => {
    expect(jsonLd.sameAs).toEqual([
      "https://www.wikidata.org/wiki/Q123",
      "https://musicbrainz.org/artist/mbid-123",
      "https://open.spotify.com/artist/abc",
      "https://instagram.com/dimensiondnb",
    ]);
  });

  it("emits the findings as a MusicRecording ItemList with log URLs", () => {
    expect(jsonLd.track).toMatchObject({
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          item: { "@type": "MusicRecording", url: "https://www.fluncle.com/log/010.1.1A" },
          position: 1,
        },
        {
          "@type": "ListItem",
          item: { url: "https://www.fluncle.com/log/011.2.3B" },
          position: 2,
        },
      ],
    });
  });

  it("stamps the artist's @id on the nested byArtist nodes, leaving co-artists id-less", () => {
    const list = jsonLd.track as {
      itemListElement: Array<{ item: { byArtist: unknown } }>;
    };

    // Every finding on the page credits this artist, so each nested MusicRecording
    // reconciles back to the artist's @id (the free graph reconciliation, RFC §3).
    expect(list.itemListElement[0]?.item.byArtist).toEqual([
      {
        "@id": "https://www.fluncle.com/artist/dimension",
        "@type": "MusicGroup",
        name: "Dimension",
      },
    ]);
    // A co-artist with no slug on this page stays a bare, id-less MusicGroup.
    expect(list.itemListElement[1]?.item.byArtist).toEqual([
      {
        "@id": "https://www.fluncle.com/artist/dimension",
        "@type": "MusicGroup",
        name: "Dimension",
      },
      { "@type": "MusicGroup", name: "Sub Focus" },
    ]);
  });

  it("omits sameAs entirely when there are no anchors", () => {
    const bare = musicGroupJsonLd(
      { imageUrl: "https://img/x.jpg", name: "Nobody", slug: "nobody", socials: [] },
      [],
    );

    expect(bare).not.toHaveProperty("sameAs");
  });

  it("is XSS-safe through the serialize sink (a </script> in a name can't break out)", () => {
    const evil = musicGroupJsonLd(
      {
        imageUrl: "https://img/x.jpg",
        name: "Bad</script><script>alert(1)</script>",
        slug: "bad",
        socials: [],
      },
      [{ artists: ["Bad</script>"], logId: "001.1.1A", title: "Pwn</script>" }],
    );

    expect(serializeJsonLd(evil)).not.toContain("</script>");
    expect(serializeJsonLd(evil)).toContain("\\u003c/script\\u003e");
  });
});

describe("artistBreadcrumbsJsonLd", () => {
  it("walks Fluncle → Artists → the artist name", () => {
    const jsonLd = artistBreadcrumbsJsonLd("Dimension") as {
      itemListElement: Array<{ name: string }>;
    };

    expect(jsonLd.itemListElement.map((item) => item.name)).toEqual([
      "Fluncle",
      "Artists",
      "Dimension",
    ]);
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
      status: "published",
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

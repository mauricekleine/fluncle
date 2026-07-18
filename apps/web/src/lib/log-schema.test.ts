import { describe, expect, it } from "vitest";
import { fluncleEntityId } from "./fluncle-links";
import { serializeJsonLd } from "./json-ld";
import { definitionalProse } from "./log-prose";
import {
  artistBreadcrumbsJsonLd,
  breadcrumbsJsonLd,
  galaxyBreadcrumbsJsonLd,
  mixtapeAlbumJsonLd,
  musicAlbumJsonLd,
  musicGroupJsonLd,
  musicPlaylistJsonLd,
  musicRecordingJsonLd,
  recordLabelJsonLd,
  videoObjectJsonLd,
} from "./log-schema";
import { fold } from "./server/track-match";

const track = {
  addedAt: "2026-06-03T18:21:00.000Z",
  album: "Nobody Else (1991 Remix)",
  appleMusicUrl: "https://music.apple.com/us/album/nobody-else/123?i=456",
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

  it("includes isrcCode, inAlbum, and the Apple Music + TikTok + Discogs sameAs when present", () => {
    expect(jsonLd.isrcCode).toBe("GBKCF1900759");
    expect(jsonLd.inAlbum).toEqual({ "@type": "MusicAlbum", name: track.album });
    expect(jsonLd.sameAs).toEqual([
      track.spotifyUrl,
      track.appleMusicUrl,
      track.tiktokUrl,
      track.discogsReleaseUrl,
    ]);
    expect(jsonLd.url).toBe("https://www.fluncle.com/log/004.7.2I");
  });

  it("omits recordLabel when the finding carries no label entity", () => {
    // The base fixture has no label/labelSlug — no recording→label edge to draw.
    expect(jsonLd).not.toHaveProperty("recordLabel");
  });

  it("closes the recording→label edge (recordLabel → the label page's Organization @id)", () => {
    const withLabel = musicRecordingJsonLd(
      { ...track, label: "Hospital Records", labelSlug: "hospital-records" },
      "https://img/cover.jpg",
    );

    expect(withLabel.recordLabel).toEqual({
      "@id": "https://www.fluncle.com/label/hospital-records#organization",
      "@type": "Organization",
      name: "Hospital Records",
      url: "https://www.fluncle.com/label/hospital-records",
    });
  });

  it("omits recordLabel when the label has no resolved /label page (a bare string is silent)", () => {
    // A label string with no entity has no `@id` to point at — the honest degrade is silence.
    const bareLabel = musicRecordingJsonLd(
      { ...track, label: "Some Bootleg", labelSlug: undefined },
      "https://img/cover.jpg",
    );

    expect(bareLabel).not.toHaveProperty("recordLabel");
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

  it("carries the factual bio as description only when one is authored", () => {
    // No bio ⇒ no description key at all (never `description: null`).
    expect(jsonLd).not.toHaveProperty("description");

    const withBio = musicGroupJsonLd(
      {
        bio: "Dimension is a British drum and bass producer and DJ.",
        imageUrl: "https://img/dimension.jpg",
        name: "Dimension",
        slug: "dimension",
        socials: [],
      },
      [],
    );

    expect(withBio.description).toBe("Dimension is a British drum and bass producer and DJ.");
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

  it("is created + published BY the one canonical Fluncle entity node (@id)", () => {
    expect(jsonLd.creator).toEqual({ "@id": fluncleEntityId });
    expect(jsonLd.publisher).toEqual({ "@id": fluncleEntityId });
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

describe("recordLabelJsonLd (the label page schema — U2a alternateName)", () => {
  const base = {
    artists: [{ name: "Artist", slug: "artist" }],
    name: "Medschool",
    slug: "medschool",
    tracks: [],
  };

  function organizationOf(input: Parameters<typeof recordLabelJsonLd>[0]) {
    return (recordLabelJsonLd(input) as { about: Record<string, unknown> }).about;
  }

  it("omits alternateName entirely when the label carries no confirmed aliases", () => {
    expect(organizationOf(base)).not.toHaveProperty("alternateName");
    // No aliases ⇒ byte-identical to the pre-U2a shape.
    expect(organizationOf({ ...base, alternateNames: [] })).not.toHaveProperty("alternateName");
  });

  it("emits a single confirmed alias as a scalar alternateName", () => {
    expect(organizationOf({ ...base, alternateNames: ["Med School Recordings"] })).toMatchObject({
      "@type": "Organization",
      alternateName: "Med School Recordings",
      name: "Medschool",
    });
  });

  it("emits several confirmed aliases as an alternateName array", () => {
    expect(
      organizationOf({ ...base, alternateNames: ["Med School", "Med School Recordings"] })
        .alternateName,
    ).toEqual(["Med School", "Med School Recordings"]);
  });

  it("carries the factual bio as the Organization's description only when one is authored", () => {
    // No bio ⇒ the Organization node has no description key at all (never `description: null`).
    expect(organizationOf(base)).not.toHaveProperty("description");

    expect(
      organizationOf({ ...base, bio: "Medschool is Hospital Records' sister label." }).description,
    ).toBe("Medschool is Hospital Records' sister label.");
  });

  it("emits the Organization's sameAs from the MusicBrainz + Discogs ids, and omits it when absent", () => {
    // No anchors ⇒ no sameAs key at all.
    expect(organizationOf(base)).not.toHaveProperty("sameAs");

    expect(organizationOf({ ...base, discogsLabelId: 1111, mbLabelId: "mbid-med" }).sameAs).toEqual(
      ["https://musicbrainz.org/label/mbid-med", "https://www.discogs.com/label/1111"],
    );

    // Only one anchor present ⇒ a one-element sameAs, not a hole.
    expect(organizationOf({ ...base, mbLabelId: "mbid-med" }).sameAs).toEqual([
      "https://musicbrainz.org/label/mbid-med",
    ]);
  });

  it("carries the label's own logo as the Organization's logo only when resolved", () => {
    expect(organizationOf(base)).not.toHaveProperty("logo");

    expect(organizationOf({ ...base, logoImageUrl: "https://img/medschool-logo.png" }).logo).toBe(
      "https://img/medschool-logo.png",
    );
  });
});

describe("musicAlbumJsonLd (the album page schema)", () => {
  const base = {
    artists: [{ name: "Netsky", slug: "netsky" }],
    name: "Colours in the Dark",
    slug: "colours-in-the-dark",
    tracks: [],
  };

  it("is a MusicAlbum with the credited artist + genre", () => {
    const jsonLd = musicAlbumJsonLd(base);
    expect(jsonLd["@type"]).toBe("MusicAlbum");
    expect(jsonLd.genre).toBe("Drum and Bass");
  });

  it("carries the factual bio as description only when one is authored", () => {
    // No bio ⇒ no description key at all (never `description: null`).
    expect(musicAlbumJsonLd(base)).not.toHaveProperty("description");

    expect(
      musicAlbumJsonLd({
        ...base,
        bio: "Colours in the Dark is the third studio album by Netsky, released in 2019.",
      }).description,
    ).toBe("Colours in the Dark is the third studio album by Netsky, released in 2019.");
  });

  it("emits datePublished, gtin13, and the MusicBrainz sameAs when the record carries them", () => {
    const jsonLd = musicAlbumJsonLd({
      ...base,
      releaseDate: "2019-08-02",
      releaseGroupMbid: "rg-mbid-123",
      upc: "0123456789012",
    });

    expect(jsonLd.datePublished).toBe("2019-08-02");
    expect(jsonLd.gtin13).toBe("0123456789012");
    expect(jsonLd.sameAs).toEqual(["https://musicbrainz.org/release-group/rg-mbid-123"]);
  });

  it("omits datePublished, gtin13, and sameAs when the record carries none", () => {
    const jsonLd = musicAlbumJsonLd(base);

    expect(jsonLd).not.toHaveProperty("datePublished");
    expect(jsonLd).not.toHaveProperty("gtin13");
    expect(jsonLd).not.toHaveProperty("sameAs");
  });

  it("carries each finding's duration, ISRC, and datePublished on its track MusicRecording (G1)", () => {
    const jsonLd = musicAlbumJsonLd({
      ...base,
      tracks: [
        {
          artists: ["Netsky"],
          durationMs: 215_000,
          isrc: "GBKCF1900759",
          logId: "004.7.2I",
          releaseDate: "2019-08-02",
          title: "Nobody Else",
        },
        // A quieter catalogue row carries none of the per-track facts — it stays spare.
        { artists: ["Netsky"], spotifyUrl: "https://open.spotify.com/track/x", title: "Deep cut" },
      ],
    });

    const list = jsonLd.track as {
      itemListElement: Array<{ item: Record<string, unknown> }>;
    };
    const finding = list.itemListElement[0]?.item;
    const catalogue = list.itemListElement[1]?.item;

    expect(finding).toMatchObject({
      datePublished: "2019-08-02",
      duration: "PT3M35S",
      isrcCode: "GBKCF1900759",
      url: "https://www.fluncle.com/log/004.7.2I",
    });
    expect(catalogue).not.toHaveProperty("duration");
    expect(catalogue).not.toHaveProperty("isrcCode");
    expect(catalogue).not.toHaveProperty("datePublished");
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
    // The mix is by — and published by — the ONE canonical entity node (@id), never a dangling
    // /about Person that reads as a different thing.
    expect(jsonLd.byArtist).toEqual({ "@id": fluncleEntityId, "@type": "Person", name: "Fluncle" });
    expect(jsonLd.publisher).toEqual({ "@id": fluncleEntityId });
    // numTracks counts the renderable members (those with a /log coordinate).
    expect(jsonLd.numTracks).toBe(1);
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
    // No recordedAt on this fixture ⇒ no datePublished key (never a null).
    expect(jsonLd).not.toHaveProperty("datePublished");
  });

  it("dates the album from recordedAt (the day the set was recorded)", () => {
    const jsonLd = mixtapeAlbumJsonLd({
      addedAt: "2026-06-18T21:00:00.000Z",
      artists: ["Fluncle"],
      externalUrls: {},
      logId: "019.F.1A",
      memberCount: 0,
      members: [],
      recordedAt: "2026-06-14T22:00:00.000Z",
      status: "published",
      title: "Checkpoint one",
      type: "mixtape",
    });

    expect(jsonLd.datePublished).toBe("2026-06-14");
    // An empty tracklist ⇒ numTracks 0.
    expect(jsonLd.numTracks).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { fluncleEntityId } from "./fluncle-links";
import { serializeJsonLd } from "./json-ld";
import { definitionalProse } from "./log-prose";
import {
  artistBreadcrumbsJsonLd,
  breadcrumbsJsonLd,
  docsBreadcrumbsJsonLd,
  galaxyBreadcrumbsJsonLd,
  logbookBreadcrumbsJsonLd,
  mixtapeAlbumJsonLd,
  musicAlbumJsonLd,
  musicGroupJsonLd,
  musicPlaylistJsonLd,
  musicRecordingJsonLd,
  newsletterBreadcrumbsJsonLd,
  observationAudioObjectJsonLd,
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
    expect(jsonLd).not.toHaveProperty("recordLabel");
  });

  it("omits the MusicBrainz recording anchor when the track carries no MBID (the base fixture)", () => {
    expect(jsonLd.sameAs).not.toContain(expect.stringContaining("musicbrainz.org/recording"));
    expect((jsonLd.identifier as unknown[]).length).toBe(2);
  });

  it("emits the MusicBrainz recording MBID as a sameAs + a KG identifier when present", () => {
    const withMbid = musicRecordingJsonLd(
      { ...track, mbRecordingId: "b9ad642e-b012-41c7-b4b1-0f0f0f0f0f0f" },
      "https://img/cover.jpg",
    );

    expect(withMbid.sameAs).toContain(
      "https://musicbrainz.org/recording/b9ad642e-b012-41c7-b4b1-0f0f0f0f0f0f",
    );
    expect(withMbid.identifier).toContainEqual({
      "@type": "PropertyValue",
      propertyID: "musicbrainz-recording-id",
      value: "b9ad642e-b012-41c7-b4b1-0f0f0f0f0f0f",
    });
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

    expect(composition).not.toHaveProperty("musicalKey");
  });

  it("emits key only when the tempo is absent (key present, bpm NULL)", () => {
    const keyOnly = musicRecordingJsonLd({ ...track, key: "A minor" }, "https://img/cover.jpg");
    const composition = keyOnly.recordingOf as Record<string, unknown>;

    expect(composition.musicalKey).toBe("A minor");
    expect(composition).not.toHaveProperty("additionalProperty");
  });

  it("omits recordingOf entirely when the finding carries neither tempo nor key", () => {
    expect(jsonLd).not.toHaveProperty("recordingOf");
  });

  it("stamps @id on a case/accent-variant display name (folded match, not exact)", () => {
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
  const artist = {
    discogsUrl: "https://www.discogs.com/artist/2529557-Dimension",
    imageUrl: "https://img/dimension.jpg",
    lastfmUrl: "https://www.last.fm/music/Dimension",
    mbid: "mbid-123",
    name: "Dimension",
    slug: "dimension",
    socials: ["https://open.spotify.com/artist/abc", "https://instagram.com/dimensiondnb"],
    spotifyUrl: "https://open.spotify.com/artist/abc",
    wikidataQid: "Q123",
  };
  const jsonLd = musicGroupJsonLd(artist, findings);

  it("is a MusicGroup carrying its own @id (twin of the /log byArtist node)", () => {
    expect(jsonLd["@type"]).toBe("MusicGroup");
    expect(jsonLd["@id"]).toBe("https://www.fluncle.com/artist/dimension");
    expect(jsonLd.url).toBe("https://www.fluncle.com/artist/dimension");
    expect(jsonLd.genre).toBe("Drum and Bass");
    expect(jsonLd.image).toBe("https://img/dimension.jpg");
  });

  it("orders sameAs Wikidata > MusicBrainz > Discogs > Last.fm > Spotify > socials, de-duplicated", () => {
    expect(jsonLd.sameAs).toEqual([
      "https://www.wikidata.org/wiki/Q123",
      "https://musicbrainz.org/artist/mbid-123",
      "https://www.discogs.com/artist/2529557-Dimension",
      "https://www.last.fm/music/Dimension",
      "https://open.spotify.com/artist/abc",
      "https://instagram.com/dimensiondnb",
    ]);
  });

  it("omits the Discogs + Last.fm anchors entirely when the artist carries neither", () => {
    const bare = musicGroupJsonLd(
      { ...artist, discogsUrl: undefined, lastfmUrl: undefined },
      findings,
    );

    expect(bare.sameAs).toEqual([
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

    expect(list.itemListElement[0]?.item.byArtist).toEqual([
      {
        "@id": "https://www.fluncle.com/artist/dimension",
        "@type": "MusicGroup",
        name: "Dimension",
      },
    ]);

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

  it("omits alternateName when the artist carries no aliases (the base fixture + an empty array)", () => {
    expect(jsonLd).not.toHaveProperty("alternateName");

    const emptied = musicGroupJsonLd(
      { alternateNames: [], imageUrl: "https://img/x.jpg", name: "X", slug: "x", socials: [] },
      [],
    );

    expect(emptied).not.toHaveProperty("alternateName");
  });

  it("emits a single alias as a scalar alternateName, several as an array", () => {
    const one = musicGroupJsonLd(
      {
        alternateNames: ["DC Breaks"],
        imageUrl: "https://img/x.jpg",
        name: "DC Breaks",
        slug: "dc-breaks",
        socials: [],
      },
      [],
    );

    expect(one.alternateName).toBe("DC Breaks");

    const many = musicGroupJsonLd(
      {
        alternateNames: ["Nu:Tone", "Nutone"],
        imageUrl: "https://img/x.jpg",
        name: "Nu:Tone",
        slug: "nu-tone",
        socials: [],
      },
      [],
    );

    expect(many.alternateName).toEqual(["Nu:Tone", "Nutone"]);
  });

  it("carries the factual bio as description only when one is authored", () => {
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

  it("omits track entirely on an artist with no certified finding (never an empty ItemList)", () => {
    const bare = musicGroupJsonLd(
      { imageUrl: "https://img/x.jpg", name: "Uncertified", slug: "uncertified", socials: [] },
      [],
    );

    expect(bare).not.toHaveProperty("track");
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

describe("observationAudioObjectJsonLd (the finding's spoken observation schema)", () => {
  const jsonLd = observationAudioObjectJsonLd({
    ...track,
    observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1765534200000",
    observationDurationMs: 34_000,
    observationGeneratedAt: "2026-06-12T09:30:00.000Z",
  });

  it("is an AudioObject pointing at the version-busted observation audio, named Artist — Title", () => {
    expect(jsonLd["@type"]).toBe("AudioObject");
    expect(jsonLd.contentUrl).toBe(
      "https://found.fluncle.com/004.7.2I/observation.mp3?v=1765534200000",
    );
    expect(jsonLd.encodingFormat).toBe("audio/mpeg");
    expect(jsonLd.name).toBe("Axwell, 1991 — Nobody Else - 1991 Remix");
    expect(jsonLd.url).toBe("https://www.fluncle.com/log/004.7.2I");
  });

  it("is created + published BY the one canonical Fluncle entity node (@id)", () => {
    expect(jsonLd.creator).toEqual({ "@id": fluncleEntityId });
    expect(jsonLd.publisher).toEqual({ "@id": fluncleEntityId });
  });

  it("mirrors the visible prose and carries the ISO-8601 length + a zoned generated-at uploadDate", () => {
    expect(jsonLd.description).toBe(definitionalProse(track));
    expect(jsonLd.duration).toBe("PT0M34S");

    expect(jsonLd.uploadDate).toBe("2026-06-12T09:30:00.000Z");
  });

  it("normalizes a bare-date generated-at stamp to a zoned datetime", () => {
    const dateOnly = observationAudioObjectJsonLd({
      ...track,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
      observationGeneratedAt: "2026-06-29",
    });

    expect(dateOnly.uploadDate).toBe("2026-06-29T00:00:00.000Z");
  });

  it("omits duration and uploadDate when the finding lacks them (the degraded render)", () => {
    const spare = observationAudioObjectJsonLd({
      ...track,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
    });

    expect(spare).not.toHaveProperty("duration");
    expect(spare).not.toHaveProperty("uploadDate");
  });

  it("carries NO transcript in any form (the observation script stays admin-only)", () => {
    expect(Object.keys(jsonLd)).not.toContain("transcript");
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

describe("the detail-page trails that had none", () => {
  it("walks Fluncle → Logbook → the entry's coordinate", () => {
    const jsonLd = logbookBreadcrumbsJsonLd("036") as {
      itemListElement: Array<{ item?: string; name: string; position: number }>;
    };

    expect(jsonLd.itemListElement.map((item) => item.name)).toEqual(["Fluncle", "Logbook", "036"]);

    expect(jsonLd.itemListElement[1]?.item).toBe("https://www.fluncle.com/logbook");
    expect(jsonLd.itemListElement[2]?.item).toBeUndefined();
  });

  it("walks Fluncle → Newsletter → the edition number", () => {
    const jsonLd = newsletterBreadcrumbsJsonLd(4) as {
      itemListElement: Array<{ item?: string; name: string }>;
    };

    expect(jsonLd.itemListElement.map((item) => item.name)).toEqual([
      "Fluncle",
      "Newsletter",
      "#4",
    ]);
    expect(jsonLd.itemListElement[1]?.item).toBe("https://www.fluncle.com/newsletter");
  });

  it("walks Fluncle → Docs → the doc's own front-matter title", () => {
    const jsonLd = docsBreadcrumbsJsonLd("Log ID") as {
      itemListElement: Array<{ item?: string; name: string }>;
    };

    expect(jsonLd.itemListElement.map((item) => item.name)).toEqual(["Fluncle", "Docs", "Log ID"]);
    expect(jsonLd.itemListElement[1]?.item).toBe("https://www.fluncle.com/docs");
    expect(jsonLd.itemListElement[2]?.item).toBeUndefined();
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
    expect(organizationOf(base)).not.toHaveProperty("description");

    expect(
      organizationOf({ ...base, bio: "Medschool is Hospital Records' sister label." }).description,
    ).toBe("Medschool is Hospital Records' sister label.");
  });

  it("emits the Organization's sameAs from the MusicBrainz + Discogs ids, and omits it when absent", () => {
    expect(organizationOf(base)).not.toHaveProperty("sameAs");

    expect(organizationOf({ ...base, discogsLabelId: 1111, mbLabelId: "mbid-med" }).sameAs).toEqual(
      ["https://musicbrainz.org/label/mbid-med", "https://www.discogs.com/label/1111"],
    );

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

  it("omits byArtist on a various-artists record (never `byArtist: []`)", () => {
    expect(musicAlbumJsonLd({ ...base, artists: [] })).not.toHaveProperty("byArtist");
  });

  it("carries the factual bio as description only when one is authored", () => {
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

  it("stamps the catalogue number onto the MusicRelease beside the label", () => {
    const jsonLd = musicAlbumJsonLd({
      ...base,
      catalogNumber: "HOSPCD01",
      label: { name: "Hospital Records", slug: "hospital-records" },
    });

    expect(jsonLd.albumRelease).toMatchObject({
      "@type": "MusicRelease",
      catalogNumber: "HOSPCD01",
      recordLabel: { name: "Hospital Records" },
    });
  });

  it("still emits the number when the record's label edge is missing", () => {
    const jsonLd = musicAlbumJsonLd({ ...base, catalogNumber: "RAMM123" });

    expect(jsonLd.albumRelease).toEqual({
      "@type": "MusicRelease",
      catalogNumber: "RAMM123",
      name: "Colours in the Dark",
    });
  });

  it("omits the MusicRelease entirely when neither a label nor a number is known", () => {
    expect(musicAlbumJsonLd(base)).not.toHaveProperty("albumRelease");
  });

  it("omits catalogNumber from a labelled release that carries none", () => {
    const jsonLd = musicAlbumJsonLd({
      ...base,
      label: { name: "Hospital Records", slug: "hospital-records" },
    });

    expect(jsonLd.albumRelease).not.toHaveProperty("catalogNumber");
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

    expect(jsonLd.byArtist).toEqual({ "@id": fluncleEntityId, "@type": "Person", name: "Fluncle" });
    expect(jsonLd.publisher).toEqual({ "@id": fluncleEntityId });

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

    expect(jsonLd.numTracks).toBe(0);
  });
});

describe("musicRecordingJsonLd remixer contributor (RFC label-lineage-remixer U2)", () => {
  it("emits the remixer as a schema.org contributor Role when the title names a credited artist", () => {
    const jsonLd = musicRecordingJsonLd(track, "https://img/cover.jpg");

    expect(jsonLd.contributor).toEqual([
      {
        "@type": "Role",
        contributor: { "@type": "MusicGroup", name: "1991" },
        roleName: "remixer",
      },
    ]);
  });

  it("stamps the remixer's @id when it resolves to a known artist entity", () => {
    const jsonLd = musicRecordingJsonLd(
      { ...track, artistSlugs: { "1991": "1991" } },
      "https://img/cover.jpg",
    );

    expect(jsonLd.contributor).toEqual([
      {
        "@type": "Role",
        contributor: {
          "@id": "https://www.fluncle.com/artist/1991",
          "@type": "MusicGroup",
          name: "1991",
        },
        roleName: "remixer",
      },
    ]);
  });

  it("omits contributor for a non-remix title (byte-identical to before)", () => {
    const jsonLd = musicRecordingJsonLd(
      { ...track, artists: ["Axwell"], title: "Nobody Else" },
      "https://img/cover.jpg",
    );

    expect(jsonLd).not.toHaveProperty("contributor");
  });

  it("omits contributor when the remixer is not one of the track's credited artists", () => {
    const jsonLd = musicRecordingJsonLd(
      { ...track, artists: ["Axwell"], title: "Nobody Else (Calibre Remix)" },
      "https://img/cover.jpg",
    );

    expect(jsonLd).not.toHaveProperty("contributor");
  });
});

describe("recordLabelJsonLd lineage (RFC label-lineage-remixer U1)", () => {
  const base = {
    artists: [],
    name: "Med School",
    slug: "med-school",
    tracks: [],
  };

  it("emits foundingDate, a location Place, and the parent/sub Organization @id edges", () => {
    const jsonLd = recordLabelJsonLd({
      ...base,
      foundingDate: "2006",
      location: "United Kingdom",
      parentOrganization: { name: "Hospital Records", slug: "hospital-records" },
      subOrganizations: [{ name: "Med School Sampler", slug: "med-school-sampler" }],
    });

    const org = jsonLd.about as Record<string, unknown>;

    expect(org.foundingDate).toBe("2006");
    expect(org.location).toEqual({ "@type": "Place", name: "United Kingdom" });
    expect(org.parentOrganization).toEqual({
      "@id": "https://www.fluncle.com/label/hospital-records#organization",
      "@type": "Organization",
      name: "Hospital Records",
      url: "https://www.fluncle.com/label/hospital-records",
    });
    expect(org.subOrganization).toEqual([
      {
        "@id": "https://www.fluncle.com/label/med-school-sampler#organization",
        "@type": "Organization",
        name: "Med School Sampler",
        url: "https://www.fluncle.com/label/med-school-sampler",
      },
    ]);
  });

  it("omits every lineage key when the label carries none (byte-identical to before)", () => {
    const org = recordLabelJsonLd(base).about as Record<string, unknown>;

    expect(org).not.toHaveProperty("foundingDate");
    expect(org).not.toHaveProperty("location");
    expect(org).not.toHaveProperty("parentOrganization");
    expect(org).not.toHaveProperty("subOrganization");
  });
});

import { describe, expect, it } from "vitest";

import { archiveTrackJsonLd, trackBreadcrumbsJsonLd } from "./log-schema";
import {
  hasTrackPageIdentity,
  type ListenKind,
  SAME_AS_EXCLUDED_LISTEN_KINDS,
  sameAsUrls,
  trackPagePath,
  trackPageUrl,
} from "./track-page";

describe("the destination's address", () => {
  it("is the row's permanent id, percent-encoded", () => {
    // The crawler's ids are namespaced (`mb_<recording-mbid>`) and the freshness tap's are
    // (`sp_<spotify-track-id>`); neither needs escaping, but a legacy id is whatever Spotify gave
    // us, so the segment is encoded rather than trusted.
    expect(trackPagePath("mb_2b1c4d5e")).toBe("/track/mb_2b1c4d5e");
    expect(trackPagePath("a b/c")).toBe("/track/a%20b%2Fc");
    expect(trackPageUrl("mb_2b1c4d5e")).toBe("https://www.fluncle.com/track/mb_2b1c4d5e");
  });
});

describe("sufficient identity", () => {
  it("admits a row the archive can name", () => {
    expect(hasTrackPageIdentity({ artists: ["Ashen Relay"], title: "Undertow Ledger" })).toBe(true);
  });

  it("refuses a row with no title, or a title of only whitespace", () => {
    expect(hasTrackPageIdentity({ artists: ["Ashen Relay"], title: "" })).toBe(false);
    expect(hasTrackPageIdentity({ artists: ["Ashen Relay"], title: "   " })).toBe(false);
  });

  it("refuses a row with no artist credit, or only a blank one", () => {
    expect(hasTrackPageIdentity({ artists: [], title: "Undertow Ledger" })).toBe(false);
    expect(hasTrackPageIdentity({ artists: ["  "], title: "Undertow Ledger" })).toBe(false);
  });
});

const FULL = {
  album: { name: "Signal Bloom", slug: "signal-bloom" },
  artistSlugs: { "ashen relay": "ashen-relay" },
  artists: ["Ashen Relay"],
  bpm: 174.4,
  discogsReleaseUrl: "https://www.discogs.com/release/9",
  durationMs: 270_000,
  imageUrl: "https://i.scdn.co/image/cover",
  isrc: "GBTEST2600001",
  key: "F minor",
  label: { name: "Driftwave Audio", slug: "driftwave-audio" },
  listenUrls: ["https://open.spotify.com/track/x"],
  mbRecordingId: "11111111-2222-3333-4444-555555555555",
  releaseDate: "2026-04-02",
  title: "Undertow Ledger",
  trackId: "mb_x",
};

describe("the archive track's structured data", () => {
  it("resolves to its own destination and carries the facts the archive holds", () => {
    const node = archiveTrackJsonLd(FULL);

    expect(node).toMatchObject({
      "@type": "MusicRecording",
      datePublished: "2026-04-02",
      duration: "PT4M30S",
      genre: "Drum and Bass",
      isrcCode: "GBTEST2600001",
      name: "Undertow Ledger",
      url: "https://www.fluncle.com/track/mb_x",
    });
  });

  it("NEVER carries a Log ID identifier or a Found date — it is not a certification", () => {
    // The rail, in schema form. A `/log` MusicRecording emits `fluncle-log-id` identifiers and a
    // Found `datePublished`; a recording Fluncle has never ruled on can claim neither, and a node
    // that did would be a claim the archive cannot back.
    const serialized = JSON.stringify(archiveTrackJsonLd(FULL));

    expect(serialized).not.toContain("fluncle-log-id");
    expect(serialized).not.toContain("fluncle://");
  });

  it("anchors the record and the imprint to their own pages, closing the graph", () => {
    const node = archiveTrackJsonLd(FULL);

    expect(node["inAlbum"]).toMatchObject({
      "@id": "https://www.fluncle.com/album/signal-bloom",
      name: "Signal Bloom",
    });
    expect(node["recordLabel"]).toMatchObject({
      "@id": "https://www.fluncle.com/label/driftwave-audio#organization",
      name: "Driftwave Audio",
    });
    expect(node["byArtist"]).toStrictEqual([
      {
        "@id": "https://www.fluncle.com/artist/ashen-relay",
        "@type": "MusicGroup",
        name: "Ashen Relay",
      },
    ]);
  });

  it("puts every other page naming the recording in `sameAs`, Discogs included", () => {
    expect(archiveTrackJsonLd(FULL)["sameAs"]).toStrictEqual([
      "https://open.spotify.com/track/x",
      "https://www.discogs.com/release/9",
      "https://musicbrainz.org/recording/11111111-2222-3333-4444-555555555555",
    ]);
  });

  it("emits the measured tempo and key as the composition it is of", () => {
    expect(archiveTrackJsonLd(FULL)["recordingOf"]).toStrictEqual({
      "@type": "MusicComposition",
      additionalProperty: {
        "@type": "PropertyValue",
        name: "tempo",
        unitText: "BPM",
        value: 174,
      },
      musicalKey: "F minor",
      name: "Undertow Ledger",
    });
  });

  it("omits every key it has no fact for rather than emitting an empty one", () => {
    const node = archiveTrackJsonLd({
      artists: ["Quiet Cartel"],
      durationMs: 240_000,
      listenUrls: [],
      title: "Ferrite Bloom",
      trackId: "mb_thin",
    });

    for (const key of [
      "datePublished",
      "identifier",
      "image",
      "inAlbum",
      "isrcCode",
      "recordLabel",
      "recordingOf",
      "sameAs",
    ]) {
      expect(node).not.toHaveProperty(key);
    }
  });

  it("names the /tracks hub as the page's parent in the trail", () => {
    expect(
      trackBreadcrumbsJsonLd("Ashen Relay — Undertow Ledger")["itemListElement"],
    ).toStrictEqual([
      { "@type": "ListItem", item: "https://www.fluncle.com/", name: "Fluncle", position: 1 },
      {
        "@type": "ListItem",
        item: "https://www.fluncle.com/tracks",
        name: "Tracks",
        position: 2,
      },
      { "@type": "ListItem", name: "Ashen Relay — Undertow Ledger", position: 3 },
    ]);
  });
});

describe("the length the archive does not hold", () => {
  it("omits the `duration` KEY rather than emitting a zero-length claim", () => {
    // `tracks.duration_ms` is NOT NULL and carries 0 as its "unknown" (crawl.ts), so an
    // unconditional emit asserts `"PT0M0S"` — a zero-length recording — to crawlers and answer
    // engines. Asserted on the KEY's absence, not on the string, because a page that emits
    // `duration: undefined` or `duration: ""` is the same defect wearing a different value.
    const node = archiveTrackJsonLd({ ...FULL, durationMs: undefined });

    expect(node).not.toHaveProperty("duration");
  });

  it("still emits the duration when the archive actually knows it", () => {
    expect(archiveTrackJsonLd(FULL)).toHaveProperty("duration", "PT4M30S");
  });
});

describe("the sameAs containment seam", () => {
  const EVERY_KIND: { href: string; kind: ListenKind }[] = [
    { href: "https://open.spotify.com/track/x", kind: "spotify" },
    { href: "https://music.apple.com/us/album/x/1?i=2", kind: "apple" },
    { href: "https://www.deezer.com/track/9", kind: "deezer" },
    { href: "https://www.beatport.com/track/x/9", kind: "beatport" },
    { href: "https://www.youtube.com/watch?v=x", kind: "youtube" },
  ];

  it("keeps every EXCLUDED kind out of the graph, keyed on the kind and not on a URL", () => {
    // The guard the rail needs: it fails if a future edit lets an excluded kind through, and it
    // survives a rename of the service or a change to its URL shape, because it asks the seam
    // which kinds it excludes rather than grepping for a literal.
    const urls = sameAsUrls(EVERY_KIND);

    for (const kind of SAME_AS_EXCLUDED_LISTEN_KINDS) {
      const excluded = EVERY_KIND.find((destination) => destination.kind === kind);

      expect(excluded, `the fixture must carry the ${kind} kind`).toBeDefined();
      expect(urls).not.toContain(excluded?.href);
    }
  });

  it("lets every other kind through, in order", () => {
    expect(sameAsUrls(EVERY_KIND)).toStrictEqual([
      "https://open.spotify.com/track/x",
      "https://music.apple.com/us/album/x/1?i=2",
      "https://www.deezer.com/track/9",
      "https://www.youtube.com/watch?v=x",
    ]);
  });

  it("Beatport is one of the excluded kinds — the standing rail, made executable", () => {
    // db/schema.ts §F: the Beatport URL may be RENDERED as a link and must never enter a derived
    // corpus, and a `sameAs` graph is a derived corpus (log-schema.ts: "for crawlers + AI
    // answer-engines"). The certified /log page withholds it; this surface must too.
    expect(SAME_AS_EXCLUDED_LISTEN_KINDS).toContain("beatport");
  });

  it("a node built through the seam carries no Beatport URL at all", () => {
    const node = archiveTrackJsonLd({
      ...FULL,
      discogsReleaseUrl: undefined,
      listenUrls: sameAsUrls(EVERY_KIND),
      mbRecordingId: undefined,
    });

    expect(JSON.stringify(node)).not.toContain("beatport");
  });
});

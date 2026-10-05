import { describe, expect, it } from "vitest";
import { META_DESCRIPTION_MAX } from "./meta-description";
import {
  PAGE_TITLE_MAX,
  albumArtistCredit,
  albumMetaDescription,
  albumPageTitle,
  artistMetaDescription,
  artistPageTitle,
  labelMetaDescription,
  labelPageTitle,
  trackMetaDescription,
  trackPageTitle,
  twitterCardMeta,
} from "./page-meta";

describe("graph page titles say what the page holds", () => {
  it("names an artist page as drum & bass tracks and releases", () => {
    expect(artistPageTitle("Grimesy")).toBe("Grimesy: drum & bass tracks and releases · Fluncle");
  });

  it("names a label page as drum & bass releases and artists", () => {
    expect(labelPageTitle("I99I")).toBe("I99I: drum & bass releases and artists · Fluncle");
  });

  it("drops the descriptor before it lets a long name run past the title budget", () => {
    expect(labelPageTitle("Sweet Tooth Recordings")).toBe(
      "Sweet Tooth Recordings: drum & bass releases · Fluncle",
    );

    const long = "An Extraordinarily Long Collective Name For Testing";

    expect(artistPageTitle(long)).toBe(`${long} · Fluncle`);
  });

  it("names an album's artist and year, the words people search with", () => {
    expect(albumPageTitle({ artist: "Seba", name: "Big Ting EP", releaseDate: "2026-03-06" })).toBe(
      "Big Ting EP by Seba: 2026 drum & bass release · Fluncle",
    );
  });

  it("keeps the album artist over the year when both do not fit", () => {
    expect(
      albumPageTitle({ artist: "Current Value", name: "Holodeck", releaseDate: "2026-01-01" }),
    ).toBe("Holodeck by Current Value: drum & bass release · Fluncle");
  });

  it("falls back to the year when an album has no single credited artist", () => {
    expect(albumPageTitle({ artist: undefined, name: "Kintaro EP", releaseDate: "2013" })).toBe(
      "Kintaro EP: 2013 drum & bass release · Fluncle",
    );
  });

  it("titles a track with its year", () => {
    expect(
      trackPageTitle({ artists: ["Sicknote"], releaseDate: "2020-05-01", title: "808X4" }),
    ).toBe("Sicknote — 808X4: 2020 drum & bass track · Fluncle");
  });

  it("keeps every title within the budget whenever a fitting variant exists", () => {
    for (const title of [
      artistPageTitle("Grimesy"),
      labelPageTitle("Freak Recordings"),
      albumPageTitle({ artist: "Seba", name: "Big Ting EP", releaseDate: "2026" }),
      trackPageTitle({ artists: ["Sicknote"], releaseDate: "2020", title: "808X4" }),
    ]) {
      expect(title.length).toBeLessThanOrEqual(PAGE_TITLE_MAX);
    }
  });
});

describe("albumArtistCredit", () => {
  it("credits the artist every track shares", () => {
    expect(
      albumArtistCredit([
        { artists: ["Seba"] },
        { artists: ["Seba", "Paradox"] },
        { artists: ["seba"] },
      ]),
    ).toBe("Seba");
  });

  it("joins two shared artists", () => {
    expect(
      albumArtistCredit([{ artists: ["Calibre", "DRS"] }, { artists: ["DRS", "Calibre"] }]),
    ).toBe("Calibre & DRS");
  });

  it("credits no one on a compilation or an empty record", () => {
    expect(albumArtistCredit([{ artists: ["Seba"] }, { artists: ["Paradox"] }])).toBeUndefined();
    expect(albumArtistCredit([])).toBeUndefined();
  });
});

describe("artistMetaDescription", () => {
  it("tells a searcher how many tracks the page holds when there is no bio", () => {
    expect(
      artistMetaDescription({
        bio: undefined,
        findingCount: 3,
        name: "SynthForce",
        trackCount: 12,
      }),
    ).toBe(
      "Drum & bass by SynthForce: 12 tracks, 3 recommended by Fluncle, with the releases and labels behind them.",
    );
  });

  it("keeps an initialled name whole instead of cutting the bio at its first full stop", () => {
    const description = artistMetaDescription({
      bio: "M.C. Fats was a British drum & bass vocalist best known for his work with numerous producers across the scene.",
      findingCount: 1,
      name: "M.C. Fats",
      trackCount: 38,
    });

    expect(description).toBe(
      "M.C. Fats was a British drum & bass vocalist best known for his work with numerous producers across the scene. 38 drum & bass tracks, 1 recommended by Fluncle.",
    );
    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });

  it("leads with whole bio sentences and adds the page's facts", () => {
    const bio =
      "Grimesy, born Stephen Grimes, is a drum & bass and jungle producer and DJ from Lancaster, UK. " +
      "Known for a dynamic, versatile style, he has released music on a long list of labels across the scene.";

    const description = artistMetaDescription({
      bio,
      findingCount: 0,
      name: "Grimesy",
      trackCount: 38,
    });

    expect(description).toBe(
      "Grimesy, born Stephen Grimes, is a drum & bass and jungle producer and DJ from Lancaster, UK. 38 drum & bass tracks, with the releases and labels behind them.",
    );
    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });

  it("keeps the trimmed bio when not even one sentence leaves room for the facts", () => {
    const bio = `${"A very long opening clause about a producer ".repeat(5)}that never ends.`;

    const description = artistMetaDescription({ bio, findingCount: 0, name: "X", trackCount: 4 });

    expect(description.endsWith("…")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });
});

describe("labelMetaDescription", () => {
  it("names the artists a searcher may know the label by", () => {
    expect(
      labelMetaDescription({
        artistNames: ["Nu:Tone", "Logistics", "nu:tone", "Etherwood", "Unglued"],
        bio: undefined,
        findingCount: 1,
        name: "Hospital Records",
        trackCount: 40,
      }),
    ).toBe(
      "Drum & bass released on Hospital Records: 40 tracks, 1 recommended by Fluncle, from artists including Nu:Tone, Logistics and Etherwood.",
    );
  });

  it("appends the counts and artists to a bio", () => {
    const description = labelMetaDescription({
      artistNames: ["Alix Perez", "Monty"],
      bio: "I99I is a drum and bass record label founded by producer and DJ Alix Perez in 2018.",
      findingCount: 0,
      name: "I99I",
      trackCount: 25,
    });

    expect(description).toBe(
      "I99I is a drum and bass record label founded by producer and DJ Alix Perez in 2018. 25 drum & bass tracks, from artists including Alix Perez and Monty.",
    );
  });
});

describe("albumMetaDescription", () => {
  it("states artist, year, label and the tracklist", () => {
    expect(
      albumMetaDescription({
        artist: "Seba",
        bio: undefined,
        findingCount: 1,
        label: "Lossless",
        name: "Big Ting EP",
        releaseDate: "2026-03-06",
        trackTitles: ["Big Ting", "Lowdown", "Sunday"],
      }),
    ).toBe(
      "Big Ting EP by Seba, a 2026 drum & bass release on Lossless. 3 tracks: Big Ting, Lowdown and Sunday. Fluncle recommends 1 of them.",
    );
  });

  it("is never the old one-clause stub for a record with no label or artist", () => {
    const description = albumMetaDescription({
      artist: undefined,
      bio: undefined,
      findingCount: 0,
      label: undefined,
      name: "Kintaro EP",
      releaseDate: "2013",
      trackTitles: ["Kintaro", "Ryu", "Moonwalk", "Kintaro (VIP)"],
    });

    expect(description).toBe(
      "Kintaro EP, a 2013 drum & bass release. 4 tracks: Kintaro, Ryu, Moonwalk and Kintaro (VIP).",
    );
  });

  it("falls back to a count when the tracklist does not fit", () => {
    const description = albumMetaDescription({
      artist: "Various",
      bio: undefined,
      findingCount: 0,
      label: undefined,
      name: "Sampler",
      releaseDate: undefined,
      trackTitles: Array.from(
        { length: 20 },
        (_value, index) => `A Rather Long Track Title ${index}`,
      ),
    });

    expect(description).toBe("Sampler by Various, a drum & bass release. 20 tracks.");
  });

  it("does not list duplicate titles as if they were the whole record", () => {
    const description = albumMetaDescription({
      artist: undefined,
      bio: undefined,
      findingCount: 0,
      label: undefined,
      name: "Twins",
      releaseDate: undefined,
      trackTitles: ["Intro", "Intro"],
    });

    expect(description).toBe("Twins, a drum & bass release. 2 tracks.");
  });

  it("says when every track is a finding", () => {
    const description = albumMetaDescription({
      artist: "Calibre",
      bio: undefined,
      findingCount: 2,
      label: "Signature",
      name: "Shelflife",
      releaseDate: "2008",
      trackTitles: ["Mr Right On", "Steptoe"],
    });

    expect(description).toBe(
      "Shelflife by Calibre, a 2008 drum & bass release on Signature. 2 tracks: Mr Right On and Steptoe. Fluncle recommends both.",
    );
  });
});

describe("trackMetaDescription", () => {
  const base = {
    album: undefined,
    artists: ["Sicknote"],
    bpm: undefined,
    key: undefined,
    label: "YUKU",
    releaseDate: "2021-02-01",
    tail: undefined,
    title: "Gravity",
  };

  it("never joins a lowercase key onto a finished sentence", () => {
    const description = trackMetaDescription({ ...base, key: "G minor" });

    expect(description).toBe("Sicknote — Gravity, a 2021 drum & bass release on YUKU. In G minor.");
    expect(description).not.toContain(". in ");
  });

  it("reads tempo and key as one sentence", () => {
    expect(trackMetaDescription({ ...base, bpm: 173.6, key: "F minor" })).toBe(
      "Sicknote — Gravity, a 2021 drum & bass release on YUKU. 174 BPM in F minor.",
    );
  });

  it("names the album when it is not just the track's own single", () => {
    expect(
      trackMetaDescription({
        ...base,
        album: "Encounters EP",
        bpm: 174,
        tail: "Where to hear it.",
      }),
    ).toBe(
      "Sicknote — Gravity, from Encounters EP, a 2021 drum & bass release on YUKU. 174 BPM. Where to hear it.",
    );
    expect(trackMetaDescription({ ...base, album: "gravity" })).toBe(
      "Sicknote — Gravity, a 2021 drum & bass release on YUKU.",
    );
  });

  it("calls a dateless, label-less recording a drum & bass track", () => {
    expect(trackMetaDescription({ ...base, label: undefined, releaseDate: undefined })).toBe(
      "Sicknote — Gravity, a drum & bass track.",
    );
    expect(trackMetaDescription({ ...base, releaseDate: undefined })).toBe(
      "Sicknote — Gravity, a drum & bass release on YUKU.",
    );
  });

  it("drops the tail before it runs past the budget", () => {
    const description = trackMetaDescription({
      ...base,
      album: "A Considerably Longer Album Name Than Usual",
      bpm: 174,
      key: "G minor",
      label: "A Label With A Considerably Long Name Too",
      tail: "Where to hear it, and the tracks closest to it in sound.",
    });

    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(description).toBe(
      "Sicknote — Gravity, a 2021 drum & bass release on A Label With A Considerably Long Name Too. 174 BPM in G minor.",
    );
  });
});

describe("twitterCardMeta", () => {
  it("emits the title, description and image X reads before og", () => {
    expect(twitterCardMeta({ description: "d", imageUrl: "https://x/i.png", title: "t" })).toEqual([
      { content: "t", name: "twitter:title" },
      { content: "d", name: "twitter:description" },
      { content: "https://x/i.png", name: "twitter:image" },
    ]);
  });
});

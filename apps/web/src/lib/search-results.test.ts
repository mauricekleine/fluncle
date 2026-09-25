import { describe, expect, it } from "vitest";
import {
  ENTITY_GROUPS,
  MAX_QUERY_LENGTH,
  SEARCH_EXAMPLES,
  type SearchEntity,
  type SearchHit,
  entityHref,
  filterChips,
  hitHref,
  partitionHits,
  searchArchiveApiPath,
  searchPagePath,
} from "./search-results";

function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    artists: ["Nova Kestrel"],
    certified: false,
    title: "A Tune",
    trackId: "t1",
    ...overrides,
  };
}

describe("searchPagePath — the persistent surface's URL", () => {
  it("carries every query kind in one round-trippable param", () => {
    for (const query of [
      "netsky",
      "004.7.2I",
      "Hospital Records",
      "004.7.2I",
      "tracks that sound like Nine Clouds",
    ]) {
      const path = searchPagePath(query);
      const readBack = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q");

      expect(readBack).toBe(query);
    }
  });

  it("encodes the characters a query string would otherwise eat", () => {
    expect(searchPagePath("drum & bass?")).toBe("/search?q=drum%20%26%20bass%3F");
  });

  it("folds a blank or whitespace query onto the bare surface", () => {
    expect(searchPagePath()).toBe("/search");
    expect(searchPagePath("")).toBe("/search");
    expect(searchPagePath("   ")).toBe("/search");
  });

  it("trims a pasted paragraph to the contract's own ceiling", () => {
    const path = searchPagePath("a".repeat(MAX_QUERY_LENGTH + 50));

    expect(new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q")).toHaveLength(
      MAX_QUERY_LENGTH,
    );
  });
});

describe("the destinations", () => {
  it("sends a finding to its coordinate and an uncertified track to its own destination", () => {
    expect(hitHref(hit({ certified: true, logId: "004.7.2I" }))).toEqual({
      external: false,
      href: "/log/004.7.2I",
    });
    expect(hitHref(hit({ spotifyUrl: "https://open.spotify.com/track/x" }))).toEqual({
      external: false,
      href: "/track/t1",
    });
  });

  it("falls back to the off-site anchor for a row the destination would refuse", () => {
    expect(
      hitHref(hit({ artists: [], spotifyUrl: "https://open.spotify.com/track/x", title: "" })),
    ).toEqual({ external: true, href: "https://open.spotify.com/track/x" });
  });

  it("declines a row that has nowhere to go", () => {
    expect(hitHref(hit({ artists: [], title: "" }))).toBeUndefined();
  });

  it("takes an entity to its own page, and to its explicit url where the default is wrong", () => {
    const artist: SearchEntity = { kind: "artist", name: "Netsky", slug: "netsky" };
    const galaxy: SearchEntity = {
      kind: "galaxy",
      name: "Drift",
      slug: "drift",
      url: "/galaxies/drift",
    };

    expect(entityHref(artist)).toBe("/artist/netsky");
    expect(entityHref(galaxy)).toBe("/galaxies/drift");
  });

  it("offers every entity kind a group to render in", () => {
    expect(ENTITY_GROUPS.map((group) => group.kind).sort()).toEqual([
      "album",
      "artist",
      "galaxy",
      "label",
      "mixtape",
    ]);
  });
});

describe("partitionHits — the two registers", () => {
  it("splits the certified rows from the ones Fluncle never certified, keeping server order", () => {
    const results = [
      hit({ certified: true, logId: "001.1.1A", trackId: "a" }),
      hit({ trackId: "b" }),
      hit({ certified: true, logId: "002.1.1A", trackId: "c" }),
      hit({ trackId: "d" }),
    ];
    const { findings, unlit } = partitionHits(results);

    expect(findings.map((row) => row.trackId)).toEqual(["a", "c"]);
    expect(unlit.map((row) => row.trackId)).toEqual(["b", "d"]);
  });
});

describe("filterChips — what the language tier understood, echoed back", () => {
  it("names every axis it was given and nothing it was not", () => {
    expect(
      filterChips(
        {
          artist: "Andromedik",
          bpmMax: 178,
          bpmMin: 170,
          key: "A minor",
          soundsLikeArtists: ["Koven", "Maduk"],
          text: "rolling",
          yearMax: 2020,
        },
        (key) => key,
      ),
    ).toEqual([
      "artist: Andromedik",
      "sounds like: Koven, Maduk",
      "key: A minor",
      "bpm ≥ 170",
      "bpm ≤ 178",
      "to 2020",
      "“rolling”",
    ]);
  });

  it("renders the key through the caller's notation, never a hardcoded spelling", () => {
    expect(filterChips({ key: "A minor" }, () => "8A")).toEqual(["key: 8A"]);
  });

  it("says nothing when the model understood nothing", () => {
    expect(filterChips({}, (key) => key)).toEqual([]);
  });
});

describe("SEARCH_EXAMPLES — one list, one owner", () => {
  it("teaches each tier exactly once, in one place", () => {
    expect(SEARCH_EXAMPLES.map((example) => example.icon)).toEqual([
      "token",
      "token",
      "coordinate",
      "sonic",
    ]);
  });

  it("declares only deterministic tiers — never the language tier", () => {
    for (const example of SEARCH_EXAMPLES) {
      expect(["coordinate", "sonic", "token"]).toContain(example.icon);
    }
  });

  it("offers only queries the resolver will actually run", () => {
    for (const example of SEARCH_EXAMPLES) {
      expect(example.query.trim()).toBe(example.query);
      expect(example.query.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("searchArchiveApiPath", () => {
  it("builds the one public read both doors call", () => {
    expect(searchArchiveApiPath("nine clouds")).toBe("/api/v1/search/archive?q=nine+clouds");
    expect(searchArchiveApiPath("netsky", 40)).toBe("/api/v1/search/archive?q=netsky&limit=40");
  });
});

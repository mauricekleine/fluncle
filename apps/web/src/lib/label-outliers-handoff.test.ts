import { type LabelOutlierItem } from "@fluncle/contracts";
import { describe, expect, it } from "vitest";

import { outlierArtists, purgeHandoff } from "./label-outliers-handoff";

function item(overrides: Partial<LabelOutlierItem>): LabelOutlierItem {
  return {
    album: { id: "alb_xmas", name: "Merry Christmas", slug: "merry-christmas" },
    artistSupport: 0,
    discogsStyles: [],
    dismissedAt: null,
    firstFlaggedAt: "2026-09-27T03:40:00.000Z",
    label: { id: "lbl_penny", name: "Penny Black", slug: "penny-black" },
    reference: "label",
    referenceMedian: 0.87,
    score: 0.34,
    trackCount: 2,
    tracks: [
      {
        artists: [{ name: "Bing Crosby", slug: "bing-crosby" }],
        title: "White Christmas",
        trackId: "t_white",
      },
      {
        artists: [
          { name: "Bing Crosby", slug: "bing-crosby" },
          { name: "Danny Kaye", slug: "danny-kaye" },
        ],
        title: "Snow",
        trackId: "t_snow",
      },
    ],
    unitId: "album:alb_xmas:lbl_penny",
    z: -15.24,
    ...overrides,
  };
}

describe("the purge handoff", () => {
  it("lists album ids one per line with a comment purge-albums.ts ignores", () => {
    const text = purgeHandoff([item({})], "2026-09-27");

    expect(text).toBe(
      [
        "# label outliers 2026-09-27: 1 albums for purge-albums.ts --albums-file",
        "alb_xmas  # Merry Christmas on Penny Black (z -15.2)",
        "",
      ].join("\n"),
    );
  });

  it("keeps a single as a comment naming its track id and artists", () => {
    const single = item({
      album: null,
      label: null,
      tracks: [
        {
          artists: [{ name: "Foo Fighters", slug: "foo-fighters" }],
          title: "La # Dee Da",
          trackId: "t_la",
        },
      ],
      unitId: "track:t_la",
    });

    const lines = purgeHandoff([single], "2026-09-27").trimEnd().split("\n");

    expect(lines.slice(1)).toEqual([
      "# 1 singles with no album: purge-albums.ts --tracks <id>, or purge-artists.ts / an artist rule",
      "# t_la La Dee Da: foo-fighters",
    ]);
  });

  it("names each credited artist once across the unit's tracks", () => {
    expect(outlierArtists(item({})).map((artist) => artist.slug)).toEqual([
      "bing-crosby",
      "danny-kaye",
    ]);
  });
});

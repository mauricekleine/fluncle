import { describe, expect, it } from "vitest";
import { Route as FreshRoute } from "./fresh";

type HeadResult = { scripts?: Array<{ children: string; type?: string }> };

function freshItems(tracks: Array<Record<string, unknown>>): Array<{ item: { url?: string } }> {
  const loaderData = {
    coverage: "full",
    releaseCount: 1,
    standouts: undefined,
    today: "2026-10-22",
    trackCount: tracks.length,
    weeks: [
      {
        from: "2026-10-16",
        index: 0,
        releases: [
          {
            artists: ["Orbit Crew"],
            key: "far-side",
            lit: false,
            record: true,
            releaseDate: "2026-10-16",
            title: "Far Side LP",
            tracks,
          },
        ],
        span: "this-week",
        to: "2026-10-22",
      },
    ],
    windowDays: 30,
  };
  const head = FreshRoute.options.head?.({ loaderData } as never) as HeadResult;
  const schema = JSON.parse(head.scripts?.[0]?.children ?? "{}") as {
    mainEntity: { itemListElement: Array<{ item: { url?: string } }> };
  };

  return schema.mainEntity.itemListElement;
}

describe("/fresh ItemList JSON-LD", () => {
  it("points each track at the page the visible row links to", () => {
    const items = freshItems([
      {
        artists: [{ name: "Orbit Crew" }],
        href: "/log/122.4.2K",
        lit: true,
        logId: "122.4.2K",
        previewable: false,
        spotifyUrl: "https://open.spotify.com/track/lit",
        title: "Lift Off",
        trackId: "lit",
      },
      {
        artists: [{ name: "Orbit Crew" }],
        href: "/track/mb_dust-lane",
        lit: false,
        previewable: false,
        spotifyUrl: "https://open.spotify.com/track/unlit",
        title: "Dust Lane",
        trackId: "mb_dust-lane",
      },
    ]);

    expect(items.map((entry) => entry.item.url)).toEqual([
      "https://www.fluncle.com/log/122.4.2K",
      "https://www.fluncle.com/track/mb_dust-lane",
    ]);
  });

  it("falls back to Spotify only for a row with no Fluncle destination", () => {
    const items = freshItems([
      {
        artists: [],
        lit: false,
        previewable: false,
        spotifyUrl: "https://open.spotify.com/track/bare",
        title: "Untitled",
        trackId: "sp_bare",
      },
    ]);

    expect(items[0]?.item.url).toBe("https://open.spotify.com/track/bare");
  });
});

import { describe, expect, it } from "vitest";
import { type SearchResponse, searchSeeAll } from "./search-results";

const hit = { artists: ["Netsky"], certified: false, title: "Rio", trackId: "t1" };

function response(patch: Partial<SearchResponse>): SearchResponse {
  return { degraded: false, entities: [], kind: "token", results: [hit], ...patch };
}

describe("searchSeeAll", () => {
  it("sends a style to its ranked /tracks list", () => {
    expect(searchSeeAll(response({ filters: { sound: "liquid" }, kind: "sonic" }))).toEqual({
      href: "/tracks?sound=liquid",
      label: "See all tracks closest to Liquid",
    });
  });

  it("sends a named artist, label or album to its own page", () => {
    expect(
      searchSeeAll(
        response({
          entities: [{ kind: "artist", name: "Netsky", slug: "netsky" }],
          kind: "entity",
        }),
      ),
    ).toEqual({ href: "/artist/netsky", label: "See all tracks by Netsky" });
    expect(
      searchSeeAll(
        response({
          entities: [{ kind: "label", name: "Hospital Records", slug: "hospital-records" }],
          kind: "entity",
        }),
      )?.href,
    ).toBe("/label/hospital-records");
  });

  it("sends a reading made of list axes to the filtered /tracks list", () => {
    expect(
      searchSeeAll(response({ filters: { bpmMin: 170, key: "A minor" }, kind: "filters" })),
    ).toEqual({ href: "/tracks?bpmMin=170&key=A+minor", label: "See all matching tracks" });
  });

  it("offers nothing where there is no fuller list", () => {
    expect(searchSeeAll(response({ kind: "token" }))).toBeUndefined();
    expect(searchSeeAll(response({ filters: { text: "rio" }, kind: "filters" }))).toBeUndefined();
    expect(
      searchSeeAll(response({ filters: { artist: "Netsky", key: "A minor" }, kind: "filters" })),
    ).toBeUndefined();
    expect(
      searchSeeAll(response({ anchor: hit, filters: { soundsLike: "Rio" }, kind: "sonic" })),
    ).toBeUndefined();
    expect(
      searchSeeAll(
        response({
          entities: [{ kind: "galaxy", name: "Lunar", slug: "lunar", url: "/galaxies/lunar" }],
          kind: "entity",
        }),
      ),
    ).toBeUndefined();
  });
});

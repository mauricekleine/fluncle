// The Beatport resolve, tested against REAL search extracts.
//
// The two fixtures are trimmed captures of live beatport.com search pages (2026-07-30), kept at
// their real shape: Beatport's own `__NEXT_DATA__` island with genuine track ids and ISRCs, and the
// absolute anchors the page rendered for them. Nothing about their STRUCTURE is synthetic — which is
// the whole point, since every failure mode this module guards is a shape change on Beatport's side.
//
// They are trimmed twice over: to a handful of results, and to the identity fields the resolver
// actually reads. Beatport's bpm/key/genre/label/price never enter the repo, for the same §F reason
// they never enter the database (see `tracks.beatport_url` in db/schema.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  beatportSearchUrl,
  parseSearchTracks,
  parseTrackLinks,
  pickBeatportUrl,
} from "./beatport-resolve";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "__fixtures__", "beatport", name), "utf8");
}

const PLUTO = fixture("search-pluto.html");
const VENUS_FLY = fixture("search-venus-fly.html");

describe("beatportSearchUrl", () => {
  it("builds the same query the buy-then-mix link already uses", () => {
    // Shared shape with lib/beatport.ts's client-side link so the two surfaces search alike.
    expect(beatportSearchUrl(["Rizzle"], "Pluto")).toBe(
      "https://www.beatport.com/search?q=Rizzle%20Pluto",
    );
    expect(beatportSearchUrl(["Alpha Rhythm", "Ritual", "Seba"], "Venus Fly - Seba Remix")).toBe(
      "https://www.beatport.com/search?q=Alpha%20Rhythm%20Ritual%20Seba%20Venus%20Fly%20-%20Seba%20Remix",
    );
  });
});

describe("parseSearchTracks", () => {
  it("reads Beatport's own result objects out of the page data", () => {
    const tracks = parseSearchTracks(PLUTO);

    expect(tracks).not.toBeNull();
    expect(tracks?.length).toBeGreaterThan(0);
    expect(tracks?.[0]?.isrc).toBe("CA5KR2489434");
  });

  it("returns null — never an empty list — when the data island is missing or broken", () => {
    // THE DISTINCTION THAT MATTERS. A structural failure must not read as "Beatport has nothing":
    // one is a redesign to fix, the other is a receipt telling a reader the search concluded.
    expect(parseSearchTracks("<html><body>no island here</body></html>")).toBeNull();
    expect(
      parseSearchTracks('<script id="__NEXT_DATA__" type="application/json">{oops</script>'),
    ).toBeNull();
    expect(
      parseSearchTracks('<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>'),
    ).toBeNull();
  });
});

describe("parseTrackLinks", () => {
  it("maps each result id to the link Beatport itself rendered", () => {
    const links = parseTrackLinks(PLUTO);

    expect(links.get("19385810")).toBe("https://www.beatport.com/track/pluto/19385810");
  });

  it("keeps the first link for an id that appears more than once", () => {
    const html =
      '<a href="https://www.beatport.com/track/pluto/19385810"></a>' +
      '<a href="https://www.beatport.com/track/pluto-again/19385810"></a>';

    expect(parseTrackLinks(html).get("19385810")).toBe(
      "https://www.beatport.com/track/pluto/19385810",
    );
  });
});

describe("pickBeatportUrl", () => {
  it("returns the URL of the result whose ISRC matches exactly", () => {
    expect(pickBeatportUrl(PLUTO, "CA5KR2489434")).toEqual({
      ok: true,
      url: "https://www.beatport.com/track/pluto/19385810",
    });
  });

  it("matches a remix on its own ISRC, not on its title", () => {
    // Fluncle holds this as "Venus Fly - Seba Remix"; Beatport splits it into name "Venus Fly" plus
    // mix "Seba Remix". No title comparison could equate those, and none is attempted — the ISRC is
    // the whole gate, which is exactly why the leg survives every naming convention a store uses.
    expect(pickBeatportUrl(VENUS_FLY, "NLCK42416396")).toEqual({
      ok: true,
      url: "https://www.beatport.com/track/venus-fly/19501138",
    });
  });

  it("normalises case and surrounding whitespace before comparing", () => {
    expect(pickBeatportUrl(PLUTO, "  ca5kr2489434  ")).toEqual({
      ok: true,
      url: "https://www.beatport.com/track/pluto/19385810",
    });
  });

  it("misses cleanly when no result carries the ISRC", () => {
    // The page is full of real, valid ISRCs for OTHER recordings. A leg that matched on anything
    // looser than equality would happily return one of them.
    expect(pickBeatportUrl(PLUTO, "GBAAA0000001")).toEqual({ ok: true, url: null });
  });

  it("never returns a URL belonging to a different recording on the same page", () => {
    const picked = pickBeatportUrl(PLUTO, "CA5KR2489434");
    const others = (parseSearchTracks(PLUTO) ?? [])
      .filter((track) => track.isrc !== "CA5KR2489434")
      .map((track) => parseTrackLinks(PLUTO).get(String(track.track_id)));

    expect(picked).toHaveProperty("url", "https://www.beatport.com/track/pluto/19385810");
    expect(others).not.toContain("https://www.beatport.com/track/pluto/19385810");
  });

  it("misses cleanly when the ISRC matches a result Beatport rendered no link for", () => {
    // The slug cannot be derived and a fabricated one does not announce itself (a wrong slug still
    // serves the track, and the canonical tag echoes the wrong slug back). So an unlinked match is a
    // miss, never a guess.
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            dehydratedState: {
              queries: [
                {
                  state: { data: { tracks: { data: [{ isrc: "CA5KR2489434", track_id: 999 }] } } },
                },
              ],
            },
          },
        },
      }) +
      "</script>";

    expect(pickBeatportUrl(html, "CA5KR2489434")).toEqual({ ok: true, url: null });
  });

  it("reports a shape failure rather than a miss when the page cannot be read", () => {
    expect(pickBeatportUrl("<html><body>403</body></html>", "CA5KR2489434")).toEqual({ ok: false });
  });

  it("treats a genuinely empty result list as a clean miss", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            dehydratedState: { queries: [{ state: { data: { tracks: { data: [] } } } }] },
          },
        },
      }) +
      "</script>";

    expect(pickBeatportUrl(html, "CA5KR2489434")).toEqual({ ok: true, url: null });
  });
});

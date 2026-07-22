import { afterEach, describe, expect, it, vi } from "vitest";

import { searchDeezerCandidates } from "./deezer";

// The Deezer search client is a pure network→shape mapper for the pre-anchor ISRC-recovery rung. It
// must NEVER throw: every unhappy path (a blank query, a non-2xx, an error body, a malformed shape, a
// thrown/timed-out fetch) resolves to `[]`, because to the anchor waterfall those are all the same
// answer — "no recovery, fall to fuzzy". It normalizes only the fields the caller re-verifies against
// the row (isrc + duration promoted to ms + title + billed artist name), and DROPS any hit missing one.
// The response shape is pinned against the live API (verified 2026-07-22): each search hit already
// carries `isrc`, `duration` (seconds), `title`, and `artist.name`.

// One search hit in the exact shape Deezer returns — the real ISRC lives ON the search result, so no
// second by-id read is needed.
const HIT = {
  artist: { id: 12199, name: "Calibre" },
  duration: 132,
  id: 3263968181,
  isrc: "GBEXH1900314",
  title: "Mr Right On",
};

const body = (data: unknown[]) => Response.json({ data });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchDeezerCandidates", () => {
  it("maps a hit to a candidate (duration promoted to ms) and queries the precise field syntax", async () => {
    const fetchMock = vi.fn().mockResolvedValue(body([HIT]));
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await searchDeezerCandidates({
      artists: ["Calibre"],
      title: "Mr Right On",
    });

    expect(candidates).toEqual([
      { artistName: "Calibre", durationMs: 132_000, isrc: "GBEXH1900314", title: "Mr Right On" },
    ]);

    // It GETs the identified User-Agent to Deezer's `/search/track` with the `artist:"…" track:"…"`
    // field syntax (the precise query), bounded by an abort signal.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.deezer.com/search/track?q=");
    expect(decodeURIComponent(String(url))).toContain('artist:"Calibre" track:"Mr Right On"');
    expect((init as { headers: Record<string, string> }).headers["User-Agent"]).toBe(
      "Fluncle/1.0 (+https://www.fluncle.com)",
    );
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps only hits carrying a usable isrc + numeric duration + title + artist name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        body([
          HIT,
          { ...HIT, id: 2, isrc: "  " }, // blank ISRC → dropped
          { ...HIT, duration: 0, id: 3 }, // no duration → dropped
          { ...HIT, artist: { name: "" }, id: 4 }, // no artist → dropped
          { ...HIT, id: 5, title: undefined }, // no title → dropped
        ]),
      ),
    );

    const candidates = await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" });

    expect(candidates.map((candidate) => candidate.isrc)).toEqual(["GBEXH1900314"]);
  });

  it("returns [] without a fetch when the artist or title is blank", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchDeezerCandidates({ artists: [], title: "Mr Right On" })).toEqual([]);
    expect(await searchDeezerCandidates({ artists: ["Calibre"], title: "   " })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] on a clean miss (the endpoint answers { data: [] })", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body([])));

    expect(await searchDeezerCandidates({ artists: ["Nobody"], title: "Nothing" })).toEqual([]);
  });

  it("returns [] on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    expect(await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" })).toEqual(
      [],
    );
  });

  it("returns [] on a malformed body (data is not an array)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: 4 } })));

    expect(await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" })).toEqual(
      [],
    );
  });

  it("returns [] on a body that is not valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));

    expect(await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" })).toEqual(
      [],
    );
  });

  it("returns [] when the fetch throws or times out (never propagates)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" })).toEqual(
      [],
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deezerSearchQuery,
  enrichFromDeezer,
  lookupIsrcFromDeezer,
  searchDeezerCandidates,
} from "./deezer";

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

// The query spelling is now handed to the BOX (the anchor worklist's `deezerQuery`), because the
// Deezer FETCH runs there — its tokenless quota is per-IP and the Worker's shared edge IPs are
// saturated. So this builder has to be exactly one function, exported, with no second spelling
// anywhere: a sweep that invented its own would silently ask a different question.
describe("deezerSearchQuery — the one spelling, shared with the box", () => {
  it("builds Deezer's field syntax over the FIRST artist and the canonicalized title", () => {
    expect(deezerSearchQuery(["Calibre", "DRS"], "Mr Right On")).toBe(
      'artist:"Calibre" track:"Mr Right On"',
    );
    expect(deezerSearchQuery(["Minos"], "Feels Like Before (Air.K & Cephei rmx)")).toBe(
      'artist:"Minos" track:"Feels Like Before (Air.K & Cephei Remix)"',
    );
  });

  it("strips quotes, which would otherwise close the field syntax's own", () => {
    expect(deezerSearchQuery(['The "Boss"'], 'A "Loud" Tune')).toBe(
      'artist:"The  Boss" track:"A  Loud  Tune"',
    );
  });

  it("is undefined when there is no usable artist or title to ask with", () => {
    expect(deezerSearchQuery([], "Mr Right On")).toBeUndefined();
    expect(deezerSearchQuery(["Calibre"], "   ")).toBeUndefined();
  });

  it("is the spelling the client itself sends — one owner, no drift", async () => {
    const fetchMock = vi.fn().mockResolvedValue(body([HIT]));
    vi.stubGlobal("fetch", fetchMock);

    await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(decodeURIComponent(String(url))).toContain(
      deezerSearchQuery(["Calibre"], "Mr Right On") ?? "never",
    );
  });
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
      {
        artistName: "Calibre",
        deezerTrackId: "3263968181",
        durationMs: 132_000,
        isrc: "GBEXH1900314",
        title: "Mr Right On",
      },
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

  it("asks in the canonical query spelling, the same one every other anchor rung sends", async () => {
    const fetchMock = vi.fn().mockResolvedValue(body([HIT]));
    vi.stubGlobal("fetch", fetchMock);

    await searchDeezerCandidates({
      artists: ["Minos"],
      title: "Feels Like Before (Air.K & Cephei rmx)",
    });

    // `rmx` → `Remix`: Deezer indexes the canonical spelling, so the raw one recovers no ISRC at all.
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(decodeURIComponent(String(url))).toContain(
      'artist:"Minos" track:"Feels Like Before (Air.K & Cephei Remix)"',
    );
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ something: "else" })));

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

// ── THE QUOTA TRAP ───────────────────────────────────────────────────────────────────────────────
// The regression that made this rung recover NOTHING in production for a week. Deezer answers a
// throttle with **HTTP 200** and an error body instead of a result set — reproduced live against the
// real endpoint (120 requests: all 200, the 93rd onward carrying
// `{"error":{"type":"Exception","message":"Quota limit exceeded","code":4}}`). That walks past
// `response.ok`, parses as valid JSON, and leaves `data` absent, so a client that only asks
// "is `data` an array?" reads a THROTTLE as a clean MISS. The Worker egresses from Cloudflare's
// SHARED edge IPs, where that quota is saturated by the whole platform, so the branch was taken on
// every single call. A throttle must never again be indistinguishable from "no such track".

/** Deezer's real quota answer, verbatim — a 200 with an error body and NO `data`. */
const QUOTA_BODY = { error: { code: 4, message: "Quota limit exceeded", type: "Exception" } };

const quotaResponse = () => Response.json(QUOTA_BODY);

describe("searchDeezerCandidates — the Deezer quota answer (HTTP 200 + error body)", () => {
  it("does NOT treat a quota error as a miss: it retries and returns the recovered candidates", async () => {
    // Throttled twice, then a real result set — exactly the shared-egress-IP shape.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(body([HIT]));
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await searchDeezerCandidates(
      { artists: ["Calibre"], title: "Mr Right On" },
      [0, 0],
    );

    // Before the fix this was `[]` — the ISRC was on the wire and thrown away.
    expect(candidates).toEqual([
      {
        artistName: "Calibre",
        deezerTrackId: "3263968181",
        durationMs: 132_000,
        isrc: "GBEXH1900314",
        title: "Mr Right On",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the bounded retry budget rather than hammering a saturated quota", async () => {
    // A FRESH Response per call — a body can only be read once, so a shared one would fail the
    // second read for the wrong reason and hide whether the retry budget is really being spent.
    const fetchMock = vi.fn().mockImplementation(() => quotaResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" }, [0, 0]),
    ).toEqual([]);

    // One initial attempt + exactly the two configured retries — never an unbounded loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a genuine empty result set a one-shot miss (a miss is still a miss)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(body([]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchDeezerCandidates({ artists: ["Nobody"], title: "Nothing" }, [0, 0])).toEqual(
      [],
    );

    // `data: []` is an ANSWER, not a throttle — retrying it would trade a free rung for wasted calls.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-quota Deezer exception (it is not going to un-fail)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: 200, message: "Invalid query", type: "Exception" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" }, [0, 0]),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-2xx response either", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" }, [0, 0]),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── THE TRACK ID, AND THE GATES ON KEEPING IT ────────────────────────────────────────────────────
// Deezer's own track id has always been in these responses and was always dropped. It is kept now,
// because a verified id becomes `https://www.deezer.com/track/<id>` on `/identity`. Which is exactly
// why neither read hands one back bare: an unverified id is a wrong link on a public page under a
// recording's name, and the honest answer to "not sure" is nothing at all.
describe("lookupIsrcFromDeezer — the by-name ISRC fallback, and the hit it returns", () => {
  it("returns the duration-confirmed hit whole, id included, with the detail read's ISRC", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(body([HIT]))
      .mockResolvedValueOnce(Response.json({ isrc: "GBEXH1900314" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await lookupIsrcFromDeezer({
        artists: ["Calibre"],
        durationMs: 132_000,
        title: "Mr Right On",
      }),
    ).toEqual({
      artistName: "Calibre",
      deezerTrackId: "3263968181",
      durationMs: 132_000,
      isrc: "GBEXH1900314",
      title: "Mr Right On",
    });

    // Unchanged: the search, then the by-id detail read that carries the ISRC.
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.deezer.com/track/3263968181");
  });

  it("still refuses a hit whose duration disagrees — a wrong ISRC seeds a permanent wrong Log ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(body([{ ...HIT, duration: 300 }]));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await lookupIsrcFromDeezer({
        artists: ["Calibre"],
        durationMs: 132_000,
        title: "Mr Right On",
      }),
    ).toBeUndefined();
    // No detail read was even made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("enrichFromDeezer — the by-ISRC read, and the duration guard on its id", () => {
  const isrcTrack = (over: Record<string, unknown> = {}) =>
    Response.json({
      duration: 132,
      id: 3263968181,
      preview: "https://cdn.deezer.com/p.mp3",
      ...over,
    });

  it("keeps the id when the returned track's duration confirms the row's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(isrcTrack()).mockResolvedValue(Response.json({})),
    );

    expect(await enrichFromDeezer("GBEXH1900314", 132_000)).toEqual({
      deezerTrackId: "3263968181",
      label: undefined,
      previewUrl: "https://cdn.deezer.com/p.mp3",
    });
  });

  it("keeps NO id when the caller has no duration to vouch with", async () => {
    // `/track/isrc:` PICKS a recording and picks wrong ~7% of the time. With nothing to check the
    // pick against, the label and the preview still ride it (a mismatched 30s clip is a small
    // wrong) and the LINK does not (a wrong link under a recording's name is not).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(isrcTrack()).mockResolvedValue(Response.json({})),
    );

    const enrichment = await enrichFromDeezer("GBEXH1900314");

    expect(enrichment.deezerTrackId).toBeUndefined();
    expect(enrichment.previewUrl).toBe("https://cdn.deezer.com/p.mp3");
  });

  it("keeps NO id when the durations disagree — that is the ~7% mispick, caught", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(isrcTrack({ duration: 300 }))
        .mockResolvedValue(Response.json({})),
    );

    const enrichment = await enrichFromDeezer("GBEXH1900314", 132_000);

    expect(enrichment.deezerTrackId).toBeUndefined();
    // The label/preview behaviour is untouched by the guard — only the link is gated.
    expect(enrichment.previewUrl).toBe("https://cdn.deezer.com/p.mp3");
  });
});

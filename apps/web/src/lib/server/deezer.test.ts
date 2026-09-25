import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deezerSearchQuery,
  enrichFromDeezer,
  lookupDeezerTrackByIsrc,
  lookupIsrcFromDeezer,
  searchDeezerCandidates,
} from "./deezer";

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

describe("deezerSearchQuery — the one spelling, shared with the box", () => {
  it("asks in FREE TEXT — every credited artist, then the canonicalized title", () => {
    expect(deezerSearchQuery(["Calibre", "DRS"], "Mr Right On")).toBe("Calibre DRS Mr Right On");
    expect(deezerSearchQuery(["Minos"], "Feels Like Before (Air.K & Cephei rmx)")).toBe(
      "Minos Feels Like Before (Air.K & Cephei Remix)",
    );
  });

  it("NEVER emits the combined field syntax, which answers empty for every input", () => {
    const query = deezerSearchQuery(["Noisia"], "Stigma") ?? "";

    expect(query).not.toContain("artist:");
    expect(query).not.toContain("track:");
  });

  it("strips double quotes, which Deezer reads as an unclosed phrase operator", () => {
    expect(deezerSearchQuery(['The "Boss"'], 'A "Loud" Tune')).toBe("The Boss A Loud Tune");
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
  it("maps a hit to a candidate (duration promoted to ms) and queries the one free-text spelling", async () => {
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

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.deezer.com/search/track?q=");
    expect(decodeURIComponent(String(url))).toContain("q=Calibre Mr Right On");
    expect((init as { headers: Record<string, string> }).headers["User-Agent"]).toBe(
      "Fluncle/1.0 (+https://www.fluncle.com)",
    );
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps only hits carrying a usable isrc + numeric duration + title + artist name", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          body([
            HIT,
            { ...HIT, id: 2, isrc: "  " },
            { ...HIT, duration: 0, id: 3 },
            { ...HIT, artist: { name: "" }, id: 4 },
            { ...HIT, id: 5, title: undefined },
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

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(decodeURIComponent(String(url))).toContain(
      "q=Minos Feels Like Before (Air.K & Cephei Remix)",
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

const QUOTA_BODY = { error: { code: 4, message: "Quota limit exceeded", type: "Exception" } };

const quotaResponse = () => Response.json(QUOTA_BODY);

describe("searchDeezerCandidates — the Deezer quota answer (HTTP 200 + error body)", () => {
  it("does NOT treat a quota error as a miss: it retries and returns the recovered candidates", async () => {
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
    const fetchMock = vi.fn().mockImplementation(() => quotaResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await searchDeezerCandidates({ artists: ["Calibre"], title: "Mr Right On" }, [0, 0]),
    ).toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a genuine empty result set a one-shot miss (a miss is still a miss)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(body([]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchDeezerCandidates({ artists: ["Nobody"], title: "Nothing" }, [0, 0])).toEqual(
      [],
    );

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

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a same-title, same-duration hit billed to another act", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(body([{ ...HIT, artist: { id: 1, name: "Some Other Act" } }]));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await lookupIsrcFromDeezer({
        artists: ["Calibre"],
        durationMs: 132_000,
        title: "Mr Right On",
      }),
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses the right act's REMIX when the row is the original", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(body([{ ...HIT, title: "Mr Right On (Sub Focus Remix)" }]));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await lookupIsrcFromDeezer({
        artists: ["Calibre"],
        durationMs: 132_000,
        title: "Mr Right On",
      }),
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes the identity-matching hit even when a closer-ranked stranger leads the page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        body([{ ...HIT, artist: { id: 1, name: "Some Other Act" }, id: 99 }, HIT]),
      )
      .mockResolvedValueOnce(Response.json({ isrc: "GBEXH1900314" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await lookupIsrcFromDeezer({
        artists: ["Calibre"],
        durationMs: 132_000,
        title: "Mr Right On",
      }),
    ).toMatchObject({ artistName: "Calibre", deezerTrackId: "3263968181" });
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

    expect(enrichment.previewUrl).toBe("https://cdn.deezer.com/p.mp3");
  });
});

describe("lookupDeezerTrackByIsrc — the ledger-grade by-ISRC read", () => {
  const track = (over: Record<string, unknown> = {}) =>
    Response.json({ duration: 300, id: 3263968181, title: "Mr Right On", ...over });

  it("MATCHES when the duration vouches for Deezer's pick", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(track()));

    expect(await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).toEqual({
      deezerTrackId: "3263968181",
      outcome: "matched",
    });
  });

  it("matches inside the ratified tolerance and refuses just outside it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(track({ duration: 304 })));
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("matched");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(track({ duration: 306 })));
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("unvouchable");
  });

  it("is UNVOUCHABLE when Deezer sends no duration, or the row has none to check against", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(track({ duration: undefined })));
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("unvouchable");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 0)).outcome).toBe("unvouchable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the HTTP-200 QUOTA body as a throttle, never as a miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 4, message: "Quota limit exceeded", type: "Exception" } }),
        ),
    );

    expect(await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).toEqual({ outcome: "quota" });
  });

  it("reads a DataException as ABSENT — the one negative worth stamping", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 800, message: "no data", type: "DataException" } }),
        ),
    );

    expect(await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).toEqual({ outcome: "absent" });
  });

  it("treats every OTHER error code as a transport failure, never as absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 700, message: "Service busy", type: "Exception" } }),
        ),
    );

    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("failed");
  });

  it("never throws: a non-2xx, an unparseable body, and a thrown fetch all map to failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("failed");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("failed");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket closed")));
    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("failed");
  });

  it("a 200 carrying neither an error nor an id is failed, not absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));

    expect((await lookupDeezerTrackByIsrc("GBEXH1900314", 300_000)).outcome).toBe("failed");
  });
});

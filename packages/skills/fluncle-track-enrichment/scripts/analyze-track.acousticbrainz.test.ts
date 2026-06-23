// Focused test for the AcousticBrainz-by-ISRC BPM fallback in analyze-track.ts.
//
// Tests ONLY `acousticBrainzBpmByIsrc` in isolation, with an injected mock fetch
// so it never touches the network. Importing analyze-track.ts is safe because the
// CLI pipeline is guarded by `if (import.meta.main)` — the import does not run it.

import { describe, expect, test } from "bun:test";

import { acousticBrainzBpmByIsrc } from "./analyze-track.ts";

// A mock fetch that maps URL substrings → responses, and records every call so a
// test can assert it was (or was not) invoked. Anything unmatched throws, which
// would surface as a test failure rather than a silent real network call.
function mockFetch(
  routes: Array<{ body: unknown; match: string; ok?: boolean; status?: number }>,
): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    const route = routes.find((r) => url.includes(r.match));

    if (!route) {
      throw new Error(`unexpected fetch: ${url}`);
    }

    return {
      json: async () => route.body,
      ok: route.ok ?? true,
      status: route.status ?? 200,
    } as Response;
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

const MBID = "11111111-2222-3333-4444-555555555555";

describe("acousticBrainzBpmByIsrc", () => {
  test("ISRC + AcousticBrainz hit → returns the in-band folded BPM", async () => {
    const { calls, fetch } = mockFetch([
      { body: { recordings: [{ id: MBID }] }, match: "musicbrainz.org" },
      { body: { rhythm: { bpm: 174 } }, match: "acousticbrainz.org" },
    ]);

    const bpm = await acousticBrainzBpmByIsrc("GB5KW1701923", fetch);

    expect(bpm).toBe(174);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("musicbrainz.org");
    expect(calls[0]).toContain("isrc:GB5KW1701923");
    expect(calls[1]).toContain(`acousticbrainz.org/api/v1/${MBID}/low-level`);
  });

  test("ISRC + half-tempo AcousticBrainz BPM → octave-folds up into the band", async () => {
    const { fetch } = mockFetch([
      { body: { recordings: [{ id: MBID }] }, match: "musicbrainz.org" },
      { body: { rhythm: { bpm: 87 } }, match: "acousticbrainz.org" },
    ]);

    // 87 × 2 = 174, which lands in [160,185].
    expect(await acousticBrainzBpmByIsrc("ISRC0001", fetch)).toBe(174);
  });

  test("no ISRC → returns null without calling fetch", async () => {
    const { calls, fetch } = mockFetch([]);

    expect(await acousticBrainzBpmByIsrc(undefined, fetch)).toBeNull();
    expect(await acousticBrainzBpmByIsrc("", fetch)).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("AcousticBrainz 404 (not in the archive) → null", async () => {
    const { fetch } = mockFetch([
      { body: { recordings: [{ id: MBID }] }, match: "musicbrainz.org" },
      { body: {}, match: "acousticbrainz.org", ok: false, status: 404 },
    ]);

    expect(await acousticBrainzBpmByIsrc("ISRC0002", fetch)).toBeNull();
  });

  test("empty MusicBrainz recordings → null (no AcousticBrainz call)", async () => {
    const { calls, fetch } = mockFetch([{ body: { recordings: [] }, match: "musicbrainz.org" }]);

    expect(await acousticBrainzBpmByIsrc("ISRC0003", fetch)).toBeNull();
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("musicbrainz.org");
  });

  test("missing rhythm.bpm field → null", async () => {
    const { fetch } = mockFetch([
      { body: { recordings: [{ id: MBID }] }, match: "musicbrainz.org" },
      { body: { rhythm: {} }, match: "acousticbrainz.org" },
    ]);

    expect(await acousticBrainzBpmByIsrc("ISRC0004", fetch)).toBeNull();
  });

  test("non-numeric BPM → null", async () => {
    const { fetch } = mockFetch([
      { body: { recordings: [{ id: MBID }] }, match: "musicbrainz.org" },
      { body: { rhythm: { bpm: "fast" } }, match: "acousticbrainz.org" },
    ]);

    expect(await acousticBrainzBpmByIsrc("ISRC0005", fetch)).toBeNull();
  });

  test("BPM that cannot octave-fold into the D&B band → null (in-band discipline)", async () => {
    const { fetch } = mockFetch([
      { body: { recordings: [{ id: MBID }] }, match: "musicbrainz.org" },
      // 100 → ×2=200 (over), ×1=100, ×0.5=50: nothing lands in [160,185].
      { body: { rhythm: { bpm: 100 } }, match: "acousticbrainz.org" },
    ]);

    expect(await acousticBrainzBpmByIsrc("ISRC0006", fetch)).toBeNull();
  });

  test("MusicBrainz network error → null (best-effort)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await acousticBrainzBpmByIsrc("ISRC0007", fetchImpl)).toBeNull();
  });
});

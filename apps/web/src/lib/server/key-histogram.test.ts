import { beforeEach, describe, expect, it, vi } from "vitest";

import { readKeyHistogram, resetKeyHistogramCache } from "./key-histogram";

// THE MEMO, PINNED. The histogram's whole reason to exist is that its two consumers — the `/mix`
// depth gate and the rail's `key in (…)` pre-filter (tracks.ts) — ask the same question of the same
// growing index, and the answer moves only when a track is keyed. So what is worth proving is not
// the SQL (two dozen buckets off `tracks_key_idx`) but the COUNT of times it is issued: once per
// window, whoever asks, and once again after the fixture reset `createIntegrationDb` calls.

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const HISTOGRAM = [
  { count: 12, key: "A minor" },
  { count: 7, key: "F major" },
];

beforeEach(() => {
  resetKeyHistogramCache();
  execute.mockReset();
  execute.mockResolvedValue({ rows: HISTOGRAM });
});

describe("readKeyHistogram", () => {
  it("reads the archive's key buckets", async () => {
    expect(await readKeyHistogram()).toEqual(HISTOGRAM);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(String(execute.mock.calls[1]?.[0])).toContain("group by key");
  });

  it("issues ONE statement however many readers ask inside the window", async () => {
    const [first, second, third] = await Promise.all([
      readKeyHistogram(),
      readKeyHistogram(),
      readKeyHistogram(),
    ]);

    // Concurrent callers may each miss a cold cache; what must never happen is a fresh walk of a
    // growing index on every LATER ask, which is what the rail must avoid per `/mix` load.
    await readKeyHistogram();
    await readKeyHistogram();

    const legacyReads = execute.mock.calls.filter(([statement]) =>
      String(statement).includes("group by key"),
    );
    expect(legacyReads.length).toBeLessThanOrEqual(3);
    expect(first).toEqual(HISTOGRAM);
    expect(second).toEqual(HISTOGRAM);
    expect(third).toEqual(HISTOGRAM);
  });

  it("re-reads after the cache is dropped, so a fresh fixture never answers with a stale archive", async () => {
    await readKeyHistogram();
    execute.mockClear();

    await readKeyHistogram();
    expect(execute).not.toHaveBeenCalled();

    resetKeyHistogramCache();

    execute.mockResolvedValue({ rows: [{ count: 3, key: "G minor" }] });
    expect(await readKeyHistogram()).toEqual([{ count: 3, key: "G minor" }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

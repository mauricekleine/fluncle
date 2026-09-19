import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** How many times the archive's `group by key` walk was actually issued. */
function histogramReads(): number {
  return execute.mock.calls.filter(([statement]) => String(statement).includes("group by key"))
    .length;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  resetKeyHistogramCache();
  execute.mockReset();
  execute.mockResolvedValue({ rows: HISTOGRAM });
});

afterEach(() => {
  vi.useRealTimers();
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

    await readKeyHistogram();
    await readKeyHistogram();

    // Concurrent cold callers share ONE in-flight read. A burst of `/mix` rails arriving at a
    // fresh isolate together is exactly the shape that would otherwise multiply a walk of an
    // index that grows with the catalogue, once per rail.
    expect(histogramReads()).toBe(1);
    expect(first).toEqual(HISTOGRAM);
    expect(second).toEqual(HISTOGRAM);
    expect(third).toEqual(HISTOGRAM);
  });

  it("answers from the stale memo and refreshes behind the reader", async () => {
    await readKeyHistogram();
    execute.mockClear();
    execute.mockResolvedValue({ rows: [{ count: 3, key: "G minor" }] });

    // Past the window. The reader is not made to wait for the walk: it gets the remembered
    // spellings, and only the NEXT reader sees the refreshed ones. Exactly one caller per isolate
    // ever pays this read — the first.
    vi.setSystemTime(Date.now() + 11 * 60_000);

    expect(await readKeyHistogram()).toEqual(HISTOGRAM);
    await vi.waitFor(() => expect(histogramReads()).toBe(1));
    expect(await readKeyHistogram()).toEqual([{ count: 3, key: "G minor" }]);
  });

  it("keeps the remembered spellings when a refresh fails, and retries on the next ask", async () => {
    await readKeyHistogram();
    execute.mockClear();
    execute.mockRejectedValue(new Error("database unavailable"));

    vi.setSystemTime(Date.now() + 11 * 60_000);

    // A failed background refresh is never the reader's problem: the rail keeps its pre-filter.
    expect(await readKeyHistogram()).toEqual(HISTOGRAM);
    await vi.waitFor(() => expect(histogramReads()).toBe(1));

    execute.mockResolvedValue({ rows: [{ count: 3, key: "G minor" }] });
    expect(await readKeyHistogram()).toEqual(HISTOGRAM);
    await vi.waitFor(() => expect(histogramReads()).toBe(2));
    expect(await readKeyHistogram()).toEqual([{ count: 3, key: "G minor" }]);
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

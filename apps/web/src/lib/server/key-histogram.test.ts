import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readKeyHistogram, resetKeyHistogramCache } from "./key-histogram";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const HISTOGRAM = [
  { count: 12, key: "A minor" },
  { count: 7, key: "F major" },
];

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

    expect(histogramReads()).toBe(1);
    expect(first).toEqual(HISTOGRAM);
    expect(second).toEqual(HISTOGRAM);
    expect(third).toEqual(HISTOGRAM);
  });

  it("answers from the stale memo and refreshes behind the reader", async () => {
    await readKeyHistogram();
    execute.mockClear();
    execute.mockResolvedValue({ rows: [{ count: 3, key: "G minor" }] });

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

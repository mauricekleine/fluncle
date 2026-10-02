import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: (...args: unknown[]) => getDb(...args),
}));

const { getEurRates } = await import("./fx");

const FRANKFURTER_MATCH = "frankfurter.dev";
const FRANKFURTER_BODY = [
  { base: "EUR", date: "2026-07-09", quote: "USD", rate: 1.18 },
  { base: "EUR", date: "2026-07-09", quote: "GBP", rate: 0.86 },
];

function cacheRow(fetchedAt: string) {
  return {
    fetched_at: fetchedAt,
    rates_date: "2026-07-01",
    rates_json: JSON.stringify({ USD: 1.05 }),
  };
}

function mockDb(selectRows: Record<string, unknown>[]) {
  execute.mockImplementation((query: { sql: string }) =>
    query.sql.includes("select")
      ? Promise.resolve({ rows: selectRows })
      : Promise.resolve({ rows: [] }),
  );
  getDb.mockResolvedValue({ execute });
}

function mockFetch(ok: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = typeof input === "string" ? input : String(input);

      if (url.includes(FRANKFURTER_MATCH)) {
        return ok ? Response.json(FRANKFURTER_BODY) : new Response("down", { status: 503 });
      }

      return new Response("not found", { status: 404 });
    }),
  );
}

beforeEach(() => {
  execute.mockReset();
  getDb.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getEurRates read-through cache", () => {
  it("serves a fresh cache without hitting the network", async () => {
    mockDb([cacheRow(new Date().toISOString())]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await getEurRates();

    expect(result).toEqual({ rates: { USD: 1.05 }, ratesDate: "2026-07-01" });
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refetches + upserts when the cache is stale", async () => {
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    mockDb([cacheRow(stale)]);
    mockFetch(true);

    const result = await getEurRates();

    expect(result).toEqual({ rates: { GBP: 0.86, USD: 1.18 }, ratesDate: "2026-07-09" });

    expect(execute).toHaveBeenCalledTimes(2);
    const upsert = execute.mock.calls.find((call) => String(call[0]?.sql ?? "").includes("insert"));
    expect(upsert).toBeDefined();
  });

  it("fetches + upserts when there is no cache at all", async () => {
    mockDb([]);
    mockFetch(true);

    const result = await getEurRates();

    expect(result).toEqual({ rates: { GBP: 0.86, USD: 1.18 }, ratesDate: "2026-07-09" });
  });

  it("falls back to the stale cache when the fetch fails", async () => {
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    mockDb([cacheRow(stale)]);
    mockFetch(false);

    const result = await getEurRates();

    expect(result).toEqual({ rates: { USD: 1.05 }, ratesDate: "2026-07-01" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no cache and the fetch fails", async () => {
    mockDb([]);
    mockFetch(false);

    expect(await getEurRates()).toBeNull();
  });
});

describe("exchange rate request deadlines and diagnostics", () => {
  it.each(["headers", "body"])("uses stale rates when %s exceed the deadline", async (phase) => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDb([cacheRow(new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString())]);
    const delay = <T>(value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), 4001));
    const response = {
      json: () => (phase === "body" ? delay(FRANKFURTER_BODY) : Promise.resolve(FRANKFURTER_BODY)),
      ok: true,
    };
    const fetchSpy = vi.fn((_input: unknown, _init?: RequestInit) =>
      phase === "headers" ? delay(response) : Promise.resolve(response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = getEurRates();
    await vi.advanceTimersByTimeAsync(4001);

    await expect(result).resolves.toEqual({ rates: { USD: 1.05 }, ratesDate: "2026-07-01" });
    expect(execute).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal?.aborted).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"failure":"FxTimeout"'));
  });

  it.each([
    { failure: "FxHttpFailed", response: new Response(null, { status: 503 }) },
    { failure: "FxParseFailed", response: new Response("invalid JSON") },
    { failure: "FxParseFailed", response: Response.json([]) },
    { failure: "FxUnreachable", response: new TypeError("offline") },
  ])("returns null and diagnoses $failure", async ({ failure, response }) => {
    mockDb([]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
      ),
    );

    await expect(getEurRates()).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`"failure":"${failure}"`));
  });
});

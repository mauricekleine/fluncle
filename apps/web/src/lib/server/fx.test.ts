import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getEurRates is a read-through daily cache over Frankfurter. The guarantees under test:
//   1. a FRESH cache is served without touching the network;
//   2. a STALE / missing cache triggers a fetch, which is upserted and returned;
//   3. a fetch FAILURE degrades gracefully — stale cache if present, else null — never throws.

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

// A `select` returns the given cache rows; an `insert` (the upsert) returns nothing.
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
    // Only the SELECT ran — no upsert on a fresh hit.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refetches + upserts when the cache is stale", async () => {
    // 13h old (past the 12h staleness window).
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    mockDb([cacheRow(stale)]);
    mockFetch(true);

    const result = await getEurRates();

    expect(result).toEqual({ rates: { GBP: 0.86, USD: 1.18 }, ratesDate: "2026-07-09" });
    // SELECT + upsert INSERT.
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

    // The stale rate is better than nothing; no upsert on a failed fetch.
    expect(result).toEqual({ rates: { USD: 1.05 }, ratesDate: "2026-07-01" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no cache and the fetch fails", async () => {
    mockDb([]);
    mockFetch(false);

    expect(await getEurRates()).toBeNull();
  });
});

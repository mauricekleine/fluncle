import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CostEventInput } from "@fluncle/contracts/orpc";

// COST-01 ledger write + read. The db is mocked: the insert path EMULATES an
// append-only table with a UNIQUE id (ON CONFLICT(id) DO NOTHING) so idempotency is
// exercised for real, and the read path returns canned GROUP BY rows so the cash /
// subsidized split + unpriced accounting can be asserted precisely.

// The emulated table's id-set + a hook to force a write failure (best-effort test).
const insertedIds = new Set<string>();
let failInsert = false;

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
}));

vi.mock("./artists", () => ({
  parseArtistsJson: (value: string) => JSON.parse(value) as string[],
}));

const { captureCostEvents, costEventId, getCostInsights, insertCostEvents, resolveEstimatedUsd } =
  await import("./costs");

function event(overrides: Partial<CostEventInput> & Pick<CostEventInput, "id">): CostEventInput {
  return {
    costBasis: "cash",
    occurredAt: "2026-07-01T00:00:00.000Z",
    quantity: 1,
    source: "measured",
    step: "context",
    unitType: "requests",
    vendor: "firecrawl",
    ...overrides,
  };
}

beforeEach(() => {
  insertedIds.clear();
  failInsert = false;
  execute.mockReset().mockImplementation(async (query: { args?: unknown[]; sql: string }) => {
    const sql = query.sql;

    if (sql.includes("insert into cost_events")) {
      if (failInsert) {
        throw new Error("simulated turso failure");
      }

      // Emulate ON CONFLICT(id) DO NOTHING: the id is the first column of each
      // 13-wide value tuple. Count only the ids not already present.
      const args = query.args ?? [];
      let affected = 0;

      for (let i = 0; i < args.length; i += 13) {
        const id = String(args[i]);

        if (!insertedIds.has(id)) {
          insertedIds.add(id);
          affected += 1;
        }
      }

      return { rowsAffected: affected };
    }

    return { rows: [] };
  });
});

describe("resolveEstimatedUsd", () => {
  it("uses the emitter's own usd verbatim when present (anthropic envelope)", () => {
    expect(
      resolveEstimatedUsd(
        event({ id: "a", model: "claude-sonnet-4-6", usd: 0.0459, vendor: "anthropic" }),
      ),
    ).toBe(0.0459);
  });

  it("prices a cash single-count row from the rate map", () => {
    // firecrawl requests × 1 = 0.0016.
    expect(resolveEstimatedUsd(event({ id: "b", quantity: 1, vendor: "firecrawl" }))).toBeCloseTo(
      0.0016,
      10,
    );
  });

  it("returns null (stored UNPRICED, never $0) on a rate miss", () => {
    expect(resolveEstimatedUsd(event({ id: "c", unitType: "seconds", vendor: "self" }))).toBeNull();
  });
});

describe("insertCostEvents idempotency", () => {
  it("inserts a fresh batch once and IGNORES a re-POST of the same ids", async () => {
    const batch = [event({ id: "e1" }), event({ id: "e2" })];

    expect(await insertCostEvents(batch)).toBe(2);
    // The retry: same ids → ON CONFLICT DO NOTHING → zero inserted.
    expect(await insertCostEvents(batch)).toBe(0);
    // A partial overlap only inserts the new one.
    expect(await insertCostEvents([event({ id: "e2" }), event({ id: "e3" })])).toBe(1);
  });

  it("issues the ON CONFLICT(id) DO NOTHING insert", async () => {
    await insertCostEvents([event({ id: "x" })]);

    const sql = String(execute.mock.calls[0]?.[0]?.sql ?? "");
    expect(sql).toContain("on conflict(id) do nothing");
  });

  it("no-ops on an empty batch (no query)", async () => {
    expect(await insertCostEvents([])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("captureCostEvents (best-effort)", () => {
  it("swallows a write failure — NEVER throws into the vendor op", async () => {
    failInsert = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The guarantee: a ledger failure resolves quietly, so the caller's real work
    // (the note / observation / email) is unaffected.
    await expect(captureCostEvents([event({ id: "boom" })])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});

describe("costEventId", () => {
  it("is deterministic and scopes by logId → trackId → global", () => {
    const key = costEventId({
      logId: "004.7.2I",
      occurredAt: "t",
      step: "observe",
      trackId: "track-1",
      unitType: "characters",
      vendor: "cartesia",
    });
    expect(key).toBe("observe:004.7.2I:cartesia:characters:t");

    // No logId → trackId scope; no finding at all → "global".
    expect(
      costEventId({ occurredAt: "t", step: "newsletter", unitType: "emails", vendor: "resend" }),
    ).toBe("newsletter:global:resend:emails:t");
  });
});

describe("getCostInsights aggregation", () => {
  it("keeps cash and subsidized in SEPARATE columns (never summed) + counts unpriced", async () => {
    execute.mockImplementation(async (query: { sql: string }) => {
      if (query.sql.includes("group by step")) {
        return {
          rows: [
            {
              cash_usd: 0.05,
              event_count: 4,
              step: "context",
              subsidized_usd: 0,
              unpriced_count: 0,
            },
            {
              cash_usd: 0,
              event_count: 3,
              step: "video",
              subsidized_usd: 0,
              unpriced_count: 3,
            },
            {
              cash_usd: 0.02,
              event_count: 2,
              step: "observe",
              subsidized_usd: 1.5,
              unpriced_count: 1,
            },
          ],
        };
      }

      if (query.sql.includes("group by ce.track_id")) {
        return {
          rows: [
            {
              album_image_url: "https://img/x.jpg",
              artists_json: '["Calibre"]',
              cash_usd: 0.04,
              event_count: 2,
              log_id: "004.7.2I",
              title: "Mr Right On",
              track_id: "track-1",
            },
          ],
        };
      }

      return { rows: [] };
    });

    const insights = await getCostInsights();

    // The totals: cash = Σ cash only; subsidized = Σ subsidized only; NEVER blended.
    expect(insights.totals.cashUsd).toBeCloseTo(0.07, 10); // 0.05 + 0 + 0.02
    expect(insights.totals.subsidizedUsd).toBeCloseTo(1.5, 10); // 0 + 0 + 1.5
    expect(insights.totals.unpricedCount).toBe(4); // 0 + 3 + 1
    // The load-bearing invariant: the two are not added into one number anywhere.
    expect(insights.totals.cashUsd).not.toBeCloseTo(
      insights.totals.cashUsd + insights.totals.subsidizedUsd,
      10,
    );

    const observe = insights.steps.find((step) => step.step === "observe");
    expect(observe?.cashUsd).toBeCloseTo(0.02, 10);
    expect(observe?.subsidizedUsd).toBeCloseTo(1.5, 10);
    expect(observe?.unpricedCount).toBe(1);

    // The per-finding rollup joins tracks + parses the artists JSON.
    expect(insights.topFindings).toHaveLength(1);
    expect(insights.topFindings[0]).toMatchObject({
      artists: ["Calibre"],
      cashUsd: 0.04,
      logId: "004.7.2I",
      title: "Mr Right On",
      trackId: "track-1",
    });
  });

  it("windows by occurred_at (passes the since bound as an arg)", async () => {
    await getCostInsights({ windowDays: 7 });

    const stepCall = execute.mock.calls.find((call) =>
      String(call[0]?.sql ?? "").includes("group by step"),
    );
    expect(stepCall?.[0]?.args?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

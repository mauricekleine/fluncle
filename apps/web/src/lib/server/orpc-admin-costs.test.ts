import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// COST-01 `record_cost` driven end-to-end through `handleOrpc` against
// `/api/v1/admin/costs/events`, so the REAL admin auth spine runs and only the db
// is mocked (an emulated append-only table with a UNIQUE id). Proves: agent-tier
// auth (the box's agent token POSTs; anon 401s), the `{ ok, inserted }` ack, and
// idempotency THROUGH the endpoint (a re-POST of the same ids inserts zero).

const insertedIds = new Set<string>();

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
}));

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  insertedIds.clear();
  execute.mockReset().mockImplementation(async (query: { args?: unknown[]; sql: string }) => {
    if (query.sql.includes("insert into cost_events")) {
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

const BATCH = [
  {
    costBasis: "subsidized" as const,
    id: "note:004.7.2I:anthropic:tokens:2026-07-01T00:00:00.000Z",
    model: "claude-sonnet-4-6",
    occurredAt: "2026-07-01T00:00:00.000Z",
    quantity: 39257,
    source: "measured" as const,
    step: "note" as const,
    trackId: "track-1",
    unitType: "tokens" as const,
    usd: 0.0459,
    vendor: "anthropic" as const,
  },
];

describe("record_cost — POST /admin/costs/events", () => {
  it("agent token POSTs a batch and gets { ok, inserted }", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/costs/events", "POST", AGENT_TOKEN, BATCH));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ inserted: 1, ok: true });
  });

  it("is IDEMPOTENT through the endpoint — a re-POST of the same ids inserts zero", async () => {
    const { handleOrpc } = await import("./orpc");

    const first = await handleOrpc(req("/admin/costs/events", "POST", AGENT_TOKEN, BATCH));
    expect(await readJson(first)).toEqual({ inserted: 1, ok: true });

    const retry = await handleOrpc(req("/admin/costs/events", "POST", AGENT_TOKEN, BATCH));
    expect(await readJson(retry)).toEqual({ inserted: 0, ok: true });
  });

  it("401s an anonymous POST (no token)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/costs/events", "POST", undefined, BATCH));

    expect(response?.status).toBe(401);
    // Nothing reached the ledger.
    expect(insertedIds.size).toBe(0);
  });
});

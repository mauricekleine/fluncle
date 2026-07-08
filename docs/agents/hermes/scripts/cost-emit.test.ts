// Unit tests for the box's cost-ledger emitter (COST-01 Path B). The box script is
// self-contained (it can't import the workspace), so this file uses `bun:test` and
// is run directly:
//
//   bun test docs/agents/hermes/scripts/cost-emit.test.ts
//
// Two things it pins: (1) the idempotency `id` scheme is a VERBATIM mirror of the
// server's `costEventId` (apps/web/src/lib/server/costs.ts) — if the server scheme
// drifts, this test's literal expectations fail loudly; (2) the best-effort
// guarantee — `emitCost` never throws and returns a `{ posted: false, reason }` on
// every failure path, so a ledger hiccup can't break the sweep's real work.
import { describe, expect, test } from "bun:test";

import {
  type BoxCostEvent,
  costEventId,
  emitCost,
  parseAuthoringSpend,
  selfSecondsCost,
} from "./cost-emit";

const anthropicRow: BoxCostEvent = {
  costBasis: "subsidized",
  logId: "010.6.12",
  model: "claude-sonnet-4-6",
  occurredAt: "2026-07-08T12:00:00.000Z",
  quantity: 1,
  source: "measured",
  step: "note",
  unitType: "tokens",
  usd: 0.031,
  vendor: "anthropic",
};

type RecordedCall = { auth: string; body: string; method: string; url: string };

// A fetch stub that records the single call as flat strings (so the assertions
// never optional-chain into an untyped RequestInit) and returns a canned response.
function stubFetch(response: { json?: () => Promise<unknown>; ok: boolean; status?: number }): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      auth: headers.Authorization ?? "",
      body: typeof init.body === "string" ? init.body : "",
      method: init.method ?? "",
      url,
    });

    return Promise.resolve({
      json: response.json ?? (() => Promise.resolve({})),
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
    } as Response);
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

describe("costEventId (mirrors the server scheme)", () => {
  test("scopes to logId when present", () => {
    expect(costEventId(anthropicRow)).toBe(
      "note:010.6.12:anthropic:tokens:2026-07-08T12:00:00.000Z",
    );
  });

  test("falls back trackId then 'global'", () => {
    const base = { ...anthropicRow, logId: null };
    expect(costEventId({ ...base, trackId: "t1" })).toBe(
      "note:t1:anthropic:tokens:2026-07-08T12:00:00.000Z",
    );
    expect(costEventId({ ...base, trackId: null })).toBe(
      "note:global:anthropic:tokens:2026-07-08T12:00:00.000Z",
    );
  });
});

describe("parseAuthoringSpend (claude -p envelope → spend)", () => {
  test("reads tokens, the modelUsage key, and total_cost_usd", () => {
    expect(
      parseAuthoringSpend(
        {
          modelUsage: { "claude-sonnet-4-6": {} },
          total_cost_usd: 0.042,
          usage: { input_tokens: 1200, output_tokens: 300 },
        },
        "fallback-model",
      ),
    ).toEqual({ model: "claude-sonnet-4-6", tokens: 1500, usd: 0.042 });
  });

  test("falls back to the asked-for model and null usd when the envelope omits them", () => {
    expect(parseAuthoringSpend({ usage: { input_tokens: 10 } }, "claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6",
      tokens: 10,
      usd: null,
    });
  });

  test("an empty envelope is zero tokens, null usd (unpriced, never $0)", () => {
    expect(parseAuthoringSpend({}, "m")).toEqual({ model: "m", tokens: 0, usd: null });
  });
});

describe("selfSecondsCost (the box-compute row shape)", () => {
  test("is subsidized/self/seconds/measured with a rounded, floored quantity and no usd", () => {
    const row = selfSecondsCost({
      logId: "010.6.12",
      occurredAt: "2026-07-08T12:00:00.000Z",
      seconds: 84.6,
      step: "enrich",
      trackId: "t1",
    });
    expect(row).toEqual({
      costBasis: "subsidized",
      logId: "010.6.12",
      occurredAt: "2026-07-08T12:00:00.000Z",
      quantity: 85,
      source: "measured",
      step: "enrich",
      trackId: "t1",
      unitType: "seconds",
      vendor: "self",
    });
    expect(row.usd).toBeUndefined();
  });

  test("floors a negative duration (a clock hiccup) at 0 and defaults the scope to null", () => {
    const row = selfSecondsCost({
      occurredAt: "2026-07-08T12:00:00.000Z",
      seconds: -3,
      step: "video",
    });
    expect(row.quantity).toBe(0);
    expect(row.logId).toBeNull();
    expect(row.trackId).toBeNull();
    // A scopeless self row falls back to the `global` id scope.
    expect(costEventId(row)).toBe("video:global:self:seconds:2026-07-08T12:00:00.000Z");
  });
});

describe("emitCost best-effort contract", () => {
  test("empty batch is a no-op (no fetch)", async () => {
    const { calls, fetchImpl } = stubFetch({ ok: true });
    expect(await emitCost([], { fetchImpl, token: "t" })).toEqual({
      posted: false,
      reason: "no-events",
    });
    expect(calls.length).toBe(0);
  });

  test("no token skips (no fetch)", async () => {
    const { calls, fetchImpl } = stubFetch({ ok: true });
    expect(await emitCost([anthropicRow], { fetchImpl, token: "" })).toEqual({
      posted: false,
      reason: "no-token",
    });
    expect(calls.length).toBe(0);
  });

  test("happy path POSTs the batch with the bearer + derived ids", async () => {
    const { calls, fetchImpl } = stubFetch({
      json: () => Promise.resolve({ inserted: 1, ok: true }),
      ok: true,
    });
    const result = await emitCost([anthropicRow], {
      baseUrl: "https://example.test/",
      fetchImpl,
      token: "agent-tok",
    });

    expect(result).toEqual({ inserted: 1, posted: true });
    expect(calls.length).toBe(1);

    const call = calls[0];
    if (!call) {
      throw new Error("expected exactly one recorded fetch call");
    }
    expect(call.url).toBe("https://example.test/api/admin/costs/events");
    expect(call.method).toBe("POST");
    expect(call.auth).toBe("Bearer agent-tok");

    const sent = JSON.parse(call.body) as Array<{ id: string; usd: number }>;
    expect(sent[0]?.id).toBe("note:010.6.12:anthropic:tokens:2026-07-08T12:00:00.000Z");
    expect(sent[0]?.usd).toBe(0.031);
  });

  test("a non-2xx is swallowed to a reason, never thrown", async () => {
    const { fetchImpl } = stubFetch({ ok: false, status: 422 });
    expect(await emitCost([anthropicRow], { fetchImpl, token: "t" })).toEqual({
      posted: false,
      reason: "http-422",
    });
  });

  test("a network throw is swallowed to a reason, never thrown", async () => {
    const fetchImpl = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    expect(await emitCost([anthropicRow], { fetchImpl, token: "t" })).toEqual({
      posted: false,
      reason: "error",
    });
  });
});

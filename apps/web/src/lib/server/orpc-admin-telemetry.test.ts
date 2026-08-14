import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

// `record_run` driven end-to-end through `handleOrpc` against the SERVED path
// `/api/v1/admin/telemetry/runs`, so the REAL admin auth spine runs and only the telemetry
// database is mocked (the `record_cost` precedent in ./orpc-admin-costs.test.ts).
//
// WHY THIS FILE EXISTS AT ALL. The ledger's other two suites are strong and neither could
// have caught the defect that actually happened: the box POSTed `/admin/runs/events` while
// the contract served `/admin/telemetry/runs`, the `|| true` on the curl swallowed the 404,
// and BOTH sides' suites were green because each tested only its own half. A pure
// normalizer test never touches a URL, and an integration test calls `insertRunEvent`
// directly. This one asserts the path the Worker actually answers on, which is the only
// half of that mismatch this repo can pin — the other half is the four mirrored bash copies
// of `record_run_event`, whose `RUN_EVENT_PATH` must equal the string asserted here.
//
// It also pins the AGENT tier both ways (the box's token works, anonymous 401s) and the
// full ack, whose `runOk` + `selfAssertedOk` pair is the fastest way for an operator to see
// a sweep contradicting itself: one curl shows the claim beside the verdict.

/** The one string that must match `RUN_EVENT_PATH` in every mirrored copy on the boxes. */
const RUN_EVENT_PATH = "/admin/telemetry/runs";

const rows: unknown[][] = [];

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  // A telemetry database IS provisioned here: the unprovisioned no-op path is covered by
  // run-events.integration.test.ts, and this file is about the endpoint.
  getTelemetryDb: async () => ({ execute }),
  retryRunEventInsert: async <T>(insert: () => Promise<T>) => insert(),
}));

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  rows.length = 0;
  execute.mockReset().mockImplementation((query: { args?: unknown[]; sql: string }) => {
    if (query.sql.includes("insert into run_events")) {
      rows.push(query.args ?? []);

      return Promise.resolve({ rowsAffected: 1 });
    }

    if (query.sql.includes("count(*) as run_count")) {
      return Promise.resolve({
        rows: [
          {
            blind_count: 1,
            failed_count: 1,
            last_occurred_at: "2026-07-30T19:00:00.000Z",
            liar_count: 1,
            run_count: 1,
            unit: "fluncle-sentry-triage",
          },
        ],
      });
    }

    if (query.sql.includes("count(*) as total_count")) {
      return Promise.resolve({ rows: [{ total_count: 1 }] });
    }

    if (query.sql.includes("from run_events")) {
      return Promise.resolve({
        rows: [
          {
            checked: null,
            created_at: "2026-07-30T19:00:00.100Z",
            ended_at: "2026-07-30T19:00:05.000Z",
            errors: 2,
            exit_code: 0,
            expected_interval_ms: null,
            gate_state: null,
            id: "fluncle-sentry-triage:2026-07-30T19:00:00.000Z",
            missing_fields: '["checked","expected_interval_ms","produced","queue_depth"]',
            occurred_at: "2026-07-30T19:00:00.000Z",
            ok: 0,
            produced: null,
            queue_depth: null,
            run_duration_ms: 5000,
            self_asserted_ok: 1,
            summary_raw: '{"errors":2,"ok":true}',
            summary_status: "parsed",
            unit: "fluncle-sentry-triage",
            unrecognised_fields: "[]",
            vendor_calls: null,
          },
        ],
      });
    }

    return Promise.resolve({ rows: [] });
  });
});

/** The envelope the box's `record_run_event` bash function builds, field for field. */
const ENVELOPE = {
  ended_at: "2026-07-29T03:00:12Z",
  exit_code: 0,
  started_at: "2026-07-29T03:00:00Z",
  summary_raw:
    '{"checked":1,"produced":1,"errors":0,"queueDepth":0,"gateState":null,"expectedIntervalMs":3600000}',
  unit: "fluncle-timer-watchdog",
};

describe(`record_run — POST ${RUN_EVENT_PATH}`, () => {
  it("answers on the path the box POSTs to, with the full ack", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(RUN_EVENT_PATH, "POST", AGENT_TOKEN, ENVELOPE));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      id: "fluncle-timer-watchdog:2026-07-29T03:00:00Z",
      inserted: 1,
      missingFields: [],
      ok: true,
      runOk: true,
      selfAssertedOk: null,
      stored: true,
    });
    expect(rows).toHaveLength(1);
  });

  it("hands back the CLAIM beside the VERDICT, so one curl shows the contradiction", async () => {
    // The eleven-night defect, over the wire: exit 0, `errors: 2`, and a hardcoded
    // `ok: true`. The row is written, the verdict is false, and the claim is reported.
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(RUN_EVENT_PATH, "POST", AGENT_TOKEN, {
        ...ENVELOPE,
        summary_raw: '{"errors":2,"ok":true,"produced":3}',
        unit: "fluncle-sentry-triage",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      runOk: false,
      selfAssertedOk: true,
    });
    // And it really landed — a self-asserting sweep must never lose its row.
    expect(rows).toHaveLength(1);
  });

  it("401s an anonymous POST, and nothing reaches the ledger", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(RUN_EVENT_PATH, "POST", undefined, ENVELOPE));

    expect(response?.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it("404s the path the box USED to POST to, which is what the `|| true` hid", async () => {
    // The regression guard, stated as the failure: a wrapper aiming at the wrong path gets
    // nothing, silently, forever. If this ever starts answering, the two paths have drifted.
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/runs/events", "POST", AGENT_TOKEN, ENVELOPE));

    expect(response?.status).not.toBe(200);
    expect(rows).toHaveLength(0);
  });

  it("400s a summary that contradicts itself, writing nothing", async () => {
    // A 400 leaves no row, and a missing row reads as a missed run — which is why the set
    // of summaries that earn one is deliberately small. A wrong-TYPED counter is in it.
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(RUN_EVENT_PATH, "POST", AGENT_TOKEN, { ...ENVELOPE, summary_raw: '{"errors":[]}' }),
    );

    expect(response?.status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it("400s an envelope carrying its own `ok` — the STRICT object, not the summary", async () => {
    // Mind the layer: `ok` inside `summary_raw` is recorded (see above); `ok` as an ENVELOPE
    // key is a wrapper that thinks it grades the run, and the contract refuses it.
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(RUN_EVENT_PATH, "POST", AGENT_TOKEN, { ...ENVELOPE, ok: true }),
    );

    expect(response?.status).toBe(400);
    expect(rows).toHaveLength(0);
  });
});

describe(`read_run_ledger — GET ${RUN_EVENT_PATH}`, () => {
  it("returns rows plus whole-window aggregates to the operator", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(
        `${RUN_EVENT_PATH}?unit=fluncle-sentry-triage&since=2026-07-30T18%3A00%3A00.000Z&ok=false&limit=1`,
        "GET",
        OPERATOR_TOKEN,
      ),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      available: true,
      missingRoster: [],
      nextCursor: null,
      rollups: [
        {
          blindCount: 1,
          expectedIntervalMs: 86_400_000,
          failedCount: 1,
          lastOccurredAt: "2026-07-30T19:00:00.000Z",
          liarCount: 1,
          runCount: 1,
          unit: "fluncle-sentry-triage",
        },
      ],
      rows: [
        {
          checked: null,
          createdAt: "2026-07-30T19:00:00.100Z",
          endedAt: "2026-07-30T19:00:05.000Z",
          errors: 2,
          exitCode: 0,
          expectedIntervalMs: null,
          gateState: null,
          id: "fluncle-sentry-triage:2026-07-30T19:00:00.000Z",
          missingFields: ["checked", "expected_interval_ms", "produced", "queue_depth"],
          occurredAt: "2026-07-30T19:00:00.000Z",
          ok: false,
          produced: null,
          queueDepth: null,
          runDurationMs: 5000,
          selfAssertedOk: true,
          summaryRaw: '{"errors":2,"ok":true}',
          summaryStatus: "parsed",
          unit: "fluncle-sentry-triage",
          unrecognisedFields: [],
          vendorCalls: null,
        },
      ],
      totalCount: 1,
    });

    const selectCalls = execute.mock.calls
      .map(([query]) => query as { args?: unknown[]; sql: string })
      .filter((query) => query.sql.includes("from run_events"));

    expect(selectCalls).toHaveLength(3);
    expect(selectCalls.every((query) => query.sql.includes("occurred_at >= ?"))).toBe(true);
    expect(selectCalls.filter((query) => query.sql.includes("ok = ?"))).toHaveLength(2);
    expect(
      selectCalls.find((query) => query.sql.includes("count(*) as run_count"))?.sql,
    ).not.toContain("ok = ?");
    expect(selectCalls.every((query) => query.args?.includes("2026-07-30T18:00:00.000Z"))).toBe(
      true,
    );
  });

  it("403s the box agent and 401s an anonymous reader", async () => {
    const { handleOrpc } = await import("./orpc");
    const agentResponse = await handleOrpc(req(RUN_EVENT_PATH, "GET", AGENT_TOKEN));
    const anonymousResponse = await handleOrpc(req(RUN_EVENT_PATH, "GET", undefined));

    expect(agentResponse?.status).toBe(403);
    expect(anonymousResponse?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400s an invalid derived-ok filter before querying the ledger", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`${RUN_EVENT_PATH}?ok=yes`, "GET", OPERATOR_TOKEN));

    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

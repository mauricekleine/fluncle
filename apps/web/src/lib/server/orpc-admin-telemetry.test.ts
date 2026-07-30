import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

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
}));

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  rows.length = 0;
  execute.mockReset().mockImplementation((query: { args?: unknown[]; sql: string }) => {
    if (query.sql.includes("insert into run_events")) {
      rows.push(query.args ?? []);

      return Promise.resolve({ rowsAffected: 1 });
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

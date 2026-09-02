import { type Client, type InArgs, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { insertRunEvent, readRunLedger } from "./run-events";
import { resolveDatabaseOperationOwner } from "./database-operation-registry";
import { readClientProperty } from "./db";
import { createTelemetryIntegrationDb } from "./telemetry-integration-db";

// The run ledger's SQL half — the REAL parameterized insert against the REAL generated
// telemetry migrations (`apps/web/drizzle-telemetry`), in an in-memory libSQL database.
//
// WHY THIS FILE IS NOT OPTIONAL: `insertRunEvent` writes through a hand-built column list
// and a positional argument tuple. Nothing else in the suite touches this table's DDL, so
// a column renamed in the schema and not in the tuple, or a value pushed one slot out of
// place, would typecheck cleanly and lint cleanly and silently write `checked` into
// `errors`. A slice adding SQL against a new table without an integration test is exactly
// how a wrong-table read has reached production in this repo before.
//
// The unprovisioned path is exercised here too, by handing the accessor `undefined` — the
// state every local checkout, test run, and preview deployment is actually in.

let telemetryDb: Client | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getTelemetryDb: () => Promise.resolve(telemetryDb) };
});

/** The envelope `emit_cron_output` POSTs, with the fields a case does not care about filled in. */
function envelope(over: Partial<Parameters<typeof insertRunEvent>[0]> = {}) {
  return {
    ended_at: "2026-07-29T03:00:12.500Z",
    exit_code: 0,
    started_at: "2026-07-29T03:00:00.000Z",
    summary_raw:
      '{"checked":120,"errors":0,"expectedIntervalMs":3600000,"produced":4,"queueDepth":17}',
    unit: "fluncle-enrich",
    ...over,
  };
}

function gatewayError(status: number): Error {
  return new Error(`SERVER_ERROR: Server returned HTTP status ${status}`, {
    cause: Object.assign(new Error(`server returned HTTP status ${status}`), { status }),
  });
}

function executeStatement(client: Client, statement: InStatement, args?: InArgs) {
  return args !== undefined && typeof statement === "string"
    ? client.execute(statement, args)
    : client.execute(statement);
}

type InsertFault = {
  afterExecute?: boolean;
  error: Error;
};

/**
 * Fault only the run-event INSERT while leaving the real in-memory libSQL client underneath.
 * `afterExecute` is the production incident: the row landed, but the gateway lost its receipt.
 */
function faultRunEventInsert(
  client: Client,
  faults: InsertFault[],
): { client: Client; insertCalls: () => number } {
  let faultIndex = 0;
  let insertCalls = 0;

  return {
    client: new Proxy(client, {
      get(target, property) {
        if (property === "execute") {
          return async (statement: InStatement, args?: InArgs) => {
            const sql = typeof statement === "string" ? statement : statement.sql;

            if (!sql.includes("insert into run_events")) {
              return executeStatement(target, statement, args);
            }

            insertCalls += 1;

            const fault = faults[faultIndex];

            if (!fault) {
              return executeStatement(target, statement, args);
            }

            faultIndex += 1;

            if (fault.afterExecute === true) {
              await executeStatement(target, statement, args);
            }

            throw fault.error;
          };
        }

        return readClientProperty(target, property);
      },
    }),
    insertCalls: () => insertCalls,
  };
}

/** Every column of the single stored row, as libSQL hands it back. */
async function onlyRow(): Promise<Record<string, unknown>> {
  const client = telemetryDb;

  if (!client) {
    throw new Error("no telemetry database in this test");
  }

  const result = await client.execute("select * from run_events");

  expect(result.rows).toHaveLength(1);

  return result.rows[0] as unknown as Record<string, unknown>;
}

beforeEach(async () => {
  telemetryDb = await createTelemetryIntegrationDb();
});

describe("insertRunEvent — the round trip", () => {
  it("lands every normalized value in its own column", async () => {
    // The tuple-alignment check. Each expectation below is a DISTINCT value, so a single
    // off-by-one in the argument list cannot pass by coincidence.
    const recorded = await insertRunEvent(
      envelope({ attempt_count: 3, batch_count: 11, release: "emitter-build-abc123" }),
    );

    expect(recorded).toMatchObject({
      id: "fluncle-enrich:2026-07-29T03:00:00.000Z",
      inserted: 1,
      missingFields: [],
      runOk: true,
      selfAssertedOk: null,
      stored: true,
    });

    const row = await onlyRow();
    const operation = resolveDatabaseOperationOwner("fluncle-enrich");

    if (operation === undefined) {
      throw new Error("fluncle-enrich must resolve through the database operation registry");
    }

    expect(row).toMatchObject({
      access_class: operation.accessClass,
      attempt_count: 3,
      batch_count: 11,
      checked: 120,
      ended_at: "2026-07-29T03:00:12.500Z",
      errors: 0,
      exit_code: 0,
      // Registry cadence wins over the summary's fake one-hour value.
      expected_interval_ms: 300_000,
      gate_state: null,
      id: "fluncle-enrich:2026-07-29T03:00:00.000Z",
      missing_fields: "[]",
      occurred_at: "2026-07-29T03:00:00.000Z",
      ok: 1,
      operation_id: operation.operationId,
      outcome: "success",
      produced: 4,
      queue_depth: 17,
      release: "emitter-build-abc123",
      run_duration_ms: 12_500,
      self_asserted_ok: null,
      summary_status: "parsed",
      unit: "fluncle-enrich",
      unrecognised_fields: "[]",
      vendor_calls: null,
    });
    // `created_at` is the WORKER's write time and must be its own value, not a copy of the
    // box's `occurred_at` — under clock skew a box row's run time precedes its write.
    expect(typeof row.created_at).toBe("string");
    expect(row.created_at).not.toBe(row.occurred_at);
  });

  it("keeps the raw summary verbatim, including one that never parsed", async () => {
    // The unparseable text is EVIDENCE. A ledger that stored only what it understood would
    // discard the crash it exists to record.
    await insertRunEvent(envelope({ exit_code: 137, summary_raw: "Killed (OOM)" }));

    const row = await onlyRow();

    expect(row.summary_raw).toBe("Killed (OOM)");
    expect(row.summary_status).toBe("malformed");
    expect(row.ok).toBe(0);
    expect(row.outcome).toBe("failure");
    expect(row.expected_interval_ms).toBe(300_000);
    expect(row.missing_fields).toBe('["checked","errors","produced","queue_depth"]');
  });

  it("keeps unknowable counts and unregistered operation identity NULL", async () => {
    await insertRunEvent(envelope({ unit: "legacy-unregistered-runner" }));

    const row = await onlyRow();

    expect(row).toMatchObject({
      access_class: null,
      attempt_count: null,
      batch_count: null,
      operation_id: null,
      release: "unknown",
    });
  });

  it("keeps a registered no-database run ID while leaving access NULL", async () => {
    await insertRunEvent(envelope({ unit: "fluncle-audit" }));

    const row = await onlyRow();

    expect(row).toMatchObject({
      access_class: null,
      operation_id: "ops.audit",
    });
  });

  it("reads a rolling-deploy row's outcome from its authoritative ok verdict", async () => {
    const client = telemetryDb;

    if (!client) {
      throw new Error("no telemetry database in this test");
    }

    await client.execute({
      args: [
        "rolling-writer:2026-07-29T03:00:00.000Z",
        "2026-07-29T03:00:12.600Z",
        "2026-07-29T03:00:12.500Z",
        0,
        "[]",
        "2026-07-29T03:00:00.000Z",
        1,
        "parsed",
        "rolling-writer",
        "[]",
      ],
      sql: `insert into run_events (
              id, created_at, ended_at, exit_code, missing_fields,
              occurred_at, ok, summary_status, unit, unrecognised_fields
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    });

    const page = await readRunLedger({ limit: 10, unit: "rolling-writer" });

    expect(page.rows).toMatchObject([
      {
        accessClass: null,
        operationId: null,
        outcome: "success",
        release: "unknown",
      },
    ]);
  });
});

describe("insertRunEvent — idempotency", () => {
  it("retries a 502 on the ledger insert and lands the row", async () => {
    const client = telemetryDb;

    if (!client) {
      throw new Error("no telemetry database in this test");
    }

    const fault = faultRunEventInsert(client, [{ error: gatewayError(502) }]);
    telemetryDb = fault.client;

    const recorded = await insertRunEvent(envelope());

    expect(recorded.inserted).toBe(1);
    expect(recorded.stored).toBe(true);
    expect(fault.insertCalls()).toBe(2);
    await onlyRow();
  });

  it("replays a lost 502 receipt as inserted: 0 and keeps exactly one row", async () => {
    const client = telemetryDb;

    if (!client) {
      throw new Error("no telemetry database in this test");
    }

    const fault = faultRunEventInsert(client, [{ afterExecute: true, error: gatewayError(502) }]);
    telemetryDb = fault.client;

    const recorded = await insertRunEvent(envelope());

    expect(recorded.inserted).toBe(0);
    expect(recorded.stored).toBe(true);
    expect(fault.insertCalls()).toBe(2);
    await onlyRow();
  });

  it("does not retry a 524 and leaves the row absent", async () => {
    const client = telemetryDb;

    if (!client) {
      throw new Error("no telemetry database in this test");
    }

    const error = gatewayError(524);
    const fault = faultRunEventInsert(client, [{ error }]);
    telemetryDb = fault.client;

    await expect(insertRunEvent(envelope())).rejects.toBe(error);
    expect(fault.insertCalls()).toBe(1);

    const result = await client.execute("select count(*) as n from run_events");

    expect(Number(result.rows[0]?.n)).toBe(0);
  });

  it("collapses a retried POST to ONE row", async () => {
    // The POST is best-effort, so it WILL be retried. An append-only ledger double-counts a
    // retry without `on conflict(id) do nothing`, and a doubled run count is a lie about
    // how often a sweep fired.
    const first = await insertRunEvent(envelope());
    const second = await insertRunEvent(envelope());

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.stored).toBe(true);
    await onlyRow();
  });

  it("does NOT overwrite the stored row on the retry", async () => {
    // DO NOTHING, not DO UPDATE: the first write is the record. A retry carrying a
    // different summary must not be able to rewrite history under the same id.
    await insertRunEvent(envelope());
    await insertRunEvent(envelope({ summary_raw: '{"errors":9,"produced":0}' }));

    const row = await onlyRow();

    expect(row.errors).toBe(0);
    expect(row.ok).toBe(1);
  });

  it("treats a later run of the same unit as a new row", async () => {
    await insertRunEvent(envelope());
    await insertRunEvent(
      envelope({ ended_at: "2026-07-29T04:00:05.000Z", started_at: "2026-07-29T04:00:00.000Z" }),
    );

    const client = telemetryDb;
    const result = await client?.execute("select count(*) as n from run_events");

    expect(Number(result?.rows[0]?.n)).toBe(2);
  });
});

describe("insertRunEvent — the derived verdict reaches the column", () => {
  it("stores ok=0 for a sweep that exited 0 while reporting errors", async () => {
    // The eleven-night defect, end to end: the summary cannot talk the row into ok=1.
    await insertRunEvent(envelope({ exit_code: 0, summary_raw: '{"errors":2,"produced":3}' }));

    const row = await onlyRow();

    expect(row.exit_code).toBe(0);
    expect(row.errors).toBe(2);
    expect(row.ok).toBe(0);
  });

  it("WRITES the row for the real Sentry-sweep summary, and files its claim beside the verdict", async () => {
    // THE FOUNDING CASE, with the real fixture:
    // docs/agents/hermes/scripts/sentry-triage-sweep.ts:489 prints
    // `{"candidates":N,"ok":true,"resolved":N}` — the self-asserted lie this whole ledger
    // exists to catch. A hard 400 on a summary carrying `ok` meant NO ROW for it, so the
    // founding case would have been the one case the ledger could not see, and a rowless
    // sweep reads as a dead one.
    const recorded = await insertRunEvent(
      envelope({ exit_code: 1, summary_raw: '{"candidates":3,"ok":true,"resolved":3}' }),
    );

    expect(recorded.stored).toBe(true);
    expect(recorded.inserted).toBe(1);

    const row = await onlyRow();

    // The row exists, the DERIVED verdict is false, and the CLAIM is on the row as `true`.
    expect(row.ok).toBe(0);
    expect(row.self_asserted_ok).toBe(1);
    expect(row.summary_raw).toBe('{"candidates":3,"ok":true,"resolved":3}');
    expect(row.summary_status).toBe("parsed");
    // And the un-actioned numbers land on the rename queue instead of vanishing.
    expect(row.unrecognised_fields).toBe('["candidates","resolved"]');
  });

  it("makes 'the sweep is lying about itself' a one-line query", async () => {
    // An exit-code-only failure: the summary reports zero errors and claims ok, but the
    // stored verdict is false. A liar query coupled only to the error count loses this row.
    await insertRunEvent(envelope({ exit_code: 1, summary_raw: '{"errors":0,"ok":true}' }));
    // A control row: the same claim beside a true stored verdict must NOT appear.
    await insertRunEvent(
      envelope({
        started_at: "2026-07-29T04:00:00.000Z",
        summary_raw: '{"errors":0,"ok":true,"produced":4}',
        unit: "fluncle-note",
      }),
    );

    const client = telemetryDb;
    const liars = await client?.execute(
      "select unit, ok, errors, exit_code from run_events where self_asserted_ok = 1 and ok = 0",
    );

    expect(liars?.rows).toHaveLength(1);
    expect(liars?.rows[0]?.unit).toBe("fluncle-enrich");
    expect(liars?.rows[0]?.ok).toBe(0);
    expect(liars?.rows[0]?.errors).toBe(0);
    expect(liars?.rows[0]?.exit_code).toBe(1);
  });
});

describe("run failure vocabulary — acceptance", () => {
  it("keeps a capture-shaped partial batch ok and out of the liar count", async () => {
    const summaryRaw = '{"batch":12,"done":8,"failed":4,"ok":true}';
    const recorded = await insertRunEvent(
      envelope({ exit_code: 0, summary_raw: summaryRaw, unit: "fluncle-capture" }),
    );
    const page = await readRunLedger({ limit: 100, unit: "fluncle-capture" });

    expect(recorded.runOk).toBe(true);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      errors: null,
      ok: true,
      selfAssertedOk: true,
      summaryRaw,
    });
    expect(page.rollups).toMatchObject([{ failedCount: 0, liarCount: 0 }]);
  });

  it("keeps the founding Sentry shape failed and in the liar count", async () => {
    const summaryRaw = '{"errors":2,"ok":true}';
    const recorded = await insertRunEvent(
      envelope({ exit_code: 0, summary_raw: summaryRaw, unit: "fluncle-sentry-triage" }),
    );
    const page = await readRunLedger({ limit: 100, unit: "fluncle-sentry-triage" });

    expect(recorded.runOk).toBe(false);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      errors: 2,
      ok: false,
      selfAssertedOk: true,
      summaryRaw,
    });
    expect(page.rollups).toMatchObject([{ failedCount: 1, liarCount: 1 }]);
  });

  it("preserves the domain `failed` counter in the readable raw summary", async () => {
    await insertRunEvent(
      envelope({
        summary_raw: '{"checked":12,"failed":4,"ok":true,"produced":8}',
        unit: "fluncle-capture",
      }),
    );
    const page = await readRunLedger({ limit: 100, unit: "fluncle-capture" });
    const summaryRaw = page.rows[0]?.summaryRaw;

    expect(summaryRaw).not.toBeNull();
    expect(JSON.parse(summaryRaw ?? "{}")).toMatchObject({ failed: 4 });
    expect(page.rows[0]?.unrecognisedFields).toEqual([]);
  });
});

describe("insertRunEvent — a gated run stores NULL, never 0", () => {
  it("stores an admission skip as a clean no-op with its runner facts preserved", async () => {
    await insertRunEvent(
      envelope({
        summary_raw:
          '{"admissionOutcome":"wait-expired","admissionWaitMs":120000,"admissionYieldReason":"queue","checked":null,"errors":0,"expectedIntervalMs":null,"gateState":"admission-skipped","payloadStarted":false,"produced":null,"queueDepth":null}',
      }),
    );

    const row = await onlyRow();

    expect(row).toMatchObject({
      checked: null,
      errors: 0,
      gate_state: "admission-skipped",
      ok: 1,
      produced: null,
      queue_depth: null,
      summary_status: "parsed",
      unrecognised_fields: "[]",
    });
    expect(row.summary_raw).toContain('"payloadStarted":false');
    expect(row.summary_raw).toContain('"admissionOutcome":"wait-expired"');
  });

  it("writes NULL work counters so the alarm conjunction cannot fire on a paused sweep", async () => {
    await insertRunEvent(
      envelope({ summary_raw: '{"checked":0,"paused":true,"produced":0,"queueDepth":40}' }),
    );

    const row = await onlyRow();

    expect(row.gate_state).toBe("paused");
    expect(row.produced).toBeNull();
    expect(row.queue_depth).toBeNull();
    expect(row.checked).toBeNull();

    // The alarm as the reader will actually write it. A paused sweep must not appear.
    const client = telemetryDb;
    const alarmed = await client?.execute(
      "select id from run_events where produced = 0 and queue_depth > 0",
    );

    expect(alarmed?.rows).toHaveLength(0);
  });

  it("stores the REAL lock-skipped sonar-freshen line, nulls and all", async () => {
    // Copied verbatim from apps/sonar/deploy/fluncle-sonar-freshen.sh: on a held
    // single-flight lock it prints its counters as literal `null`. Those nulls failed the
    // integer check and the ordinary tick's `"gateState":null` failed the enum check — so
    // this unit wrote NOTHING on every tick and would have read as permanently dead.
    const recorded = await insertRunEvent(
      envelope({
        summary_raw:
          '{"checked":null,"produced":null,"errors":0,"queueDepth":null,"gateState":"paused","expectedIntervalMs":3600000}',
        unit: "fluncle-sonar-freshen",
      }),
    );

    expect(recorded.stored).toBe(true);
    expect(recorded.inserted).toBe(1);

    const row = await onlyRow();

    expect(row).toMatchObject({
      checked: null,
      errors: 0,
      expected_interval_ms: 3_600_000,
      gate_state: "paused",
      // NOT an upgrade-queue item: the sweep told us it does not know, which is not a gap.
      missing_fields: "[]",
      produced: null,
      queue_depth: null,
      self_asserted_ok: null,
      summary_status: "parsed",
      unit: "fluncle-sonar-freshen",
      unrecognised_fields: "[]",
    });
    // Exit 0 and zero errors: a lock-skip is not a failure, and the derived verdict says so.
    expect(row.ok).toBe(1);
  });

  it("stores the REAL ordinary timer-watchdog tick, whose only gate signal is a null", async () => {
    // docs/agents/hermes/timer-watchdog/timer-watchdog.sh, verbatim. A healthy watchdog
    // legitimately re-arms nothing forever, so `produced: 0` beside `checked: 9` is the
    // shape that separates health from blindness — and it was a 400 for the `gateState`.
    await insertRunEvent(
      envelope({
        summary_raw:
          '{"checked":9,"produced":0,"errors":0,"queueDepth":0,"gateState":null,"expectedIntervalMs":900000}',
        unit: "fluncle-timer-watchdog",
      }),
    );

    const row = await onlyRow();

    expect(row).toMatchObject({
      checked: 9,
      gate_state: null,
      missing_fields: "[]",
      ok: 1,
      produced: 0,
      queue_depth: 0,
    });
  });

  it("would keep an operator mode's measurements and let the reader exclude the gate", async () => {
    // Forward compatibility: `forced` and `dry-run` LOOKED, so their numbers must survive
    // if an emitter ever names them. The false `produced == 0 AND queue_depth > 0` reading a
    // dry-run would raise is the READER's to exclude — that is what `gate_state` is on the
    // row for, and excluding a gate at read time is strictly safer than laundering a
    // measured number at write time.
    await insertRunEvent(
      envelope({
        summary_raw: '{"gateState":"forced","checked":1,"errors":0,"produced":1,"queueDepth":0}',
        unit: "fluncle-sonar-freshen",
      }),
    );
    await insertRunEvent(
      envelope({
        started_at: "2026-07-29T04:00:00.000Z",
        summary_raw: '{"gateState":"dry-run","checked":1,"errors":0,"produced":0,"queueDepth":7}',
        unit: "fluncle-sonar-freshen",
      }),
    );

    const client = telemetryDb;
    const rows = await client?.execute(
      "select gate_state, produced, queue_depth from run_events order by occurred_at",
    );

    expect(rows?.rows.map((row) => [row.gate_state, row.produced, row.queue_depth])).toEqual([
      ["forced", 1, 0],
      ["dry-run", 0, 7],
    ]);

    // The alarm, written as it must be written: scheduled ticks only.
    const alarmed = await client?.execute(
      `select id from run_events
       where produced = 0 and queue_depth > 0
         and (gate_state is null or gate_state = 'active')`,
    );

    expect(alarmed?.rows).toHaveLength(0);
  });
});

describe("insertRunEvent — unprovisioned degrades, it never breaks", () => {
  beforeEach(() => {
    telemetryDb = undefined;
  });

  it("no-ops without throwing when there is no telemetry database", async () => {
    // Local dev, the test suite, and every preview deployment are in this state. A missing
    // diagnostics store must never break the product path it observes.
    const recorded = await insertRunEvent(envelope());

    expect(recorded.stored).toBe(false);
    expect(recorded.inserted).toBe(0);
    expect(recorded.runOk).toBe(true);
  });

  it("distinguishes 'no ledger' from 'already recorded'", async () => {
    // Both give `inserted: 0`. Without `stored`, the ack would be exactly the ambiguous
    // diagnostic this whole design was built to abolish.
    const unprovisioned = await insertRunEvent(envelope());

    telemetryDb = await createTelemetryIntegrationDb();
    await insertRunEvent(envelope());

    const retry = await insertRunEvent(envelope());

    expect(unprovisioned).toMatchObject({ inserted: 0, stored: false });
    expect(retry).toMatchObject({ inserted: 0, stored: true });
  });

  it("STILL rejects a self-contradicting summary with no database present", async () => {
    // An unprovisioned deployment must not become the place where bad emitters go
    // unnoticed — validation is not a side effect of having somewhere to write.
    await expect(insertRunEvent(envelope({ summary_raw: '{"errors":[]}' }))).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(
      insertRunEvent(envelope({ summary_raw: '{"queueDepth":5,"queue_depth":9}' })),
    ).rejects.toThrow(/more than one spelling/);
  });

  it("still hands back the derived verdict AND the claim with no ledger to write to", async () => {
    // The ack is the fastest way to see the Worker's judgement of a run, and it must not
    // go quiet just because there is nowhere to store it.
    const recorded = await insertRunEvent(
      envelope({ exit_code: 0, summary_raw: '{"errors":2,"ok":true}' }),
    );

    expect(recorded).toMatchObject({ runOk: false, selfAssertedOk: true, stored: false });
  });

  it("distinguishes an unavailable reader from a configured empty window", async () => {
    const page = await readRunLedger({ limit: 50 });

    expect(page).toEqual({
      available: false,
      missingRoster: [],
      nextCursor: null,
      rollups: [],
      rows: [],
      totalCount: 0,
    });
  });
});

describe("run_events — the three reads the ledger was indexed for", () => {
  beforeEach(async () => {
    const units = ["fluncle-enrich", "fluncle-note"];

    for (const unit of units) {
      for (let hour = 0; hour < 3; hour += 1) {
        await insertRunEvent(
          envelope({
            ended_at: `2026-07-29T0${hour}:00:05.000Z`,
            started_at: `2026-07-29T0${hour}:00:00.000Z`,
            unit,
          }),
        );
      }
    }
  });

  it("answers 'latest run per unit'", async () => {
    const client = telemetryDb;
    const result = await client?.execute(
      `select unit, max(occurred_at) as latest from run_events group by unit order by unit`,
    );

    expect(result?.rows.map((row) => [row.unit, row.latest])).toEqual([
      ["fluncle-enrich", "2026-07-29T02:00:00.000Z"],
      ["fluncle-note", "2026-07-29T02:00:00.000Z"],
    ]);
  });

  it("answers 'runs for unit X over a window' (the composite index's shape)", async () => {
    const client = telemetryDb;
    const result = await client?.execute({
      args: ["fluncle-enrich", "2026-07-29T01:00:00.000Z"],
      sql: `select occurred_at from run_events
            where unit = ? and occurred_at >= ?
            order by occurred_at asc`,
    });

    expect(result?.rows.map((row) => row.occurred_at)).toEqual([
      "2026-07-29T01:00:00.000Z",
      "2026-07-29T02:00:00.000Z",
    ]);
  });

  it("answers 'which units have no row in the last N hours' — the absence alarm", async () => {
    // ABSENCE IS THE LOUD SIGNAL. Delivery is best-effort precisely because a dropped POST
    // leaves a hole this read finds, so this query is the ledger's whole safety net.
    await insertRunEvent(
      envelope({
        ended_at: "2026-07-29T09:00:05.000Z",
        started_at: "2026-07-29T09:00:00.000Z",
        unit: "fluncle-enrich",
      }),
    );

    const client = telemetryDb;
    const result = await client?.execute({
      args: ["2026-07-29T08:00:00.000Z"],
      sql: `select unit from run_events
            group by unit
            having max(occurred_at) < ?
            order by unit`,
    });

    expect(result?.rows.map((row) => row.unit)).toEqual(["fluncle-note"]);
  });
});

describe("readRunLedger — rows plus cheap aggregates, never verdicts", () => {
  it("counts the liar and blind shapes per unit against real fixture rows", async () => {
    await insertRunEvent(
      envelope({
        ended_at: "2026-07-30T19:00:05.000Z",
        started_at: "2026-07-30T19:00:00.000Z",
        summary_raw: '{"checked":4,"errors":2,"ok":true,"produced":0,"queueDepth":9}',
        unit: "fluncle-sentry-triage",
      }),
    );
    await insertRunEvent(
      envelope({
        ended_at: "2026-07-30T19:10:05.000Z",
        started_at: "2026-07-30T19:10:00.000Z",
        summary_raw: "{}",
        unit: "fluncle-sentry-triage",
      }),
    );
    await insertRunEvent(
      envelope({
        ended_at: "2026-07-30T19:20:05.000Z",
        started_at: "2026-07-30T19:20:00.000Z",
        summary_raw: '{"checked":8,"errors":0,"produced":2,"queueDepth":0}',
        unit: "fluncle-note",
      }),
    );

    const page = await readRunLedger({
      limit: 100,
      since: "2026-07-30T18:00:00.000Z",
    });

    expect(page.available).toBe(true);
    expect(page.rows).toHaveLength(3);
    expect(page.rollups).toEqual([
      {
        blindCount: 0,
        expectedIntervalMs: 600_000,
        failedCount: 0,
        lastOccurredAt: "2026-07-30T19:20:00.000Z",
        liarCount: 0,
        runCount: 1,
        unit: "fluncle-note",
      },
      {
        blindCount: 1,
        expectedIntervalMs: 86_400_000,
        failedCount: 1,
        lastOccurredAt: "2026-07-30T19:10:00.000Z",
        liarCount: 1,
        runCount: 2,
        unit: "fluncle-sentry-triage",
      },
    ]);
    expect(page.rows.find((row) => row.selfAssertedOk === true)).toMatchObject({
      errors: 2,
      ok: false,
      unit: "fluncle-sentry-triage",
    });
    expect(
      page.rows.find(
        (row) => row.checked === null && row.produced === null && row.queueDepth === null,
      ),
    ).toMatchObject({
      // `expected_interval_ms` is NOT here: it is filled server-side from the derived
      // roster, so a unit on the roster never reports it missing. The remaining four are
      // the sweep's own upgrade queue.
      missingFields: ["checked", "errors", "produced", "queue_depth"],
      unit: "fluncle-sentry-triage",
    });
  });

  it("keeps an unregistered unit's emitted cadence on the row but null on its rollup", async () => {
    await insertRunEvent(
      envelope({
        summary_raw:
          '{"checked":1,"errors":0,"expectedIntervalMs":123456,"produced":0,"queueDepth":0}',
        unit: "fluncle-legacy",
      }),
    );

    const page = await readRunLedger({ limit: 100, unit: "fluncle-legacy" });

    expect(page.rows).toMatchObject([{ expectedIntervalMs: 123_456 }]);
    expect(page.rollups).toMatchObject([
      {
        expectedIntervalMs: null,
        runCount: 1,
        unit: "fluncle-legacy",
      },
    ]);
  });

  it("makes a narrow ISO window return fewer rows than a wide one", async () => {
    for (const minute of ["00", "10", "20"]) {
      await insertRunEvent(
        envelope({
          ended_at: `2026-07-30T19:${minute}:05.000Z`,
          started_at: `2026-07-30T19:${minute}:00.000Z`,
          unit: "fluncle-enrich",
        }),
      );
    }

    const wide = await readRunLedger({
      limit: 100,
      since: "2026-07-30T18:59:00.000Z",
    });
    const narrow = await readRunLedger({
      limit: 100,
      since: "2026-07-30T19:15:00.000Z",
    });

    expect(wide.totalCount).toBe(3);
    expect(narrow.totalCount).toBe(1);
    expect(narrow.rows.length).toBeLessThan(wide.rows.length);
    expect(narrow.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T19:20:00.000Z"]);
  });

  it("accepts relative lookbacks without regressing ISO T-separated window comparisons", async () => {
    for (const startedAt of [
      "2026-07-29T21:00:00.000Z",
      "2026-07-30T18:00:00.000Z",
      "2026-07-30T19:30:00.000Z",
    ]) {
      await insertRunEvent(
        envelope({
          ended_at: new Date(Date.parse(startedAt) + 5_000).toISOString(),
          started_at: startedAt,
          unit: "fluncle-enrich",
        }),
      );
    }

    const nowMs = Date.parse("2026-07-30T20:00:00.000Z");
    const wide = await readRunLedger({ limit: 100, since: "24h" }, nowMs);
    const narrow = await readRunLedger({ limit: 100, since: "90m" }, nowMs);
    const narrowIso = await readRunLedger({ limit: 100, since: "2026-07-30T18:30:00.000Z" }, nowMs);

    expect(wide.totalCount).toBe(3);
    expect(narrow.totalCount).toBe(1);
    expect(narrow.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T19:30:00.000Z"]);
    expect(narrow).toEqual(narrowIso);
  });

  it("filters stored liar, blind, and missing-field evidence without narrowing rollups", async () => {
    await insertRunEvent(
      envelope({
        exit_code: 1,
        started_at: "2026-07-30T19:00:00.000Z",
        summary_raw: '{"checked":4,"errors":0,"ok":true,"produced":0,"queueDepth":9}',
        unit: "fluncle-enrich",
      }),
    );
    await insertRunEvent(
      envelope({
        started_at: "2026-07-30T19:10:00.000Z",
        summary_raw: "{}",
        unit: "fluncle-enrich",
      }),
    );
    await insertRunEvent(
      envelope({
        started_at: "2026-07-30T19:20:00.000Z",
        summary_raw: '{"checked":8,"errors":0,"ok":true,"produced":2,"queueDepth":0}',
        unit: "fluncle-enrich",
      }),
    );

    const liar = await readRunLedger({ liar: "true", limit: 100, unit: "fluncle-enrich" });
    const blind = await readRunLedger({ blind: "true", limit: 100, unit: "fluncle-enrich" });
    const missingField = await readRunLedger({
      limit: 100,
      missingField: "produced",
      unit: "fluncle-enrich",
    });
    const notLiar = await readRunLedger({
      liar: "false",
      limit: 100,
      unit: "fluncle-enrich",
    });
    const notBlind = await readRunLedger({
      blind: "false",
      limit: 100,
      unit: "fluncle-enrich",
    });

    expect(liar.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T19:00:00.000Z"]);
    expect(liar.rows[0]).toMatchObject({ errors: 0, ok: false, selfAssertedOk: true });
    expect(blind.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T19:10:00.000Z"]);
    expect(missingField.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T19:10:00.000Z"]);
    expect(notLiar.rows.map((row) => row.occurredAt)).toEqual([
      "2026-07-30T19:20:00.000Z",
      "2026-07-30T19:10:00.000Z",
    ]);
    expect(notBlind.rows.map((row) => row.occurredAt)).toEqual([
      "2026-07-30T19:20:00.000Z",
      "2026-07-30T19:00:00.000Z",
    ]);

    for (const evidence of [liar, blind, missingField]) {
      expect(evidence.totalCount).toBe(1);
      expect(evidence.rollups).toMatchObject([
        {
          expectedIntervalMs: 300_000,
          runCount: 3,
          unit: "fluncle-enrich",
        },
      ]);
    }
    expect(notLiar.totalCount).toBe(2);
    expect(notBlind.totalCount).toBe(2);
  });

  it("returns cadence-aware roster absences from only the time and optional unit scope", async () => {
    const nowMs = Date.parse("2026-07-30T20:00:00.000Z");

    await insertRunEvent(
      envelope({
        started_at: "2026-07-29T19:00:00.000Z",
        unit: "fluncle-enrich",
      }),
    );

    const missingCron = await readRunLedger(
      { limit: 100, missing: "true", since: "24h", unit: "fluncle-enrich" },
      nowMs,
    );
    const missingDirect = await readRunLedger(
      { limit: 100, missing: "true", since: "24h", unit: "fluncle-secrets-sync" },
      nowMs,
    );
    const deliberateNonWriter = await readRunLedger(
      { limit: 100, missing: "true", since: "24h", unit: "fluncle-healthcheck" },
      nowMs,
    );

    expect(missingCron).toEqual({
      available: true,
      missingRoster: [{ expectedIntervalMs: 300_000, unit: "fluncle-enrich" }],
      nextCursor: null,
      rollups: [],
      rows: [],
      totalCount: 0,
    });
    expect(missingDirect.missingRoster).toEqual([
      { expectedIntervalMs: 900_000, unit: "fluncle-secrets-sync" },
    ]);
    expect(deliberateNonWriter.missingRoster).toEqual([]);

    await insertRunEvent(
      envelope({
        started_at: "2026-07-30T19:30:00.000Z",
        unit: "fluncle-secrets-sync",
      }),
    );

    const presentDirect = await readRunLedger(
      { limit: 100, missing: "true", since: "24h", unit: "fluncle-secrets-sync" },
      nowMs,
    );

    expect(presentDirect.missingRoster).toEqual([]);
  });

  it("keeps all-run rollups under the derived-ok evidence filter", async () => {
    await insertRunEvent(
      envelope({
        exit_code: 1,
        started_at: "2026-07-30T19:00:00.000Z",
        unit: "fluncle-enrich",
      }),
    );
    await insertRunEvent(
      envelope({
        started_at: "2026-07-30T19:10:00.000Z",
        unit: "fluncle-enrich",
      }),
    );

    const failed = await readRunLedger({ limit: 100, ok: "false", unit: "fluncle-enrich" });

    expect(failed.totalCount).toBe(1);
    expect(failed.rows).toHaveLength(1);
    expect(failed.rollups).toMatchObject([
      {
        failedCount: 1,
        runCount: 2,
        unit: "fluncle-enrich",
      },
    ]);
  });

  it("keyset-pages raw rows while keeping whole-window rollups stable", async () => {
    for (const hour of ["01", "02", "03"]) {
      await insertRunEvent(
        envelope({
          ended_at: `2026-07-30T${hour}:00:05.000Z`,
          started_at: `2026-07-30T${hour}:00:00.000Z`,
          unit: "fluncle-note",
        }),
      );
    }

    const first = await readRunLedger({ limit: 2 });
    const cursor = first.nextCursor;

    if (cursor === null) {
      throw new Error("expected a second run-ledger page");
    }

    const second = await readRunLedger({ cursor, limit: 2 });

    expect(first.rows.map((row) => row.occurredAt)).toEqual([
      "2026-07-30T03:00:00.000Z",
      "2026-07-30T02:00:00.000Z",
    ]);
    expect(second.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T01:00:00.000Z"]);
    expect(second.nextCursor).toBeNull();
    expect(first.totalCount).toBe(3);
    expect(second.totalCount).toBe(3);
    expect(second.rollups).toEqual(first.rollups);
  });

  it("keyset-pages only matching liar evidence while totalCount and rollups stay stable", async () => {
    for (const [hour, liar] of [
      ["01", true],
      ["02", false],
      ["03", true],
      ["04", false],
      ["05", true],
    ] as const) {
      await insertRunEvent(
        envelope({
          ended_at: `2026-07-30T${hour}:00:05.000Z`,
          exit_code: liar ? 1 : 0,
          started_at: `2026-07-30T${hour}:00:00.000Z`,
          summary_raw: '{"checked":1,"errors":0,"ok":true,"produced":0,"queueDepth":0}',
          unit: "fluncle-enrich",
        }),
      );
    }

    const first = await readRunLedger({
      liar: "true",
      limit: 2,
      unit: "fluncle-enrich",
    });
    const cursor = first.nextCursor;

    if (cursor === null) {
      throw new Error("expected a second filtered run-ledger page");
    }

    const second = await readRunLedger({
      cursor,
      liar: "true",
      limit: 2,
      unit: "fluncle-enrich",
    });

    expect(first.rows.map((row) => row.occurredAt)).toEqual([
      "2026-07-30T05:00:00.000Z",
      "2026-07-30T03:00:00.000Z",
    ]);
    expect(second.rows.map((row) => row.occurredAt)).toEqual(["2026-07-30T01:00:00.000Z"]);
    expect(
      [...first.rows, ...second.rows].every(
        (row) => row.selfAssertedOk === true && row.ok === false,
      ),
    ).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(first.totalCount).toBe(3);
    expect(second.totalCount).toBe(3);
    expect(second.rollups).toEqual(first.rollups);
    expect(first.rollups).toMatchObject([
      {
        liarCount: 3,
        runCount: 5,
        unit: "fluncle-enrich",
      },
    ]);
  });
});

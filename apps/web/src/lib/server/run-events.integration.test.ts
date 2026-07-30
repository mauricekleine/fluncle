import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { insertRunEvent } from "./run-events";
import { createTelemetryIntegrationDb } from "./telemetry-integration-db";

// The run ledger's SQL half — the REAL parameterized insert against the REAL generated
// telemetry migration (`apps/web/drizzle-telemetry`), in an in-memory libSQL database.
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
    const recorded = await insertRunEvent(envelope());

    expect(recorded).toMatchObject({
      id: "fluncle-enrich:2026-07-29T03:00:00.000Z",
      inserted: 1,
      missingFields: [],
      runOk: true,
      selfAssertedOk: null,
      stored: true,
    });

    const row = await onlyRow();

    expect(row).toMatchObject({
      checked: 120,
      ended_at: "2026-07-29T03:00:12.500Z",
      errors: 0,
      exit_code: 0,
      expected_interval_ms: 3_600_000,
      gate_state: null,
      id: "fluncle-enrich:2026-07-29T03:00:00.000Z",
      missing_fields: "[]",
      occurred_at: "2026-07-29T03:00:00.000Z",
      ok: 1,
      produced: 4,
      queue_depth: 17,
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
    expect(row.missing_fields).toBe(
      '["checked","errors","expected_interval_ms","produced","queue_depth"]',
    );
  });
});

describe("insertRunEvent — idempotency", () => {
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
    // The eleven-night defect end to end: exit 0, `errors:2`, and a hardcoded `ok:true`.
    // This is the read the column was added for.
    await insertRunEvent(envelope({ exit_code: 0, summary_raw: '{"errors":2,"ok":true}' }));
    // A control row: honest, and it must NOT appear.
    await insertRunEvent(
      envelope({
        started_at: "2026-07-29T04:00:00.000Z",
        summary_raw: '{"errors":0,"ok":true,"produced":4}',
        unit: "fluncle-note",
      }),
    );

    const client = telemetryDb;
    const liars = await client?.execute(
      "select unit, ok, errors from run_events where self_asserted_ok = 1 and errors > 0",
    );

    expect(liars?.rows).toHaveLength(1);
    expect(liars?.rows[0]?.unit).toBe("fluncle-enrich");
    expect(liars?.rows[0]?.ok).toBe(0);
    expect(liars?.rows[0]?.errors).toBe(2);
  });
});

describe("insertRunEvent — a gated run stores NULL, never 0", () => {
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
    // Copied from apps/sonar/deploy/fluncle-sonar-freshen.sh: on a held single-flight lock
    // it prints its counters as literal `null`. Every field of this line was a 400 —
    // `checked:null` failed the integer check and `gateState:"locked"` was outside the
    // vocabulary — so a correctly-behaving unit wrote nothing and read as a missed run.
    const recorded = await insertRunEvent(
      envelope({
        summary_raw:
          '{"ok":false,"checked":null,"produced":null,"errors":0,"queueDepth":null,"gateState":"locked","expectedIntervalMs":3600000}',
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
      gate_state: "locked",
      // NOT an upgrade-queue item: the sweep told us it does not know, which is not a gap.
      missing_fields: "[]",
      produced: null,
      queue_depth: null,
      self_asserted_ok: 0,
      summary_status: "parsed",
      unit: "fluncle-sonar-freshen",
      unrecognised_fields: "[]",
    });
    // Exit 0 and zero errors: a lock-skip is not a failure, and the derived verdict says so.
    expect(row.ok).toBe(1);
  });

  it("keeps an operator's forced run's measurements, and lets the reader exclude the gate", async () => {
    // `forced` and `dry-run` LOOKED, so their numbers are real and must survive. The false
    // `produced == 0 AND queue_depth > 0` reading a dry-run could raise is the READER's to
    // exclude — that is what `gate_state` is on the row for, and excluding a gate at read
    // time is strictly safer than laundering a measured number at write time.
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

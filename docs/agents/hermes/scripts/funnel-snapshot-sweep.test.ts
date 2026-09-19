// Unit tests for funnel-snapshot-sweep.ts — the catalogue-funnel snapshot cron's orchestrator.
//
// The box only fires a bare trigger; the Worker computes + persists. So the contract worth
// pinning here is the tick's outcome mapping (the op response → the /status JSON summary) and its
// fault handling — the summary line the healthcheck prober reads must be honest on success AND
// failure.
//
// Runs outside any package's test runner (bun:test), like anchor-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/funnel-snapshot-sweep.test.ts

import { describe, expect, test } from "bun:test";
import {
  type FunnelSnapshotDeps,
  missingApiTokenSummary,
  type RecordSnapshotResponse,
  runFunnelSnapshotTick,
} from "./funnel-snapshot-sweep";

const SNAPSHOT: RecordSnapshotResponse = {
  ok: true,
  snapshot: {
    certified: 42,
    crawled: 12_345,
    day: "2026-07-18",
    recEligible: 360,
  },
};

// The retry ladder's wait is INJECTED so the failure tests prove the ladder without spending its
// real backoff — the sleep is what the tick does between attempts, never what a test must endure.
function deps(overrides: Partial<FunnelSnapshotDeps> = {}): FunnelSnapshotDeps {
  return {
    log: () => {},
    record: () => Promise.resolve(SNAPSHOT),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

describe("runFunnelSnapshotTick", () => {
  test("a pre-work credential gate reports unknown work, distinct from a measured zero", () => {
    expect(missingApiTokenSummary()).toEqual({
      checked: null,
      errors: 1,
      ok: false,
      produced: null,
      reason: "missing_api_token",
    });
  });

  test("maps a good snapshot response to an ok summary with the headline counts", async () => {
    const summary = await runFunnelSnapshotTick(deps());

    expect(summary.ok).toBe(true);
    expect(summary.day).toBe("2026-07-18");
    expect(summary.crawled).toBe(12_345);
    expect(summary.certified).toBe(42);
    expect(summary.recEligible).toBe(360);
    expect(summary.error).toBeNull();
    expect(summary).toMatchObject({ checked: 1, errors: 0, produced: 1 });
  });

  test("reports ok:false (never throws) when the op response carries no snapshot", async () => {
    const summary = await runFunnelSnapshotTick(
      deps({ record: () => Promise.resolve({ ok: true }) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not return a snapshot");
    expect(summary.day).toBeNull();
    expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0 });
  });

  test("reports ok:false with the error message when the record call throws", async () => {
    const summary = await runFunnelSnapshotTick(
      deps({ record: () => Promise.reject(new Error("snapshot 500")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("snapshot 500");
    expect(summary.crawled).toBeNull();
    expect(summary).toMatchObject({ checked: null, errors: 1, produced: null });
  });

  // A MISSED DAY IS PERMANENT — this cron fires for a UTC day it can never re-take, so a single
  // transient fault would be a hole in the growth series forever. The ladder is the first of the
  // three defences (the timer's retry firing and the Worker's grace window are the others).
  test("retries a transient fault inside the tick and reports the recovered run as ok", async () => {
    let attempts = 0;
    const summary = await runFunnelSnapshotTick(
      deps({
        record: () => {
          attempts += 1;

          return attempts === 1
            ? Promise.reject(new Error("snapshot 500"))
            : Promise.resolve(SNAPSHOT);
        },
      }),
    );

    expect(attempts).toBe(2);
    expect(summary.ok).toBe(true);
    expect(summary.day).toBe("2026-07-18");
    // A recovered run carries no residue of the attempt that failed: the run itself succeeded.
    expect(summary).toMatchObject({ checked: 1, error: null, errors: 0, produced: 1 });
  });

  test("gives up honestly after the ladder is exhausted, never hiding the failure", async () => {
    let attempts = 0;
    const summary = await runFunnelSnapshotTick(
      deps({
        record: () => {
          attempts += 1;

          return Promise.reject(new Error("snapshot 500"));
        },
      }),
    );

    expect(attempts).toBe(3);
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("snapshot 500");
  });

  test("echoes the days the Worker healed, so a patched hole is visible in the ledger", async () => {
    const summary = await runFunnelSnapshotTick(
      deps({
        record: () => Promise.resolve({ ...SNAPSHOT, backfilledDays: ["2026-07-17"] }),
      }),
    );

    expect(summary.backfilled).toBe(1);
    expect(summary.backfilledDays).toEqual(["2026-07-17"]);
  });

  test("a healthy tick reports no backfill rather than omitting the fact", async () => {
    const summary = await runFunnelSnapshotTick(deps());

    expect(summary.backfilled).toBe(0);
    expect(summary.backfilledDays).toEqual([]);
  });

  test("tolerates a snapshot missing a headline field — that field is null, the tick still ok", async () => {
    const summary = await runFunnelSnapshotTick(
      deps({ record: () => Promise.resolve({ ok: true, snapshot: { day: "2026-07-18" } }) }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.day).toBe("2026-07-18");
    expect(summary.crawled).toBeNull();
    expect(summary.certified).toBeNull();
  });

  test("omits queue depth because this periodic snapshot has no outstanding snapshot backlog", async () => {
    const summary = await runFunnelSnapshotTick(deps());

    // Funnel stage/queue totals are facts being snapshotted, not work remaining for this daily
    // idempotent trigger. The response has no backlog of snapshot writes to report.
    expect(summary).not.toHaveProperty("queue_depth");
    expect(summary).not.toHaveProperty("expected_interval_ms");
  });
});

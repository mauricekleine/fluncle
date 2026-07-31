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

function deps(overrides: Partial<FunnelSnapshotDeps> = {}): FunnelSnapshotDeps {
  return {
    log: () => {},
    record: () => Promise.resolve(SNAPSHOT),
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

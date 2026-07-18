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
  test("maps a good snapshot response to an ok summary with the headline counts", async () => {
    const summary = await runFunnelSnapshotTick(deps());

    expect(summary.ok).toBe(true);
    expect(summary.day).toBe("2026-07-18");
    expect(summary.crawled).toBe(12_345);
    expect(summary.certified).toBe(42);
    expect(summary.recEligible).toBe(360);
    expect(summary.error).toBeNull();
  });

  test("reports ok:false (never throws) when the op response carries no snapshot", async () => {
    const summary = await runFunnelSnapshotTick(
      deps({ record: () => Promise.resolve({ ok: true }) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not return a snapshot");
    expect(summary.day).toBeNull();
  });

  test("reports ok:false with the error message when the record call throws", async () => {
    const summary = await runFunnelSnapshotTick(
      deps({ record: () => Promise.reject(new Error("snapshot 500")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("snapshot 500");
    expect(summary.crawled).toBeNull();
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
});

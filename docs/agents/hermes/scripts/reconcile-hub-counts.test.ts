// Unit tests for reconcile-hub-counts.ts — the hub-counts reconciliation cron's orchestrator.
//
// The box only fires a bare trigger; the Worker recomputes + corrects. So the contract worth
// pinning here is the tick's outcome mapping (the op response → the /status JSON summary), its
// fault handling, and — the reason this cron exists at all — the AUDIT LINE: the corrected-row
// numbers must reach the journal on EVERY tick, because a run of zeroes is the evidence the
// counters are healthy and a non-zero reading is the evidence a write path is leaking.
//
// Runs outside any package's test runner (bun:test), like funnel-snapshot-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/reconcile-hub-counts.test.ts

import { describe, expect, test } from "bun:test";
import {
  type ReconcileHubCountsDeps,
  type ReconcileHubCountsResponse,
  runReconcileHubCountsTick,
} from "./reconcile-hub-counts";

/** The slice-A rollout-day drift, as the op would report it (44 artists / 3 albums / 1 label). */
const DRIFTED: ReconcileHubCountsResponse = {
  albums: { corrected: 3 },
  artists: { corrected: 44 },
  labels: { corrected: 1 },
  ok: true,
  tookMs: 1150,
};

/** The healthy steady state — nothing to correct. */
const CLEAN: ReconcileHubCountsResponse = {
  albums: { corrected: 0 },
  artists: { corrected: 0 },
  labels: { corrected: 0 },
  ok: true,
  tookMs: 820,
};

function deps(overrides: Partial<ReconcileHubCountsDeps> = {}): ReconcileHubCountsDeps {
  return {
    log: () => {},
    reconcile: () => Promise.resolve(DRIFTED),
    ...overrides,
  };
}

/** Collect the tick's log lines so the audit line can be asserted. */
function capturing(response: ReconcileHubCountsResponse): {
  deps: ReconcileHubCountsDeps;
  lines: string[];
} {
  const lines: string[] = [];

  return {
    deps: deps({
      log: (message) => lines.push(message),
      reconcile: () => Promise.resolve(response),
    }),
    lines,
  };
}

describe("runReconcileHubCountsTick", () => {
  test("maps a drifted response to an ok summary with the per-table + total corrected counts", async () => {
    const summary = await runReconcileHubCountsTick(deps());

    expect(summary.ok).toBe(true);
    expect(summary.labels).toBe(1);
    expect(summary.albums).toBe(3);
    expect(summary.artists).toBe(44);
    expect(summary.corrected).toBe(48);
    expect(summary.tookMs).toBe(1150);
    expect(summary.error).toBeNull();
  });

  test("maps the healthy steady state to zeroes, not to nulls", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.resolve(CLEAN) }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.corrected).toBe(0);
    expect(summary.labels).toBe(0);
    expect(summary.albums).toBe(0);
    expect(summary.artists).toBe(0);
  });

  test("logs the AUDIT line with every per-table number — the operator's drift trail", async () => {
    const { deps: capturingDeps, lines } = capturing(DRIFTED);

    await runReconcileHubCountsTick(capturingDeps);

    const audit = lines.find((line) => line.startsWith("AUDIT "));
    expect(audit).toBeDefined();
    expect(audit).toBe("AUDIT corrected=48 labels=1 albums=3 artists=44 tookMs=1150");
  });

  test("logs the AUDIT line on a CLEAN tick too — zeroes are the evidence of health", async () => {
    const { deps: capturingDeps, lines } = capturing(CLEAN);

    await runReconcileHubCountsTick(capturingDeps);

    expect(lines).toContain("AUDIT corrected=0 labels=0 albums=0 artists=0 tookMs=820");
  });

  test("reports ok:false (never throws) when the op does not ack", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.resolve({ labels: { corrected: 1 } }) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not ack");
    expect(summary.corrected).toBeNull();
  });

  test("reports ok:false with the error message when the reconcile call throws", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.reject(new Error("reconcile 500")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("reconcile 500");
    expect(summary.labels).toBeNull();
    expect(summary.corrected).toBeNull();
  });

  test("tolerates a table the op omitted — that table is null, the total is null, tick still ok", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({
        reconcile: () =>
          Promise.resolve({ albums: { corrected: 3 }, labels: { corrected: 1 }, ok: true }),
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.labels).toBe(1);
    expect(summary.albums).toBe(3);
    expect(summary.artists).toBeNull();
    // A partial read must NOT be summed into a confident-looking total.
    expect(summary.corrected).toBeNull();
  });

  test("a partial read still logs an AUDIT line, with `?` for what it could not read", async () => {
    const { deps: capturingDeps, lines } = capturing({
      albums: { corrected: 3 },
      labels: { corrected: 1 },
      ok: true,
    });

    await runReconcileHubCountsTick(capturingDeps);

    expect(lines).toContain("AUDIT corrected=? labels=1 albums=3 artists=? tookMs=?");
  });
});

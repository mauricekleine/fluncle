import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextFailureSummary, buildContextSummary } from "./context-sweep";

describe("context-sweep canonical counters", () => {
  test("checked is the attempted batch and produced counts only newly filled notes", () => {
    const summary = buildContextSummary(
      {
        batch: 5,
        failed: 2,
        filled: 2,
        noop: 1,
        queueRemaining: 2,
      },
      false,
    );

    expect(summary).toMatchObject({
      checked: 5,
      errors: 0,
      failed: 2,
      filled: 2,
      noop: 1,
      processed: 3,
      produced: 2,
    });
  });

  test("a measured empty batch stays checked:0 rather than becoming null", () => {
    const summary = buildContextSummary(
      { batch: 0, failed: 0, filled: 0, noop: 0, queueRemaining: 0 },
      false,
    );

    expect(summary.checked).toBe(0);
    expect(summary.produced).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test("omits queue_depth because the page is capped and has no cheap covering count", () => {
    const summary = buildContextSummary(
      { batch: 1, failed: 0, filled: 1, noop: 0, queueRemaining: 49 },
      false,
    );

    expect(summary).not.toHaveProperty("queue_depth");
  });

  test("a fatal queue/CLI failure is a run error with unknown item counts", () => {
    expect(buildContextFailureSummary(new Error("queue unavailable"))).toMatchObject({
      checked: null,
      errors: 1,
      failed: null,
      produced: null,
    });
  });
});

describe("context-sweep queue read outcome", () => {
  function tick(queuePayload: string): {
    exitCode: null | number;
    summary: Record<string, unknown>;
  } {
    const rig = mkdtempSync(join(tmpdir(), "context-sweep-queue-"));
    const payload = join(rig, "payload.json");
    const fluncle = join(rig, "fluncle");
    writeFileSync(payload, queuePayload);
    writeFileSync(fluncle, `#!/usr/bin/env bash\ncat ${JSON.stringify(payload)}\nexit 1\n`);
    chmodSync(fluncle, 0o755);

    try {
      const result = spawnSync(process.execPath, [join(import.meta.dir, "context-sweep.ts")], {
        encoding: "utf8",
        env: { ...process.env, FLUNCLE_BIN: fluncle, RETRY_EMPTY: "" },
      });

      return {
        exitCode: result.status,
        summary: JSON.parse(result.stdout) as Record<string, unknown>,
      };
    } finally {
      rmSync(rig, { force: true, recursive: true });
    }
  }

  test("the Worker's due-work deferral is an exit-zero paused tick", () => {
    const pending = JSON.stringify(
      {
        code: "due_work_maintenance_pending",
        message: "Due-work maintenance is still converging",
        ok: false,
      },
      null,
      2,
    );

    expect(tick(pending)).toMatchObject({
      exitCode: 0,
      summary: {
        checked: 0,
        errors: 0,
        failed: 0,
        gateState: "paused",
        ok: true,
        partial: false,
        produced: 0,
        reason: "due_work_repair_pending",
        retryEmpty: false,
        throttled: true,
      },
    });
  });

  test("a generic Worker fault stays a run error that exits non-zero", () => {
    const { exitCode, summary } = tick(
      JSON.stringify({ code: "error", message: "Internal error", ok: false }),
    );

    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({ errors: 1, ok: false, reason: "context_failed" });
  });
});

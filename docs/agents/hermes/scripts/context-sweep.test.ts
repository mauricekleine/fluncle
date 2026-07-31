import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    const source = readFileSync(new URL("./context-sweep.ts", import.meta.url), "utf8");
    const summary = buildContextSummary(
      { batch: 1, failed: 0, filled: 1, noop: 0, queueRemaining: 49 },
      false,
    );

    expect(summary).not.toHaveProperty("queue_depth");
    expect(source).toContain(
      "the queue read is capped and its predicate has no cheap covering count",
    );
    expect(source).not.toMatch(/\bqueue_depth\s*:/);
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

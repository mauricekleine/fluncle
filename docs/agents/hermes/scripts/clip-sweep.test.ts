// Canonical counter tests for the `fluncle-studio-clip` sweep. The API returns the
// full pending list, so queue depth is measured from that list while work stays
// bounded by the batch cap.

import { describe, expect, test } from "bun:test";

import {
  buildClipFatalSummary,
  classifyClipFailure,
  createClipSummary,
  recordClipOutcome,
} from "./clip-sweep";

describe("clip sweep canonical counters", () => {
  test("checked is the attempted batch, produced is cut clips, and queue depth uses the full list", () => {
    const summary = createClipSummary(17);

    recordClipOutcome(summary, "cut");
    recordClipOutcome(summary, "deferred");
    recordClipOutcome(summary, "failed");

    expect(summary).toEqual({
      batch: 3,
      checked: 3,
      cut: 1,
      errors: 0,
      failed: 1,
      pending: 17,
      produced: 1,
      queue_depth: 16,
      skipped: 2,
    });
  });

  test("set_not_staged is a defer, while another cut error is an item failure", () => {
    expect(classifyClipFailure('{"code":"set_not_staged"}')).toBe("deferred");
    expect(classifyClipFailure("ffmpeg exited 1")).toBe("failed");
  });

  test("a measured empty queue preserves checked: 0 and queue_depth: 0, never null", () => {
    const summary = createClipSummary(0);

    expect(summary.checked).toBe(0);
    expect(summary.checked).not.toBeNull();
    expect(summary.produced).toBe(0);
    expect(summary.queue_depth).toBe(0);
  });

  test("a fatal run reports errors without guessing work counters", () => {
    expect(buildClipFatalSummary()).toMatchObject({
      checked: null,
      errors: 1,
      failed: null,
      produced: null,
    });
  });
});

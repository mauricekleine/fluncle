import { describe, expect, test } from "bun:test";
import { buildLiveFailureSummary, buildLiveSummary } from "./fluncle-live";

describe("fluncle-live canonical counters", () => {
  test("counts the Twitch state read and a landed Worker post", () => {
    expect(
      buildLiveSummary({
        at: "2026-07-31T12:00:00.000Z",
        poll: { live: false, startedAt: null, title: null },
        posted: true,
      }),
    ).toMatchObject({
      checked: 1,
      errors: 0,
      failed: 0,
      produced: 1,
      queue_depth: 0,
    });
  });

  test("a read whose post did not land is an item failure, not a run error", () => {
    expect(
      buildLiveSummary({
        at: "2026-07-31T12:00:00.000Z",
        poll: { live: true, startedAt: "2026-07-31T11:55:00.000Z", title: "Live" },
        posted: false,
      }),
    ).toMatchObject({
      checked: 1,
      errors: 0,
      failed: 1,
      produced: 0,
      queue_depth: 0,
    });
  });

  test("a fatal poller failure reports one run error without inventing item counts", () => {
    expect(buildLiveFailureSummary()).toMatchObject({
      checked: null,
      errors: 1,
      failed: null,
      produced: null,
      queue_depth: 0,
    });
  });
});

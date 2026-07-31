import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { summarizePublishAdvance, summarizeSocialCapture } from "./worker-trigger-counters";

describe("fluncle-social-capture canonical counters", () => {
  test("posts polled are checked and captured URLs are produced", () => {
    expect(
      summarizeSocialCapture({
        captured: [
          { platform: "youtube", trackId: "one", url: "https://example.test/one" },
          { platform: "tiktok", trackId: "two", url: "https://example.test/two" },
        ],
        ok: true,
        polled: 5,
      }),
    ).toMatchObject({
      checked: 5,
      errors: 0,
      failed: 0,
      produced: 2,
    });
  });

  test("a measured empty poll remains checked: 0 and deliberately has no queue_depth", () => {
    const summary = summarizeSocialCapture({ captured: [], ok: true, polled: 0 });

    expect(summary.checked).toBe(0);
    expect(summary.produced).toBe(0);
    expect(summary).not.toHaveProperty("queue_depth");
  });
});

describe("fluncle-publish-advance canonical counters", () => {
  test("uses findings for checked/produced/failed while preserving platform failure detail", () => {
    const summary = summarizePublishAdvance({
      candidates: 4,
      failed: [
        { platform: "youtube", trackId: "failed-once" },
        { platform: "tiktok", trackId: "failed-once" },
      ],
      held: [{ platform: "youtube", reason: "daily_cap", trackId: "held" }],
      ok: true,
      paused: false,
      pushed: [
        { platform: "youtube", trackId: "published" },
        { platform: "tiktok", trackId: "published" },
      ],
    });

    expect(summary).toMatchObject({
      checked: 4,
      errors: 0,
      failed: 1,
      failedPushes: [
        { platform: "youtube", trackId: "failed-once" },
        { platform: "tiktok", trackId: "failed-once" },
      ],
      produced: 1,
    });
    expect(summary).not.toHaveProperty("queue_depth");
  });

  test("a paused tick reports unknown work counters instead of a fictional empty queue", () => {
    expect(
      summarizePublishAdvance({
        candidates: 0,
        failed: [],
        held: [],
        ok: true,
        paused: true,
        pushed: [],
      }),
    ).toMatchObject({
      checked: null,
      errors: 0,
      failed: 0,
      produced: null,
    });
  });
});

test("both curl wrappers pipe successful responses through the counter formatter", () => {
  for (const name of ["social-capture", "publish-advance"]) {
    const source = readFileSync(join(import.meta.dir, `${name}-sweep.sh`), "utf8");

    expect(source).toContain(`worker-trigger-counters.ts" ${name}`);
    expect(source).toContain('"errors":1');
    expect(source).not.toContain("queue_depth");
  }
});

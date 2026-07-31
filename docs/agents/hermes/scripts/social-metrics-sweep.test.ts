// Unit tests for social-metrics-sweep.ts — the social-metrics snapshot cron's orchestrator.
//
// The box only fires a bare trigger; the Worker selects, reads Postiz, and appends. So the contract
// worth pinning here is the tick's outcome mapping (the op response → the /status JSON summary) and
// its fault handling — the summary line the healthcheck prober reads must be honest on success AND
// failure.
//
// Runs outside any package's test runner (bun:test), like funnel-snapshot-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/social-metrics-sweep.test.ts

import { describe, expect, test } from "bun:test";
import {
  type RecordSocialMetricsResponse,
  runSocialMetricsTick,
  type SocialMetricsDeps,
} from "./social-metrics-sweep";

const RESPONSE: RecordSocialMetricsResponse = {
  configured: true,
  day: "2026-07-20",
  eligible: 40,
  failed: 1,
  inserted: 22,
  missing: 2,
  ok: true,
  polled: 25,
  referrals: { total: 137 },
  tiktok: { configured: true, failed: 0, fetched: 5, inserted: 3, matched: 4 },
  youtube: { configured: true, failed: 0, fetched: 8, inserted: 6, matched: 8 },
};

function deps(overrides: Partial<SocialMetricsDeps> = {}): SocialMetricsDeps {
  return {
    log: () => {},
    record: () => Promise.resolve(RESPONSE),
    ...overrides,
  };
}

describe("runSocialMetricsTick", () => {
  test("maps a good response to an ok summary with the headline counts", async () => {
    const summary = await runSocialMetricsTick(deps());

    expect(summary.ok).toBe(true);
    expect(summary.day).toBe("2026-07-20");
    expect(summary.configured).toBe(true);
    expect(summary.checked).toBe(38);
    expect(summary.produced).toBe(31);
    expect(summary.errors).toBe(0);
    expect(summary.eligible).toBe(40);
    expect(summary.failed).toBe(1);
    expect(summary.inserted).toBe(22);
    expect(summary.polled).toBe(25);
    expect(summary.missing).toBe(2);
    expect(summary.referralArrivals).toBe(137);
    expect(summary.tiktokConfigured).toBe(true);
    expect(summary.tiktokFailed).toBe(0);
    expect(summary.tiktokFetched).toBe(5);
    expect(summary.tiktokInserted).toBe(3);
    expect(summary.tiktokMatched).toBe(4);
    expect(summary.youtubeConfigured).toBe(true);
    expect(summary.youtubeFailed).toBe(0);
    expect(summary.youtubeFetched).toBe(8);
    expect(summary.youtubeInserted).toBe(6);
    expect(summary.youtubeMatched).toBe(8);
    expect(summary.error).toBeNull();
    // `eligible - polled` is a recurring rotation pool, not a drain backlog: same-day re-runs can
    // revisit it, and the independent TikTok/YouTube arms have no common outstanding-work total.
    expect("queueDepth" in summary).toBe(false);
    expect("queue_depth" in summary).toBe(false);
    expect("expectedIntervalMs" in summary).toBe(false);
    expect("expected_interval_ms" in summary).toBe(false);
  });

  test("preserves measured zero work as checked:0 rather than null or absence", async () => {
    const summary = await runSocialMetricsTick(
      deps({
        record: () =>
          Promise.resolve({
            failed: 0,
            inserted: 0,
            missing: 0,
            ok: true,
            polled: 0,
            tiktok: { configured: true, failed: 0, fetched: 0, inserted: 0 },
            youtube: { configured: true, failed: 0, fetched: 0, inserted: 0 },
          }),
      }),
    );

    expect(summary.checked).toBe(0);
    expect(summary.produced).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test.each([
    [
      "unconfigured",
      { configured: false, failed: 0, fetched: null, inserted: null, matched: null },
      { checked: 0, configured: false, failed: 0, fetched: null, produced: 0 },
    ],
    [
      "empty",
      { configured: true, failed: 0, fetched: 0, inserted: 0, matched: 0 },
      { checked: 0, configured: true, failed: 0, fetched: 0, produced: 0 },
    ],
    [
      "fault",
      { configured: null, failed: 1, fetched: null, inserted: null, matched: null },
      { checked: null, configured: null, failed: 1, fetched: null, produced: null },
    ],
  ] as const)(
    "keeps a TikTok %s distinct in the summary line",
    async (_state, tiktok, expected) => {
      const summary = await runSocialMetricsTick(
        deps({
          record: () =>
            Promise.resolve({
              failed: 0,
              inserted: 0,
              ok: true,
              polled: 0,
              tiktok,
              youtube: { configured: false, failed: 0, fetched: null, inserted: null },
            }),
        }),
      );

      expect(summary).toMatchObject({
        checked: expected.checked,
        errors: 0,
        failed: expected.failed,
        ok: true,
        produced: expected.produced,
        tiktokConfigured: expected.configured,
        tiktokFailed: expected.failed,
        tiktokFetched: expected.fetched,
      });
    },
  );

  test("counts both isolated arm faults as failed while the run remains successful", async () => {
    const summary = await runSocialMetricsTick(
      deps({
        record: () =>
          Promise.resolve({
            failed: 0,
            inserted: 0,
            ok: true,
            polled: 0,
            tiktok: { configured: true, failed: 1, fetched: null, inserted: null },
            youtube: { configured: true, failed: 1, fetched: null, inserted: null },
          }),
      }),
    );

    expect(summary).toMatchObject({
      errors: 0,
      failed: 2,
      ok: true,
      tiktokFailed: 1,
      youtubeFailed: 1,
    });
  });

  test("reports ok:false (never throws) when the op response is not ok", async () => {
    const summary = await runSocialMetricsTick(
      deps({ record: () => Promise.resolve({ ok: false }) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not return ok");
    expect(summary.errors).toBe(1);
    expect(summary.checked).toBeNull();
    expect(summary.produced).toBeNull();
    expect(summary.inserted).toBeNull();
  });

  test("reports ok:false with the error message when the record call throws", async () => {
    const summary = await runSocialMetricsTick(
      deps({ record: () => Promise.reject(new Error("metrics 500")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("metrics 500");
    expect(summary.errors).toBe(1);
    expect(summary.checked).toBeNull();
    expect(summary.produced).toBeNull();
    expect(summary.inserted).toBeNull();
  });

  test("tolerates a response missing a headline field — that field is null, the tick still ok", async () => {
    const summary = await runSocialMetricsTick(
      deps({ record: () => Promise.resolve({ day: "2026-07-20", ok: true }) }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.day).toBe("2026-07-20");
    expect(summary.inserted).toBeNull();
    expect(summary.referralArrivals).toBeNull();
    expect(summary.tiktokFetched).toBeNull();
    expect(summary.tiktokInserted).toBeNull();
    expect(summary.tiktokMatched).toBeNull();
    expect(summary.youtubeFetched).toBeNull();
    expect(summary.youtubeInserted).toBeNull();
    expect(summary.youtubeMatched).toBeNull();
  });
});

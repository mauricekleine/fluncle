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
  tiktok: { inserted: 3, matched: 4 },
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
    expect(summary.inserted).toBe(22);
    expect(summary.polled).toBe(25);
    expect(summary.missing).toBe(2);
    expect(summary.referralArrivals).toBe(137);
    expect(summary.tiktokInserted).toBe(3);
    expect(summary.tiktokMatched).toBe(4);
    expect(summary.error).toBeNull();
  });

  test("reports ok:false (never throws) when the op response is not ok", async () => {
    const summary = await runSocialMetricsTick(
      deps({ record: () => Promise.resolve({ ok: false }) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not return ok");
    expect(summary.inserted).toBeNull();
  });

  test("reports ok:false with the error message when the record call throws", async () => {
    const summary = await runSocialMetricsTick(
      deps({ record: () => Promise.reject(new Error("metrics 500")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("metrics 500");
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
    expect(summary.tiktokInserted).toBeNull();
    expect(summary.tiktokMatched).toBeNull();
  });
});

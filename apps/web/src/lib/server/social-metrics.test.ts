// The social-metrics snapshot, proven against the REAL migrated schema on an in-memory libSQL
// engine (the integration-db harness). What is easy to get wrong and impossible to see without a DB:
//
//   1. APPEND-ONLY + IDEMPOTENT PER DAY — the first run appends one row per published post; a
//      SAME-DAY re-run appends NOTHING (the (external_id, source, captured_day) unique index).
//   2. THE BUDGET is deterministic — recent posts first, then a rolling least-recently-snapshotted
//      tail, capped at SNAPSHOT_BUDGET (proven as a pure function, no DB).
//   3. A MISSING / ERRORING post is skipped, never aborting the batch.
//   4. NO POSTIZ KEY = a clean no-op on the Postiz half (configured:false) — the referrals block
//      still rides along.

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import { type SocialReferralsResult } from "./demand";
import { type PostAnalyticsResult, type SocialPostMetrics } from "./postiz";
import {
  recordSocialMetrics,
  selectSnapshotTargets,
  type SnapshotCandidate,
  SNAPSHOT_BUDGET,
} from "./social-metrics";

const NOW = new Date("2026-07-20T22:15:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

let db: Client;

const NO_REFERRALS: SocialReferralsResult = {
  arrivals: [],
  configured: false,
  total: 0,
  window: { end: "2026-07-20", start: "2026-06-20" },
};

const metrics = (over: Partial<SocialPostMetrics> = {}): SocialPostMetrics => ({
  averageViewPercentage: null,
  comments: null,
  impressions: null,
  likes: null,
  saves: null,
  shares: null,
  views: null,
  watchTimeSeconds: null,
  ...over,
});

async function seedPost(input: {
  externalId: string;
  platform?: "tiktok" | "youtube";
  publishedAt?: null | string;
  status?: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      crypto.randomUUID(),
      input.trackId,
      input.platform ?? "youtube",
      input.status ?? "published",
      input.externalId,
      input.publishedAt === undefined ? NOW.toISOString() : input.publishedAt,
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ],
    sql: `insert into social_posts (id, track_id, platform, status, external_id, published_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function metricsRowCount(externalId: string): Promise<number> {
  const result = await db.execute({
    args: [externalId],
    sql: `select count(*) as n from social_metrics where external_id = ?`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  process.env.POSTIZ_API_KEY = "test-key";
});

afterEach(() => {
  holder.db = undefined;
  delete process.env.POSTIZ_API_KEY;
  vi.restoreAllMocks();
});

describe("selectSnapshotTargets (the deterministic budget)", () => {
  const candidate = (over: Partial<SnapshotCandidate>): SnapshotCandidate => ({
    externalId: "x",
    lastSnapshotAt: null,
    platform: "youtube",
    publishedAt: NOW.toISOString(),
    trackId: "t",
    ...over,
  });

  it("takes every recent post first, newest first", () => {
    const posts = [
      candidate({
        externalId: "old",
        publishedAt: new Date(NOW.getTime() - 5 * DAY).toISOString(),
      }),
      candidate({
        externalId: "new",
        publishedAt: new Date(NOW.getTime() - 1 * DAY).toISOString(),
      }),
    ];

    const chosen = selectSnapshotTargets(posts, NOW.getTime());

    expect(chosen.map((p) => p.externalId)).toEqual(["new", "old"]);
  });

  it("caps at the budget", () => {
    const posts = Array.from({ length: SNAPSHOT_BUDGET + 10 }, (_, i) =>
      candidate({
        externalId: `p${i}`,
        publishedAt: new Date(NOW.getTime() - i * 60_000).toISOString(),
      }),
    );

    expect(selectSnapshotTargets(posts, NOW.getTime())).toHaveLength(SNAPSHOT_BUDGET);
  });

  it("fills leftover budget with the least-recently-snapshotted older tail (never-snapshotted wins)", () => {
    const old = (id: string, lastSnapshotAt: null | string) =>
      candidate({
        externalId: id,
        lastSnapshotAt,
        publishedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      });

    const posts = [
      old("snapshotted-recently", "2026-07-19T00:00:00.000Z"),
      old("never", null),
      old("snapshotted-long-ago", "2026-07-01T00:00:00.000Z"),
    ];

    const chosen = selectSnapshotTargets(posts, NOW.getTime(), 2);

    // Never-snapshotted first, then the oldest snapshot; the recently-snapshotted one is left out.
    expect(chosen.map((p) => p.externalId)).toEqual(["never", "snapshotted-long-ago"]);
  });
});

describe("recordSocialMetrics", () => {
  const analyticsFrom = (byId: Record<string, PostAnalyticsResult>) => (postId: string) =>
    Promise.resolve(byId[postId] ?? ({ kind: "missing" } as PostAnalyticsResult));

  it("appends one row per published post and maps its metrics; a same-day re-run appends nothing", async () => {
    await seedPost({ externalId: "yt-1", platform: "youtube", trackId: "track-1" });

    const fetchAnalytics = analyticsFrom({
      "yt-1": { kind: "metrics", metrics: metrics({ likes: 55, views: 1500 }) },
    });

    const first = await recordSocialMetrics({
      fetchAnalytics,
      now: NOW,
      readReferrers: () => Promise.resolve(NO_REFERRALS),
    });

    expect(first.configured).toBe(true);
    expect(first.eligible).toBe(1);
    expect(first.polled).toBe(1);
    expect(first.inserted).toBe(1);
    expect(await metricsRowCount("yt-1")).toBe(1);

    const row = (
      await db.execute({
        args: ["yt-1"],
        sql: `select * from social_metrics where external_id = ?`,
      })
    ).rows[0] as Record<string, unknown>;
    expect(Number(row.views)).toBe(1500);
    expect(Number(row.likes)).toBe(55);
    expect(row.comments).toBeNull();
    expect(row.captured_day).toBe("2026-07-20");
    expect(row.source).toBe("postiz");

    // Same UTC day again → idempotent (no new row).
    const second = await recordSocialMetrics({
      fetchAnalytics,
      now: NOW,
      readReferrers: () => Promise.resolve(NO_REFERRALS),
    });

    expect(second.inserted).toBe(0);
    expect(await metricsRowCount("yt-1")).toBe(1);
  });

  it("appends a fresh row on a later day (append-only, so velocity is measurable)", async () => {
    await seedPost({ externalId: "yt-1", trackId: "track-1" });

    const day1 = await recordSocialMetrics({
      fetchAnalytics: analyticsFrom({
        "yt-1": { kind: "metrics", metrics: metrics({ views: 1000 }) },
      }),
      now: NOW,
      readReferrers: () => Promise.resolve(NO_REFERRALS),
    });

    expect(day1.inserted).toBe(1);

    const day2 = await recordSocialMetrics({
      fetchAnalytics: analyticsFrom({
        "yt-1": { kind: "metrics", metrics: metrics({ views: 1400 }) },
      }),
      now: new Date(NOW.getTime() + DAY),
      readReferrers: () => Promise.resolve(NO_REFERRALS),
    });

    expect(day2.inserted).toBe(1);
    expect(await metricsRowCount("yt-1")).toBe(2);
  });

  it("skips a MISSING post and an ERRORING post without aborting the batch", async () => {
    await seedPost({ externalId: "ok", trackId: "t-ok" });
    await seedPost({ externalId: "missing", platform: "tiktok", trackId: "t-missing" });
    await seedPost({ externalId: "boom", trackId: "t-boom" });

    const summary = await recordSocialMetrics({
      fetchAnalytics: (postId) => {
        if (postId === "ok") {
          return Promise.resolve({ kind: "metrics", metrics: metrics({ views: 10 }) });
        }

        if (postId === "missing") {
          return Promise.resolve({ kind: "missing" });
        }

        return Promise.reject(new Error("postiz 502"));
      },
      now: NOW,
      readReferrers: () => Promise.resolve(NO_REFERRALS),
    });

    expect(summary.polled).toBe(3);
    expect(summary.inserted).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.failed).toBe(1);
    expect(await metricsRowCount("ok")).toBe(1);
    expect(await metricsRowCount("missing")).toBe(0);
    expect(await metricsRowCount("boom")).toBe(0);
  });

  it("ignores draft posts and posts with no external id (only published + Postiz-id rows are eligible)", async () => {
    await seedPost({ externalId: "published", trackId: "t-pub" });
    await seedPost({
      externalId: "draft-1",
      platform: "tiktok",
      status: "draft",
      trackId: "t-draft",
    });

    const summary = await recordSocialMetrics({
      fetchAnalytics: () => Promise.resolve({ kind: "metrics", metrics: metrics({ views: 1 }) }),
      now: NOW,
      readReferrers: () => Promise.resolve(NO_REFERRALS),
    });

    expect(summary.eligible).toBe(1);
    expect(summary.inserted).toBe(1);
  });

  it("is a clean no-op on the Postiz half with no key, but still carries the referrals block", async () => {
    delete process.env.POSTIZ_API_KEY;
    await seedPost({ externalId: "yt-1", trackId: "track-1" });

    const referrals: SocialReferralsResult = {
      arrivals: [{ pageviews: 42, platform: "tiktok" }],
      configured: true,
      total: 42,
      window: { end: "2026-07-20", start: "2026-06-20" },
    };

    let analyticsCalls = 0;
    const summary = await recordSocialMetrics({
      fetchAnalytics: () => {
        analyticsCalls += 1;

        return Promise.resolve({ kind: "metrics", metrics: metrics() });
      },
      now: NOW,
      readReferrers: () => Promise.resolve(referrals),
    });

    expect(summary.configured).toBe(false);
    expect(summary.polled).toBe(0);
    expect(summary.inserted).toBe(0);
    expect(analyticsCalls).toBe(0);
    expect(await metricsRowCount("yt-1")).toBe(0);
    // The site-side reach block rides along regardless.
    expect(summary.referrals.total).toBe(42);
    expect(summary.referrals.arrivals).toEqual([{ pageviews: 42, platform: "tiktok" }]);
  });
});

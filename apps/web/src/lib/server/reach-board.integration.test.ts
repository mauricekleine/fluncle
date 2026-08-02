import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedTrack } from "./integration-db";
import { getSocialMetricsBoard } from "./reach-board";

// THE BOARD SQL, PROVEN AGAINST THE REAL SCHEMA. The unit tests cover the pure velocity/pivot
// helpers; THIS file proves the board's SQL reads `video_structure` from the RIGHT TABLE
// (`findings`, not `tracks`). A query built from the generated migrations is the only honest
// oracle: if a column moves tables, this fails at build time.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

async function seedFindingVideoAxes(
  trackId: string,
  structure: string,
  plateSubject: string,
): Promise<void> {
  await db.execute({
    args: [structure, plateSubject, trackId],
    sql: `update findings set video_structure = ?, video_plate_subject = ? where track_id = ?`,
  });
}

async function seedPost(trackId: string, platform: string, url: string): Promise<void> {
  await db.execute({
    args: [`post-${trackId}-${platform}`, trackId, platform, url, new Date().toISOString()],
    sql: `insert into social_posts (id, track_id, platform, url, status, published_at, created_at, updated_at)
      values (?, ?, ?, ?, 'published', ?, datetime('now'), datetime('now'))`,
  });
}

async function seedSnapshot(
  externalId: string,
  source: string,
  platform: string,
  trackId: string,
  day: string,
  views: number,
): Promise<void> {
  await db.execute({
    args: [`${externalId}:${source}:${day}`, externalId, source, platform, trackId, day, views],
    sql: `insert into social_metrics
      (id, external_id, source, platform, track_id, captured_day, views, captured_at, created_at)
      values (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("getSocialMetricsBoard against the generated schema", () => {
  it("runs the board SQL and reads the creative axes from the FINDINGS row", async () => {
    await seedTrack(db, {
      artists: ["Urbandawn"],
      logId: "047.6.2H",
      title: "Under Your Sheets",
      trackId: "t-1",
    });
    await seedFindingVideoAxes("t-1", "flow", "creature");
    await seedPost("t-1", "youtube", "https://www.youtube.com/shorts/abc123def45");
    await seedSnapshot("abc123def45", "youtube_analytics", "youtube", "t-1", "2026-07-24", 1000);
    await seedSnapshot("abc123def45", "youtube_analytics", "youtube", "t-1", "2026-07-26", 3000);

    const board = await getSocialMetricsBoard();
    const row = board.posts.find((post) => post.externalId === "abc123def45");

    if (!row) {
      throw new Error("expected the seeded series on the board");
    }

    expect(row.structure).toBe("flow");
    expect(row.plateSubject).toBe("creature");
    expect(row.views).toBe(3000);
    // 2,000 views over a 2-day gap — the gap-aware rate, straight from the SQL's components.
    expect(row.dailyViewVelocity).toBe(1000);
  });

  it("returns an uncertified catalogue row without axes rather than erroring", async () => {
    await seedTrack(db, { artists: ["Nu:Tone"], logId: null, title: "The Wave", trackId: "t-2" });
    await seedPost("t-2", "tiktok", "https://www.tiktok.com/@fluncle/video/999");
    await seedSnapshot("999", "tiktok_display", "tiktok", "t-2", "2026-07-26", 250);

    const board = await getSocialMetricsBoard();
    const row = board.posts.find((post) => post.externalId === "999");

    if (!row) {
      throw new Error("expected the lone-snapshot series on the board");
    }

    expect(row.snapshotCount).toBe(1);
    expect(row.dailyViewVelocity).toBeNull();
  });
});

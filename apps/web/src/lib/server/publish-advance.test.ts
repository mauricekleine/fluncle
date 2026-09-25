import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => ({ execute: (...args: unknown[]) => execute(...args) }),
  typedRow: <T>(rows: T[]): T | undefined => rows[0],
  typedRows: <T>(rows: T[]): T[] => rows,
}));

import {
  ADVANCE_DAILY_PUSH_CAP,
  ADVANCE_PER_TICK_CAP,
  ADVANCE_SETTLE_MS,
  advanceCandidates,
  bundleGaps,
  isPublishAdvancePaused,
  PUBLISH_ADVANCE_PAUSED_KEY,
  REQUIRED_BUNDLE_FILES,
  setPublishAdvancePaused,
  TIKTOK_INBOX_DRAFT_CAP,
} from "./publish-advance";
import { claimPost, countTikTokInboxDrafts } from "./social";

function statementAt(index: number): { args: unknown[]; sql: string } {
  const statement = execute.mock.calls[index]?.[0] as { args: unknown[]; sql: string } | undefined;

  if (!statement) {
    throw new Error(`no db.execute call at index ${index}`);
  }

  return statement;
}

const sqlOf = (index: number): string => String(statementAt(index).sql);
const argsOf = (index: number): unknown[] => statementAt(index).args;

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue({ rows: [], rowsAffected: 0 });
});

describe("the kill switch (default-deny)", () => {
  it("reads PAUSED when the flag was never set", async () => {
    execute.mockResolvedValue({ rows: [] });

    expect(await isPublishAdvancePaused()).toBe(true);
  });

  it("reads PAUSED on an unrecognised value", async () => {
    execute.mockResolvedValue({ rows: [{ value: "" }] });
    expect(await isPublishAdvancePaused()).toBe(true);

    execute.mockResolvedValue({ rows: [{ value: "no" }] });
    expect(await isPublishAdvancePaused()).toBe(true);

    execute.mockResolvedValue({ rows: [{ value: "true" }] });
    expect(await isPublishAdvancePaused()).toBe(true);
  });

  it("reads RUNNING only on the explicit string `false`", async () => {
    execute.mockResolvedValue({ rows: [{ value: "false" }] });

    expect(await isPublishAdvancePaused()).toBe(false);
  });

  it("writes the flag to the shared settings KV", async () => {
    await setPublishAdvancePaused(true);

    expect(sqlOf(0)).toContain("insert into settings");
    expect(argsOf(0)).toEqual([PUBLISH_ADVANCE_PAUSED_KEY, "true", "true"]);

    await setPublishAdvancePaused(false);
    expect(argsOf(1)).toEqual([PUBLISH_ADVANCE_PAUSED_KEY, "false", "false"]);
  });
});

describe("advanceCandidates (the READY predicate)", () => {
  it("requires a coordinate, BOTH masters, a settled render, and an unpushed platform", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    await advanceCandidates({ limit: 1, nowMs: now });

    const sql = sqlOf(0).replace(/\s+/g, " ");

    expect(sql).toContain("t.log_id is not null");
    expect(sql).toContain("t.video_url is not null");

    expect(sql).toContain("t.video_squared_at is not null");

    expect(sql).toContain("t.video_squared_at <= ?");

    expect(sql).toContain("yt.track_id is null or tk.track_id is null");

    expect(sql).toContain("order by t.video_squared_at asc");

    expect(argsOf(0)).toEqual([new Date(now - ADVANCE_SETTLE_MS).toISOString(), 1]);
  });

  it("reports each finding's UNPUSHED platforms only", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          log_id: "039.8.7J",
          tiktok_posted: 0,
          title: "One",
          track_id: "t1",
          video_squared_at: "2026-07-11T10:00:00.000Z",
          youtube_posted: 0,
        },
        {
          log_id: "040.1.2K",
          tiktok_posted: 0,
          title: "Two",
          track_id: "t2",
          video_squared_at: "2026-07-11T11:00:00.000Z",
          youtube_posted: 1,
        },
      ],
    });

    const candidates = await advanceCandidates({ limit: 5, nowMs: Date.now() });

    expect(candidates.map((candidate) => candidate.pending)).toEqual([
      ["youtube", "tiktok"],
      ["tiktok"],
    ]);
  });

  it("never queries at all for a non-positive limit", async () => {
    expect(await advanceCandidates({ limit: 0, nowMs: Date.now() })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("claimPost (the atomic claim)", () => {
  it("is an insert-or-nothing against the (track, platform) unique index", async () => {
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });

    await claimPost("t1", "youtube");

    const sql = sqlOf(0).replace(/\s+/g, " ");
    expect(sql).toContain("insert into social_posts");
    expect(sql).toContain("on conflict(track_id, platform) do nothing");

    expect(sql).toContain("'failed'");
  });

  it("returns true for the winner and false for the loser", async () => {
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });
    expect(await claimPost("t1", "youtube")).toBe(true);

    execute.mockResolvedValue({ rows: [], rowsAffected: 0 });
    expect(await claimPost("t1", "youtube")).toBe(false);
  });
});

describe("countTikTokInboxDrafts", () => {
  it("counts only the UNFINISHED tiktok inbox drafts (TikTok's 5-per-24h ceiling)", async () => {
    execute.mockResolvedValue({ rows: [{ n: 5 }] });

    expect(await countTikTokInboxDrafts()).toBe(TIKTOK_INBOX_DRAFT_CAP);

    const sql = sqlOf(0).replace(/\s+/g, " ");
    expect(sql).toContain("platform = 'tiktok'");
    expect(sql).toContain("status = 'draft'");
  });
});

describe("bundleGaps (the server-side bundle_incomplete guard)", () => {
  it("requires BOTH masters plus the whole re-render contract", () => {
    expect([...REQUIRED_BUNDLE_FILES]).toEqual([
      "footage.mp4",
      "footage.social.mp4",
      "composition.tsx",
      "props.json",
      "render.json",
    ]);
  });

  it("is empty when every required object is served", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }),
    );

    expect(await bundleGaps("039.8.7J", fetchFn as unknown as typeof fetch)).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(REQUIRED_BUNDLE_FILES.length);

    expect(fetchFn.mock.calls.every((call) => call[1]?.method === "HEAD")).toBe(true);

    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://found.fluncle.com/039.8.7J/footage.mp4");
  });

  it("names the missing file when the portrait social cut is not there", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith("footage.social.mp4")
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200 }),
    );

    expect(await bundleGaps("039.8.7J", fetchFn as unknown as typeof fetch)).toEqual([
      "footage.social.mp4",
    ]);
  });

  it("names the re-render contract files a --allow-partial upload left behind", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      /composition\.tsx|props\.json|render\.json/.test(url)
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200 }),
    );

    expect(await bundleGaps("039.8.7J", fetchFn as unknown as typeof fetch)).toEqual([
      "composition.tsx",
      "props.json",
      "render.json",
    ]);
  });

  it("FAILS CLOSED on a network error (an unreachable object counts as missing)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    expect(await bundleGaps("039.8.7J", fetchFn as unknown as typeof fetch)).toEqual([
      ...REQUIRED_BUNDLE_FILES,
    ]);
  });
});

describe("the bounds", () => {
  it("advances ONE finding per tick and caps the rolling day at TWO findings", () => {
    expect(ADVANCE_PER_TICK_CAP).toBe(1);

    expect(ADVANCE_DAILY_PUSH_CAP).toBe(4);
    expect(ADVANCE_DAILY_PUSH_CAP / 2).toBe(2);

    expect(ADVANCE_SETTLE_MS).toBe(6 * 60 * 60 * 1000);
  });
});

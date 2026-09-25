import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => ({ execute: (...args: unknown[]) => execute(...args) }),
  typedRow: <T>(rows: T[]): T | undefined => rows[0],
  typedRows: <T>(rows: T[]): T[] => rows,
}));

import {
  DRIP_MAX_GAP_MS,
  DRIP_MIN_GAP_MS,
  computeNextDripSlot,
  countRecentPostedInWindow,
  deleteClipPost,
  dueClipPosts,
  isDripPaused,
  setDripPaused,
} from "./clip-social";

beforeEach(() => {
  execute.mockReset();
});

describe("computeNextDripSlot", () => {
  const NOW = Date.parse("2026-07-05T12:00:00.000Z");

  it("bases off now when the queue is empty (no tail)", () => {
    const slot = computeNextDripSlot(undefined, NOW, () => 0);

    expect(Date.parse(slot) - NOW).toBe(DRIP_MIN_GAP_MS);
  });

  it("keeps the jitter within [23h, 25h] across the random range", () => {
    for (const roll of [0, 0.5, 1]) {
      const gap = Date.parse(computeNextDripSlot(undefined, NOW, () => roll)) - NOW;

      expect(gap).toBeGreaterThanOrEqual(DRIP_MIN_GAP_MS);
      expect(gap).toBeLessThanOrEqual(DRIP_MAX_GAP_MS);
    }

    expect(Date.parse(computeNextDripSlot(undefined, NOW, () => 0)) - NOW).toBe(DRIP_MIN_GAP_MS);
    expect(Date.parse(computeNextDripSlot(undefined, NOW, () => 1)) - NOW).toBe(DRIP_MAX_GAP_MS);
    expect(Date.parse(computeNextDripSlot(undefined, NOW, () => 0.5)) - NOW).toBe(
      (DRIP_MIN_GAP_MS + DRIP_MAX_GAP_MS) / 2,
    );
  });

  it("chains off a FUTURE tail (the queue extends), not off now", () => {
    const tail = new Date(NOW + 40 * 60 * 60 * 1000).toISOString();
    const slot = computeNextDripSlot(tail, NOW, () => 0);

    expect(Date.parse(slot) - Date.parse(tail)).toBe(DRIP_MIN_GAP_MS);
  });

  it("bases off now when the tail is in the PAST (queue drained)", () => {
    const pastTail = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    const slot = computeNextDripSlot(pastTail, NOW, () => 0);

    expect(Date.parse(slot) - NOW).toBe(DRIP_MIN_GAP_MS);
  });

  it("bases off now when the tail is malformed", () => {
    const slot = computeNextDripSlot("not-a-date", NOW, () => 0);

    expect(Date.parse(slot) - NOW).toBe(DRIP_MIN_GAP_MS);
  });
});

describe("the kill switch (settings KV)", () => {
  it("runs only when the flag is exactly 'false' (DEFAULT-DENY)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ value: "false" }] });
    expect(await isDripPaused()).toBe(false);

    execute.mockResolvedValueOnce({ rows: [{ value: "true" }] });
    expect(await isDripPaused()).toBe(true);
  });

  it("reads PAUSED when the row is absent, empty, or unrecognised", async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    expect(await isDripPaused()).toBe(true);

    execute.mockResolvedValueOnce({ rows: [{ value: "" }] });
    expect(await isDripPaused()).toBe(true);

    execute.mockResolvedValueOnce({ rows: [{ value: "no" }] });
    expect(await isDripPaused()).toBe(true);

    execute.mockResolvedValueOnce({ rows: [{ value: "False" }] });
    expect(await isDripPaused()).toBe(true);
  });

  it("upserts 'true'/'false' on set", async () => {
    execute.mockResolvedValue({ rows: [] });

    await setDripPaused(true);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ["clip_drip_paused", "true", "true"] }),
    );

    await setDripPaused(false);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ["clip_drip_paused", "false", "false"] }),
    );
  });
});

describe("dueClipPosts", () => {
  it("returns [] without a query when the limit is non-positive", async () => {
    expect(await dueClipPosts({ limit: 0 })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("selects only scheduled + due + done rows, bounded by the limit", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ clip_id: "c1", scheduled_for: "2026-07-05T00:00:00.000Z" }],
    });

    const due = await dueClipPosts({ limit: 3 });

    expect(due).toEqual([{ clipId: "c1", scheduledFor: "2026-07-05T00:00:00.000Z" }]);

    const call = execute.mock.calls[0]?.[0] as { args: unknown[]; sql: string };
    expect(call.sql).toContain("status = 'scheduled'");

    expect(call.sql).not.toContain("p.caption");
    expect(call.sql).toContain("c.status = 'done'");
    expect(call.sql).toContain("scheduled_for <= ?");

    expect(call.args[call.args.length - 1]).toBe(3);
  });
});

describe("countRecentPostedInWindow", () => {
  it("counts posted rows since the window start", async () => {
    execute.mockResolvedValueOnce({ rows: [{ n: 4 }] });

    const n = await countRecentPostedInWindow("2026-07-04T12:00:00.000Z");

    expect(n).toBe(4);
    const call = execute.mock.calls[0]?.[0] as { sql: string };
    expect(call.sql).toContain("status = 'posted'");
    expect(call.sql).toContain("updated_at >= ?");
  });
});

describe("deleteClipPost (unschedule)", () => {
  it("deletes the clip's un-posted instagram row, sparing a posted one", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    await deleteClipPost("c1");

    const call = execute.mock.calls[0]?.[0] as { args: unknown[]; sql: string };
    expect(call.sql).toContain("delete from mixtape_clip_social_posts");
    expect(call.sql).toContain("clip_id = ?");

    expect(call.sql).toContain("status <> 'posted'");
    expect(call.args).toEqual(["c1", "instagram"]);
  });
});

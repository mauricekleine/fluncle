import { describe, expect, test } from "bun:test";

import {
  artistTitle,
  dayKey,
  mapQueue,
  mapSurfaces,
  minutesSince,
  newestPostedAt,
  type NudgeInput,
  nudgeTick,
  type PostingCandidate,
  postFreshness,
  type PostRecord,
  selectNextToPost,
  surfaceTally,
} from "./logic";

const HOUR = 3_600_000;

// A fixed clock so every age is deterministic.
const NOW = Date.parse("2026-07-06T20:00:00Z");

function candidate(overrides: Partial<PostingCandidate> & { logId: string }): PostingCandidate {
  return {
    addedAt: "2026-07-06T00:00:00Z",
    artists: ["Artist"],
    postedAt: null,
    postedToTikTok: false,
    title: "Title",
    ...overrides,
  };
}

describe("artistTitle", () => {
  test("joins several artists then the title", () => {
    expect(artistTitle(["A", "B"], "Track")).toBe("A & B — Track");
  });

  test("a single artist reads plainly", () => {
    expect(artistTitle(["Solo"], "Track")).toBe("Solo — Track");
  });

  test("no artists collapses to just the title", () => {
    expect(artistTitle([], "Track")).toBe("Track");
    expect(artistTitle([" "], "Track")).toBe("Track");
  });
});

describe("minutesSince", () => {
  test("whole minutes elapsed", () => {
    expect(minutesSince("2026-07-06T19:30:00Z", NOW)).toBe(30);
  });

  test("a future timestamp clamps to zero, never negative", () => {
    expect(minutesSince("2026-07-06T21:00:00Z", NOW)).toBe(0);
  });

  test("an unparseable timestamp reads zero", () => {
    expect(minutesSince("not-a-date", NOW)).toBe(0);
  });
});

describe("mapQueue", () => {
  test("maps findings to rows and drops the coordinate-less", () => {
    const rows = mapQueue(
      [
        { addedAt: "2026-07-06T19:00:00Z", artists: ["A"], logId: "001.1.1A", title: "One" },
        { addedAt: "2026-07-06T18:00:00Z", artists: ["B"], title: "Two" }, // no logId → dropped
      ],
      NOW,
    );

    expect(rows).toEqual([{ ageMinutes: 60, artistTitle: "A — One", logId: "001.1.1A" }]);
  });

  test("preserves the incoming (oldest-first) order", () => {
    const rows = mapQueue(
      [
        { addedAt: "2026-07-01T00:00:00Z", artists: ["A"], logId: "a", title: "T" },
        { addedAt: "2026-07-02T00:00:00Z", artists: ["B"], logId: "b", title: "T" },
      ],
      NOW,
    );

    expect(rows.map((row) => row.logId)).toEqual(["a", "b"]);
  });
});

describe("selectNextToPost", () => {
  test("picks the OLDEST finding not yet on TikTok", () => {
    const picked = selectNextToPost([
      candidate({ addedAt: "2026-07-06T10:00:00Z", logId: "newer" }),
      candidate({ addedAt: "2026-07-05T10:00:00Z", logId: "older" }),
      candidate({ addedAt: "2026-07-04T10:00:00Z", logId: "posted", postedToTikTok: true }),
    ]);

    expect(picked?.logId).toBe("older");
  });

  test("skips findings already on TikTok", () => {
    const picked = selectNextToPost([
      candidate({ logId: "a", postedToTikTok: true }),
      candidate({ logId: "b", postedToTikTok: false }),
    ]);

    expect(picked?.logId).toBe("b");
  });

  test("returns undefined when everything has gone out", () => {
    expect(selectNextToPost([candidate({ logId: "a", postedToTikTok: true })])).toBeUndefined();
  });
});

describe("newestPostedAt", () => {
  test("the freshest post across the window", () => {
    expect(
      newestPostedAt([
        candidate({ logId: "a", postedAt: 100 }),
        candidate({ logId: "b", postedAt: 900 }),
        candidate({ logId: "c", postedAt: null }),
      ]),
    ).toBe(900);
  });

  test("null when nothing has been posted", () => {
    expect(newestPostedAt([candidate({ logId: "a", postedAt: null })])).toBeNull();
  });
});

describe("postFreshness", () => {
  const at = (
    iso: string,
    platform: string,
    status: string,
    field = "publishedAt",
  ): PostRecord => ({
    platform,
    status,
    [field]: iso,
  });

  test("a live TikTok post marks postedToTikTok and sets the stamp", () => {
    const { postedAt, postedToTikTok } = postFreshness([
      at("2026-07-06T12:00:00Z", "tiktok", "published"),
    ]);

    expect(postedToTikTok).toBe(true);
    expect(postedAt).toBe(Date.parse("2026-07-06T12:00:00Z"));
  });

  test("a drafted TikTok counts as gone out (it's in the inbox)", () => {
    expect(postFreshness([at("2026-07-06T12:00:00Z", "tiktok", "draft")]).postedToTikTok).toBe(
      true,
    );
  });

  test("a failed post re-opens the finding as unposted", () => {
    const { postedAt, postedToTikTok } = postFreshness([
      at("2026-07-06T12:00:00Z", "tiktok", "failed"),
    ]);

    expect(postedToTikTok).toBe(false);
    expect(postedAt).toBeNull();
  });

  test("the freshest stamp wins across platforms; publishedAt over updatedAt", () => {
    const { postedAt } = postFreshness([
      at("2026-07-06T10:00:00Z", "youtube", "published"),
      {
        platform: "tiktok",
        publishedAt: "2026-07-06T14:00:00Z",
        status: "published",
        updatedAt: "2000-01-01T00:00:00Z",
      },
    ]);

    expect(postedAt).toBe(Date.parse("2026-07-06T14:00:00Z"));
  });
});

describe("mapSurfaces / surfaceTally", () => {
  test("maps rows, defaulting an unknown status to down", () => {
    const rows = mapSurfaces({
      services: [
        { latencyMs: 40, message: null, service: "web", status: "ok" },
        { service: "hermes", status: "weird" },
      ],
    });

    expect(rows).toEqual([
      { latencyMs: 40, message: null, service: "web", status: "ok" },
      { latencyMs: null, message: null, service: "hermes", status: "down" },
    ]);
  });

  test("tallies the health states", () => {
    const rows = mapSurfaces({
      services: [
        { service: "a", status: "ok" },
        { service: "b", status: "ok" },
        { service: "c", status: "degraded" },
        { service: "d", status: "down" },
      ],
    });

    expect(surfaceTally(rows)).toEqual({ degraded: 1, down: 1, ok: 2 });
  });
});

describe("dayKey", () => {
  test("formats YYYY-MM-DD in the given zone", () => {
    expect(dayKey(Date.parse("2026-07-06T12:00:00Z"), "UTC")).toBe("2026-07-06");
  });

  test("the zone decides which day 'now' falls on", () => {
    // 02:00 UTC is still the previous evening in Los Angeles.
    expect(dayKey(Date.parse("2026-07-06T02:00:00Z"), "America/Los_Angeles")).toBe("2026-07-05");
  });
});

describe("nudgeTick", () => {
  const base: NudgeInput = {
    hasUnposted: true,
    lastNudgeDay: null,
    newestPostedAt: NOW - 20 * HOUR,
    nextLabel: "Artist — Title",
    now: NOW,
    thresholdHours: 18,
    timeZone: "UTC",
  };

  test("nothing unposted → never nudge", () => {
    const decision = nudgeTick({ ...base, hasUnposted: false });

    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("no-unposted");
  });

  test("a post younger than the threshold → too fresh, hold", () => {
    const decision = nudgeTick({ ...base, newestPostedAt: NOW - 3 * HOUR });

    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("fresh");
  });

  test("stale + not nudged today → fire once, carrying the day key", () => {
    const decision = nudgeTick(base);

    expect(decision.fire).toBe(true);

    if (decision.fire) {
      expect(decision.reason).toBe("stale");
      expect(decision.title).toBe("Artist — Title");
      expect(decision.body).toContain("Dressed and waiting");
      expect(decision.body).toContain("20h");
      expect(decision.nudgeDay).toBe("2026-07-06");
    }
  });

  test("already nudged today → hold (no nag storms)", () => {
    const decision = nudgeTick({ ...base, lastNudgeDay: "2026-07-06" });

    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("already-nudged-today");
  });

  test("nothing ever posted but a render waits → infinitely stale, fires", () => {
    const decision = nudgeTick({ ...base, newestPostedAt: null });

    expect(decision.fire).toBe(true);

    if (decision.fire) {
      expect(decision.body).toContain("nothing's gone out yet");
    }
  });

  test("clock injection flips the same data from fresh to stale", () => {
    const posted = NOW - 10 * HOUR;

    expect(nudgeTick({ ...base, newestPostedAt: posted, now: posted + 10 * HOUR }).fire).toBe(
      false,
    );
    expect(nudgeTick({ ...base, newestPostedAt: posted, now: posted + 19 * HOUR }).fire).toBe(true);
  });

  test("a new local day clears the dedupe so it can fire again", () => {
    const yesterday = nudgeTick({ ...base, lastNudgeDay: "2026-07-05" });

    expect(yesterday.fire).toBe(true);
  });
});

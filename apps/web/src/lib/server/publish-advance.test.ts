import { beforeEach, describe, expect, it, vi } from "vitest";

// The render → publish auto-advance's STORE half — the reads and the flag the tick is built
// on. The orchestration (which gate fires in which order) is proven end-to-end through
// `handleOrpc` in ./orpc-publish-advance.test.ts; this file pins the primitives underneath
// it: the default-deny kill switch, the READY predicate's SQL, the atomic CLAIM, and the
// bundle gate.
//
// `./db` is mocked so every SQL shape is inspectable without a database.

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

// The nth `db.execute({ sql, args })` the code under test issued — throws (rather than
// silently passing) if it never ran, so an assertion can never vacuously succeed.
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

// ── The kill switch: DEFAULT-DENY ────────────────────────────────────────────
//
// The property that lets an automated PUBLIC publish ship dark: only an explicit `"false"`
// means running. Everything else — an unset key, an empty database, a stray value — reads
// as paused. Losing the flag can never turn posting ON.
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

// ── READY: what the tick is even allowed to look at ──────────────────────────
describe("advanceCandidates (the READY predicate)", () => {
  it("requires a coordinate, BOTH masters, a settled render, and an unpushed platform", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    await advanceCandidates({ limit: 1, nowMs: now });

    const sql = sqlOf(0).replace(/\s+/g, " ");

    // The coordinate + the render's own done-gate.
    expect(sql).toContain("t.log_id is not null");
    expect(sql).toContain("t.video_url is not null");
    // The TWO-MASTER signal: the finalize that set it was handed BOTH the square
    // footage.mp4 and the portrait footage.social.mp4 — the cut both platforms push. A
    // legacy/footage-only finding has no such signal and is never auto-advanced.
    expect(sql).toContain("t.video_squared_at is not null");
    // The settle window (the operator's chance to requeue a bad render before it is public).
    expect(sql).toContain("t.video_squared_at <= ?");
    // Only a platform with NO row at all — never twice, and never an auto-retry of a
    // `failed` push.
    expect(sql).toContain("yt.track_id is null or tk.track_id is null");
    // Oldest render first, so the backlog drains in order.
    expect(sql).toContain("order by t.video_squared_at asc");

    // The settle cutoff is `now - ADVANCE_SETTLE_MS`, and the limit is bound, not inlined.
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
          // Already on YouTube (hand-pushed) — only the TikTok leg is still open.
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

// ── The CLAIM: the atomic double-publish guard ───────────────────────────────
//
// The whole never-twice property rests on this one statement being an
// `insert … on conflict do nothing` against the (track, platform) unique index: two
// overlapping ticks both reach it, the index arbitrates, and exactly one gets a row.
describe("claimPost (the atomic claim)", () => {
  it("is an insert-or-nothing against the (track, platform) unique index", async () => {
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });

    await claimPost("t1", "youtube");

    const sql = sqlOf(0).replace(/\s+/g, " ");
    expect(sql).toContain("insert into social_posts");
    expect(sql).toContain("on conflict(track_id, platform) do nothing");
    // The claim row is written `failed` — assume the push failed until it is PROVEN to have
    // succeeded, so a Worker that dies mid-push leaves an honest, never-auto-retried row.
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

// ── The bundle gate: never publish a half-rendered finding ───────────────────
describe("bundleGaps (the server-side bundle_incomplete guard)", () => {
  it("requires BOTH masters plus the whole re-render contract", () => {
    // The exact set the CLI's `bundle_incomplete` guard hard-errors on, plus the two
    // masters. A partial bundle reaches the DB only via the CLI's `--allow-partial` escape
    // hatch — and a partial bundle must never be something the MACHINE publishes.
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
    // A HEAD — the bytes are never pulled just to check they exist.
    expect(fetchFn.mock.calls.every((call) => call[1]?.method === "HEAD")).toBe(true);
    // Against the PUBLIC url — which is exactly what Postiz pulls from, so serving it IS
    // the precondition we care about.
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
    // A public publish is not batched: one shot per tick, so a bug gets caught rather than
    // fanned out.
    expect(ADVANCE_PER_TICK_CAP).toBe(1);

    // The operator's ruling: no more than TWO findings a day on the channel. The cap counts
    // PUSHES and a finding costs two (YouTube + TikTok), so the number that means "2 findings"
    // is 4. This test exists because the units are the trap: the previous 6 read as a generous
    // backstop and was really 3 findings a day.
    expect(ADVANCE_DAILY_PUSH_CAP).toBe(4);
    expect(ADVANCE_DAILY_PUSH_CAP / 2).toBe(2); // findings per day — the unit that matters

    // Six hours is the operator's window to catch a bad render and requeue it before the
    // machine can put it on a public channel. It was 15 minutes, which is not a window a
    // human is inside.
    expect(ADVANCE_SETTLE_MS).toBe(6 * 60 * 60 * 1000);
  });
});

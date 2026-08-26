import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recording-MBID fill sweep (the MusicBrainz identity layer): the FREE crawler PK strip, then
// the ISRC→recording resolve of findings/Spotify-born rows through the shared MusicBrainz client.
// The DB and the MB client are mocked, so a test never hits a real database or the network.

const execute = vi.fn();
const mbFetch = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  const projectionMaintenance = (sql: string) =>
    sql.includes("insert into due_work") ||
    sql.includes("public_aggregate_state") ||
    sql.includes("artist_qualification_state") ||
    sql.includes("projection_repairs");

  return {
    ...actual,
    getDb: async () => ({
      batch: (statements: { args?: unknown[]; sql: string }[]) =>
        Promise.all(
          statements.map((statement) =>
            projectionMaintenance(statement.sql)
              ? Promise.resolve({ rows: [], rowsAffected: 1 })
              : execute(statement),
          ),
        ),
      execute,
    }),
  };
});

vi.mock("./musicbrainz", async () => {
  const actual = await vi.importActual<typeof import("./musicbrainz")>("./musicbrainz");

  return { ...actual, mbFetch };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));
vi.mock("./due-work-cutover", () => ({
  isDueWorkCutoverEnabled: async () => false,
  readPromotedDueWorkPage: vi.fn(),
}));

const { recordingMbidFromTrackId, resolveRecordingMbids } = await import("./recording-mbids");

beforeEach(() => {
  execute.mockReset();
  mbFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** An ISRC→recordings MB hit (the first recording with an id wins). */
function mbHit(id: string) {
  return { data: { recordings: [{ id }] }, rateLimited: false };
}

/** A clean MB no-match (a 404/empty result → data null OR empty recordings). */
const MB_MISS = { data: { recordings: [] }, rateLimited: false };
const MB_THROTTLE = { data: null, rateLimited: true };

describe("recordingMbidFromTrackId", () => {
  it("strips the mb_ prefix off a crawler-born track id", () => {
    expect(recordingMbidFromTrackId("mb_abc-123")).toBe("abc-123");
  });

  it("returns null for a Spotify-born track id (no prefix)", () => {
    expect(recordingMbidFromTrackId("6rqhFgbbKwnb9MLmUQDhG6")).toBeNull();
  });
});

describe("resolveRecordingMbids", () => {
  it("fills crawler history from the PK, then resolves the ISRC tail (hit + miss)", async () => {
    // 1: the prefix strip UPDATE → 3 rows filled. 2: the ISRC worklist → 2 rows. 3+: the writes.
    execute.mockResolvedValueOnce({ rowsAffected: 3 });
    execute.mockResolvedValueOnce({
      rows: [
        { isrc: "GBABC1200001", track_id: "spotifyA" },
        { isrc: "GBABC1200002", track_id: "spotifyB" },
      ],
    });
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });

    mbFetch.mockResolvedValueOnce(mbHit("rec-uuid-A")); // spotifyA resolves
    mbFetch.mockResolvedValueOnce(MB_MISS); // spotifyB misses

    const result = await resolveRecordingMbids(10, false);

    expect(result.prefixStripped).toBe(3);
    expect(result.resolved).toEqual(["spotifyA"]);
    expect(result.missed).toEqual(["spotifyB"]);
    expect(result.failedCount).toBe(0);
    expect(result.rateLimited).toBe(false);
    expect(result.nextCursor).toBeNull(); // 2 rows < batch limit 10 ⇒ drained

    // The MB lookup hit /isrc/<isrc> for each row.
    expect(mbFetch).toHaveBeenCalledWith("/isrc/GBABC1200001");
    expect(mbFetch).toHaveBeenCalledWith("/isrc/GBABC1200002");

    // The resolved write stamped both the MBID and the attempt marker; the miss stamped only the
    // attempt marker (a distinct, shorter UPDATE).
    const writeSql = execute.mock.calls.slice(2).map((call) => String(call[0].sql));
    expect(writeSql.some((sql) => sql.includes("mb_recording_id = coalesce"))).toBe(true);
    expect(
      writeSql.some(
        (sql) =>
          sql.includes("set mb_recording_id_attempted_at = ?") &&
          !sql.includes("mb_recording_id = coalesce"),
      ),
    ).toBe(true);
  });

  it("circuit-breaks on a MusicBrainz throttle without stamping the row", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [{ isrc: "GBABC1200003", track_id: "spotifyC" }] });
    execute.mockResolvedValue({ rows: [] });

    mbFetch.mockResolvedValueOnce(MB_THROTTLE);

    const result = await resolveRecordingMbids(10, false);

    expect(result.rateLimited).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.resolvedCount).toBe(0);
    expect(result.missedCount).toBe(0);
    // Only the strip + the worklist read ran — no write (the throttled row is left untouched).
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns a cursor when a full page comes back (more to drain)", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({
      rows: [
        { isrc: "GBABC1200004", track_id: "spotifyD" },
        { isrc: "GBABC1200005", track_id: "spotifyE" },
      ],
    });
    execute.mockResolvedValue({ rows: [] });

    mbFetch.mockResolvedValue(mbHit("rec-uuid"));

    const result = await resolveRecordingMbids(2, false);

    expect(result.resolvedCount).toBe(2);
    expect(result.nextCursor).toBe("spotifyE"); // full page ⇒ resume from the last track id
  });

  it("skips the free prefix strip on a cursored (continuation) page", async () => {
    // A continuation page carries a cursor, so the strip is not re-run — only the ISRC worklist.
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveRecordingMbids(10, false, "spotifyM");

    expect(result.prefixStripped).toBe(0);
    // No strip UPDATE — the first (and only) execute is the worklist read.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(String(execute.mock.calls[0]?.[0].sql)).toContain("track_id > ?");
  });

  it("a dry run counts both worklists and touches no vendor or write", async () => {
    execute.mockResolvedValueOnce({ rows: [{ n: 7 }] }); // countStrippableCrawlerRows
    execute.mockResolvedValueOnce({
      rows: [{ isrc: "GBABC1200006", track_id: "spotifyF" }],
    }); // listIsrcWork

    const result = await resolveRecordingMbids(10, true);

    expect(result.dryRun).toBe(true);
    expect(result.prefixStripped).toBe(7);
    expect(result.resolved).toEqual(["spotifyF"]); // the eligible worklist, not a real resolve
    expect(mbFetch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2); // count + list, no writes
  });
});

// ── THE RETURN TRIP: the ISRC refresh (path d) ───────────────────────────────────────────────────
// MusicBrainz GAINS ISRCs over time and nothing re-read it, so ~9,895 benched rows sit ISRC-less
// while HOLDING the recording MBID that would answer — and an ISRC-less row is the one the anchor
// waterfall must resolve down its low-precision FUZZY rung.

/** A `/recording/<mbid>?inc=isrcs` hit. */
function mbIsrcs(...isrcs: string[]) {
  return { data: { isrcs }, rateLimited: false };
}

describe("resolveRecordingMbids — the ISRC refresh leg", () => {
  it("re-reads the stalest ISRC-less rows and fills the ISRC empty-only", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 }); // the prefix strip
    execute.mockResolvedValueOnce({ rows: [] }); // the ISRC drain — IDLE, so the refresh runs
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "mb_rec1" },
        { mb_recording_id: "rec-2", track_id: "mb_rec2" },
      ],
    });
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });

    mbFetch.mockResolvedValueOnce(mbIsrcs("GBAYE1234567")); // rec-1 gained one
    mbFetch.mockResolvedValueOnce(mbIsrcs()); // rec-2 still has none

    const result = await resolveRecordingMbids(10, false);

    expect(mbFetch).toHaveBeenCalledWith("/recording/rec-1?inc=isrcs");
    expect(mbFetch).toHaveBeenCalledWith("/recording/rec-2?inc=isrcs");
    expect(result.isrcRefreshed).toEqual(["mb_rec1"]);
    expect(result.isrcRefreshMissed).toEqual(["mb_rec2"]);

    // BOTH outcomes stamp `isrc_attempted_at` in the SAME statement that writes (or declines to
    // write) the ISRC — a look and its conclusion can never be written apart — and the write is
    // fill-empty-only, so a concurrent Deezer recovery can never be clobbered.
    const writes = execute.mock.calls
      .slice(3)
      .map((call) => call[0] as { args: unknown[]; sql: string })
      .filter((write) => write.sql.includes("update tracks"));
    expect(writes).toHaveLength(2);

    for (const write of writes) {
      expect(write.sql).toContain("set isrc = coalesce(isrc, ?)");
      expect(write.sql).toContain("isrc_attempted_at = ?");
    }

    expect(writes[0]?.args[0]).toBe("GBAYE1234567");
    // The MISS binds NULL, which coalesces to the NULL already there — only the stamp moves, so the
    // row sits out the refresh window instead of being re-asked every tick.
    expect(writes[1]?.args[0]).toBeNull();
  });

  it("asks for the STALEST first and never re-asks inside the refresh window", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [] });

    await resolveRecordingMbids(10, false);

    const worklist = execute.mock.calls[2]?.[0] as { args: unknown[]; sql: string };

    expect(worklist.sql).toContain("mb_recording_id is not null");
    expect(worklist.sql).toContain("(isrc is null or trim(isrc) = '')");
    // Oldest-looked-at first, with SQLite's NULL-sorts-smallest putting the never-looked rows at the
    // head — the round-robin that makes the queue self-draining without a cursor.
    expect(worklist.sql).toContain("order by isrc_attempted_at asc");
    // The window is a real 21-day cutoff, bound (never interpolated).
    const cutoff = Date.parse(String(worklist.args[0]));
    const days = (Date.now() - cutoff) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(20.9);
    expect(days).toBeLessThan(21.1);
  });

  it("does NOT run while the ISRC drain has work — the two legs never share a request's budget", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [{ isrc: "GBABC1200009", track_id: "spotifyZ" }] });
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(MB_MISS);

    const result = await resolveRecordingMbids(10, false);

    expect(result.isrcRefreshedCount).toBe(0);
    expect(result.isrcRefreshMissedCount).toBe(0);
    // Only the drain's own `/isrc/…` call — the refresh worklist was never even read.
    expect(mbFetch).toHaveBeenCalledTimes(1);
    expect(mbFetch).toHaveBeenCalledWith("/isrc/GBABC1200009");
  });

  it("does NOT run on a cursored continuation page (its stamps advance it, not a cursor)", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveRecordingMbids(10, false, "spotifyM");

    expect(result.isrcRefreshedCount).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("circuit-breaks on a MusicBrainz throttle mid-leg, stamping nothing for that row", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-a", track_id: "mb_a" },
        { mb_recording_id: "rec-b", track_id: "mb_b" },
      ],
    });
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });

    mbFetch.mockResolvedValueOnce(mbIsrcs("GBAYE7654321"));
    mbFetch.mockResolvedValueOnce(MB_THROTTLE);

    const result = await resolveRecordingMbids(10, false);

    expect(result.rateLimited).toBe(true);
    expect(result.isrcRefreshed).toEqual(["mb_a"]);
    // The throttled row was left untouched: one write, not two.
    const trackWrites = execute.mock.calls
      .slice(3)
      .map((call) => call[0] as { sql: string })
      .filter((write) => write.sql.includes("update tracks"));
    expect(trackWrites).toHaveLength(1);
  });

  it("a dry run reports the worklist it WOULD re-read, with no vendor call and no write", async () => {
    execute.mockResolvedValueOnce({ rows: [{ n: 0 }] }); // countStrippableCrawlerRows
    execute.mockResolvedValueOnce({ rows: [] }); // the ISRC drain worklist — idle
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-d", track_id: "mb_dry" }] });

    const result = await resolveRecordingMbids(10, true);

    expect(result.isrcRefreshed).toEqual(["mb_dry"]);
    expect(mbFetch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3); // count + drain list + refresh list, no writes
  });

  /** The `limit` bound into the refresh worklist read (the third statement of an idle pass). */
  function refreshWorklistLimit(): unknown {
    const call = execute.mock.calls[2]?.[0] as undefined | { args: unknown[] };

    return call?.args[1];
  }

  it("the caller's cap only ever NARROWS the module's own ceiling", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [] });

    await resolveRecordingMbids(10, false, undefined, 5);
    expect(refreshWorklistLimit()).toBe(5);

    execute.mockReset();
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [] });

    // 500 is clamped to the module's 25 — each re-read is a serialized ~1.1s MusicBrainz call inside
    // one Worker request, so the knob exists to spend LESS.
    await resolveRecordingMbids(10, false, undefined, 500);
    expect(refreshWorklistLimit()).toBe(25);
  });

  it("a cap of 0 SKIPS the leg entirely — a knob whose off position works", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValue({ rows: [] });

    const result = await resolveRecordingMbids(10, false, undefined, 0);

    // Not even the worklist read: strip + drain, and nothing else.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(mbFetch).not.toHaveBeenCalled();
    expect(result.isrcRefreshedCount).toBe(0);
  });
});

// The op's own cap parse, which deliberately is NOT the shared `parseLimit`: that one maps anything
// below 1 to its fallback, and here the fallback IS the maximum — so `?isrcRefreshLimit=0` would ask
// for the MOST re-reads instead of none, leaving the leg's off switch unreachable over the wire.
describe("parseIsrcRefreshLimit — the wire cap", () => {
  it("floors at 0, clamps at the ceiling, and never rejects", async () => {
    const { parseIsrcRefreshLimit } = await import("./orpc/admin-backfills");

    // THE ONE THAT MATTERS: 0 is "skip the leg", not "spend the maximum".
    expect(parseIsrcRefreshLimit("0")).toBe(0);
    expect(parseIsrcRefreshLimit("5")).toBe(5);
    expect(parseIsrcRefreshLimit("25")).toBe(25);
    // Above the module's ceiling narrows to it — the knob spends less, never more.
    expect(parseIsrcRefreshLimit("500")).toBe(25);
    // Tolerant like every other backfill param: absent or unreadable degrades, never a 400.
    expect(parseIsrcRefreshLimit(undefined)).toBe(25);
    expect(parseIsrcRefreshLimit("")).toBe(25);
    expect(parseIsrcRefreshLimit("abc")).toBe(25);
    expect(parseIsrcRefreshLimit("-3")).toBe(25);
  });
});

// THE ARITY GUARD. Every statement this module issues must bind exactly as many args as it
// declares placeholders; none of its SQL carries a literal '?', so the count is exact.
describe("every statement binds exactly its placeholders", () => {
  it("holds across a full wet pass (strip + worklist + resolved + missed writes)", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 2 });
    execute.mockResolvedValueOnce({
      rows: [
        { isrc: "GBABC1200001", track_id: "spotifyA" },
        { isrc: "GBABC1200002", track_id: "spotifyB" },
      ],
    });
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(mbHit("rec-uuid-A"));
    mbFetch.mockResolvedValueOnce(MB_MISS);

    await resolveRecordingMbids(10, false);

    for (const [call] of execute.mock.calls as Array<[{ args?: unknown[]; sql: string }]>) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;

      expect({
        args: (call.args ?? []).length,
        placeholders,
        sql: call.sql.slice(0, 60),
      }).toMatchObject({ args: placeholders, placeholders });
    }
  });
});

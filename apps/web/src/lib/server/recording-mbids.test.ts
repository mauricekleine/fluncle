import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recording-MBID fill sweep (the MusicBrainz identity layer): the FREE crawler PK strip, then
// the ISRC→recording resolve of findings/Spotify-born rows through the shared MusicBrainz client.
// The DB and the MB client are mocked, so a test never hits a real database or the network.

const execute = vi.fn();
const mbFetch = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./musicbrainz", async () => {
  const actual = await vi.importActual<typeof import("./musicbrainz")>("./musicbrainz");

  return { ...actual, mbFetch };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

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

// THE ARITY GUARD. The strip statement shipped with two placeholders and one bound arg — a
// mismatch the mocked db.execute could never surface (prod threw LibsqlError "expected 2, got
// 1" on every wet pass). Every statement this module issues must bind exactly as many args as
// it declares placeholders; none of its SQL carries a literal '?', so the count is exact.
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

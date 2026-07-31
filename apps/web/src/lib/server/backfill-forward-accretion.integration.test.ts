import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE FORWARD-ACCRETION LEGS, PROVEN against the REAL schema.
//
// Both legs are worklist-and-ledger machines: what they read is SQL over `tracks` (an anti-join
// onto the certification, a capture-priority ladder, four ledger columns), and what they write is
// the ledger itself. Neither can be proven by a unit test with a fake db — the whole risk lives in
// the predicates and the write statements, so a real engine is the only witness. The vendor reads
// are mocked; the worklists, the ledger law, and the spend bounds are what is on trial.
//
// The ledger law under test (schema.ts § `backfill_deezer_*`): stamp ONLY an outcome that settles
// whether the platform carries the recording. A found-but-unvouchable pick, a throttle, and a
// transport failure each settle nothing, and each must leave a different, deliberate trace.

let db: Client;

const lookupDeezerTrackByIsrc = vi.fn();
const resolveBeatportUrl = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});
vi.mock("./deezer", async (importOriginal) => {
  // Partial mock: only the network-touching lookup is stubbed, so the pure helpers beside it stay
  // real and a whole-module mock cannot silently hide a new one.
  const actual = await importOriginal<typeof import("./deezer")>();

  return {
    ...actual,
    lookupDeezerTrackByIsrc: (...a: unknown[]) => lookupDeezerTrackByIsrc(...a),
  };
});
vi.mock("./beatport-resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./beatport-resolve")>();

  return { ...actual, resolveBeatportUrl: (...a: unknown[]) => resolveBeatportUrl(...a) };
});

/** Stamp a row's ISRC (and optionally its Ear rank), the two things both worklists read by. */
async function withIsrc(trackId: string, isrc: string, capturePriority?: number): Promise<void> {
  await db.execute({
    args: [isrc, capturePriority ?? null, trackId],
    sql: `update tracks set isrc = ?, capture_priority = ? where track_id = ?`,
  });
}

/** Read one track row. */
async function readTrack(trackId: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({
    args: [trackId],
    sql: `select * from tracks where track_id = ?`,
  });

  return result.rows[0] as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("backfillDeezer — the worklist", () => {
  it("resolves a catalogue row: the id, its provenance, and the ledger in one write", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000001" });
    await withIsrc("cat00000000000000000001", "ISRC001");
    lookupDeezerTrackByIsrc.mockResolvedValueOnce({
      deezerTrackId: "3263968181",
      outcome: "matched",
    });

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.resolved).toEqual([
      { trackId: "cat00000000000000000001", url: "https://www.deezer.com/track/3263968181" },
    ]);

    const track = await readTrack("cat00000000000000000001");
    expect(track?.deezer_track_id).toBe("3263968181");
    // The provenance is the narrow one the schema defines for this endpoint, not a guess.
    expect(track?.deezer_verified_by).toBe("isrc");
    expect(track?.deezer_verified_at).toBeTruthy();
    expect(track?.backfill_deezer_done_at).toBeTruthy();
    expect(track?.backfill_deezer_attempted_at).toBeTruthy();
    expect(Number(track?.backfill_deezer_attempts)).toBe(1);
    // The moment the link was won and the moment the ledger says it resolved cannot drift.
    expect(track?.backfill_deezer_done_at).toBe(track?.deezer_verified_at);
  });

  it("drains CERTIFIED rows before catalogue ones", async () => {
    // The order is the budget: a finding is what Fluncle actually speaks about, so it resolves
    // first on a tick that cannot fit everything.
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000002" });
    await withIsrc("cat00000000000000000002", "ISRCCAT", 900);
    await seedTrack(db, {
      addedToSpotify: true,
      logId: "LOG-1",
      postedToTelegram: true,
      trackId: "finding0000000000000001",
    });
    await withIsrc("finding0000000000000001", "ISRCFIND");

    lookupDeezerTrackByIsrc.mockResolvedValue({ outcome: "absent" });

    const { backfillDeezer } = await import("./backfill");
    await backfillDeezer(1, false);

    // Exactly one row was asked about this pass, and it was the certified one — even though the
    // catalogue row carries a high Ear rank.
    expect(lookupDeezerTrackByIsrc).toHaveBeenCalledTimes(1);
    expect(lookupDeezerTrackByIsrc).toHaveBeenCalledWith("ISRCFIND", 270_000);
  });

  it("orders the catalogue tier by the Ear's capture-priority ladder", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000003" });
    await withIsrc("cat00000000000000000003", "ISRC-LOW", 1);
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000004" });
    await withIsrc("cat00000000000000000004", "ISRC-HIGH", 999);

    lookupDeezerTrackByIsrc.mockResolvedValue({ outcome: "absent" });

    const { backfillDeezer } = await import("./backfill");
    await backfillDeezer(1, false);

    expect(lookupDeezerTrackByIsrc).toHaveBeenCalledTimes(1);
    expect(lookupDeezerTrackByIsrc).toHaveBeenCalledWith("ISRC-HIGH", 270_000);
  });

  it("excludes a row that already holds an id, and one already concluded", async () => {
    // The second half is what keeps the operator's completed campaign from being re-spent: a
    // stamped row is out of the worklist for good, because no re-check cadence is ruled.
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000005" });
    await withIsrc("cat00000000000000000005", "ISRC005");
    await db.execute({
      args: ["cat00000000000000000005"],
      sql: `update tracks set deezer_track_id = 'already' where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "cat00000000000000000006" });
    await withIsrc("cat00000000000000000006", "ISRC006");
    await db.execute({
      args: ["2026-01-01T00:00:00.000Z", "cat00000000000000000006"],
      sql: `update tracks set backfill_deezer_attempted_at = ? where track_id = ?`,
    });

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.resolvedCount).toBe(0);
    expect(lookupDeezerTrackByIsrc).not.toHaveBeenCalled();
  });

  it("excludes a row with no ISRC and one with no duration to vouch with", async () => {
    // A duration-less row could only ever come back `unvouchable`, which stamps nothing — so
    // without this predicate it would sit in the worklist being re-asked forever.
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000007" });
    await seedCatalogueTrack(db, { durationMs: 0, trackId: "cat00000000000000000008" });
    await withIsrc("cat00000000000000000008", "ISRC008");

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.resolvedCount).toBe(0);
    expect(lookupDeezerTrackByIsrc).not.toHaveBeenCalled();
  });

  it("dry-run previews the eligible set without a call or a write", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000009" });
    await withIsrc("cat00000000000000000009", "ISRC009");

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, true);

    expect(result.dryRun).toBe(true);
    expect(result.unresolved).toEqual(["cat00000000000000000009"]);
    expect(lookupDeezerTrackByIsrc).not.toHaveBeenCalled();
    expect((await readTrack("cat00000000000000000009"))?.backfill_deezer_attempted_at).toBeNull();
  });
});

describe("backfillDeezer — the ledger law", () => {
  it("an ABSENT answer stamps the honest miss: attempted, counted, NOT done", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000010" });
    await withIsrc("cat00000000000000000010", "ISRC010");
    lookupDeezerTrackByIsrc.mockResolvedValueOnce({ outcome: "absent" });

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.unresolved).toEqual(["cat00000000000000000010"]);

    const track = await readTrack("cat00000000000000000010");
    expect(track?.backfill_deezer_attempted_at).toBeTruthy();
    expect(Number(track?.backfill_deezer_attempts)).toBe(1);
    expect(track?.backfill_deezer_done_at).toBeNull();
    expect(track?.deezer_track_id).toBeNull();
    // A clean conclusion resets the streak — it is not the transport failure a streak backs off from.
    expect(Number(track?.backfill_deezer_failures)).toBe(0);
  });

  it("an UNVOUCHABLE pick stamps NOTHING AT ALL — neither a hit nor a miss", async () => {
    // Deezer demonstrably carries something here, so "not found" would misstate it; the pick
    // cannot be trusted, so an id would be a wrong public link. Neither state fits, none is claimed.
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000011" });
    await withIsrc("cat00000000000000000011", "ISRC011");
    lookupDeezerTrackByIsrc.mockResolvedValueOnce({ outcome: "unvouchable" });

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.unvouchable).toEqual(["cat00000000000000000011"]);

    const track = await readTrack("cat00000000000000000011");
    expect(track?.backfill_deezer_attempted_at).toBeNull();
    expect(Number(track?.backfill_deezer_attempts)).toBe(0);
    expect(Number(track?.backfill_deezer_failures)).toBe(0);
    expect(track?.deezer_track_id).toBeNull();
  });

  it("a QUOTA answer ends the pass and stamps nothing, on this row or any later one", async () => {
    // The known ledger poison: the throttle arrives in an HTTP-200 body, and stamping it would
    // mark a whole tick's rows "not on Deezer" because a neighbour on the shared IP burst.
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000012" });
    await withIsrc("cat00000000000000000012", "ISRC012", 500);
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000013" });
    await withIsrc("cat00000000000000000013", "ISRC013", 400);

    lookupDeezerTrackByIsrc.mockResolvedValueOnce({ outcome: "quota" });

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.rateLimited).toBe(true);
    // The pass stopped on the FIRST row rather than marching the second into the same wall.
    expect(lookupDeezerTrackByIsrc).toHaveBeenCalledTimes(1);

    for (const trackId of ["cat00000000000000000012", "cat00000000000000000013"]) {
      const track = await readTrack(trackId);
      expect(track?.backfill_deezer_attempted_at).toBeNull();
      expect(Number(track?.backfill_deezer_attempts)).toBe(0);
      expect(Number(track?.backfill_deezer_failures)).toBe(0);
    }
  });

  it("a transport FAILURE bumps only the streak — never attempted_at, so the row stays eligible", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000014" });
    await withIsrc("cat00000000000000000014", "ISRC014");
    lookupDeezerTrackByIsrc.mockResolvedValue({ error: "socket closed", outcome: "failed" });

    const { backfillDeezer } = await import("./backfill");
    const first = await backfillDeezer(50, false);

    expect(first.failed).toEqual([{ error: "socket closed", trackId: "cat00000000000000000014" }]);

    const track = await readTrack("cat00000000000000000014");
    expect(Number(track?.backfill_deezer_failures)).toBe(1);
    // Stamping attempted_at here would make /identity read "Not found · checked <date>" off a
    // timeout — a conclusion nobody reached.
    expect(track?.backfill_deezer_attempted_at).toBeNull();

    // Still eligible: a later tick picks it straight back up.
    const second = await backfillDeezer(50, false);
    expect(second.failedCount).toBe(1);
    expect(Number((await readTrack("cat00000000000000000014"))?.backfill_deezer_failures)).toBe(2);
  });

  it("a row past the failure cap drops out of the worklist rather than burning the budget", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000015" });
    await withIsrc("cat00000000000000000015", "ISRC015");
    await db.execute({
      args: ["cat00000000000000000015"],
      sql: `update tracks set backfill_deezer_failures = 3 where track_id = ?`,
    });

    const { backfillDeezer } = await import("./backfill");
    const result = await backfillDeezer(50, false);

    expect(result.failedCount).toBe(0);
    expect(lookupDeezerTrackByIsrc).not.toHaveBeenCalled();
  });

  it("FIRST WRITE WINS: an id and provenance already on the row are never relabelled", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000016" });
    await withIsrc("cat00000000000000000016", "ISRC016");
    // A row that somehow holds provenance without an id (defensive: the trio moves together, so
    // this cannot happen through a write path — which is exactly why the guard must be in SQL).
    await db.execute({
      args: ["cat00000000000000000016"],
      sql: `update tracks set deezer_verified_by = 'search' where track_id = ?`,
    });
    lookupDeezerTrackByIsrc.mockResolvedValueOnce({ deezerTrackId: "999", outcome: "matched" });

    const { backfillDeezer } = await import("./backfill");
    await backfillDeezer(50, false);

    const track = await readTrack("cat00000000000000000016");
    expect(track?.deezer_track_id).toBe("999");
    // The earlier answer stands: a row can never wear an id with someone else's provenance.
    expect(track?.deezer_verified_by).toBe("search");
  });

  it("writes no findings lastmod — a link on an existing recording moves no finding", async () => {
    await seedTrack(db, {
      addedToSpotify: true,
      logId: "LOG-LASTMOD",
      postedToTelegram: true,
      trackId: "finding0000000000000002",
    });
    await withIsrc("finding0000000000000002", "ISRCLM");
    const before = await db.execute({
      args: ["finding0000000000000002"],
      sql: `select updated_at from findings where track_id = ?`,
    });
    lookupDeezerTrackByIsrc.mockResolvedValueOnce({ deezerTrackId: "555", outcome: "matched" });

    const { backfillDeezer } = await import("./backfill");
    await backfillDeezer(50, false);

    const after = await db.execute({
      args: ["finding0000000000000002"],
      sql: `select updated_at from findings where track_id = ?`,
    });
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
    expect((await readTrack("finding0000000000000002"))?.deezer_track_id).toBe("555");
  });
});

describe("backfillBeatportUrls — the catalogue tier", () => {
  it("resolves an uncertified row and writes the URL + the done ledger", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000020" });
    await withIsrc("cat00000000000000000020", "ISRC020");
    resolveBeatportUrl.mockResolvedValueOnce({
      configured: true,
      ok: true,
      url: "https://www.beatport.com/track/x/1",
    });

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, false);

    expect(result.catalogueResolved).toEqual([
      { trackId: "cat00000000000000000020", url: "https://www.beatport.com/track/x/1" },
    ]);

    const track = await readTrack("cat00000000000000000020");
    expect(track?.beatport_url).toBe("https://www.beatport.com/track/x/1");
    expect(track?.beatport_verified_at).toBeTruthy();
    expect(track?.backfill_beatport_done_at).toBeTruthy();
  });

  it("NEVER re-spends on a campaign-concluded row, even long past the cooldown", async () => {
    // The certified tier gates on `shouldSkip`, whose base cooldown is 24h — survivable across ~85
    // findings, ruinous across a five-figure catalogue where each retry is a Firecrawl credit. So
    // this tier asks ONCE: a row that has ever concluded is out for good.
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000021" });
    await withIsrc("cat00000000000000000021", "ISRC021");
    await db.execute({
      // A concluded no-match from the operator's campaign: attempted, counted, streak clean.
      args: ["2020-01-01T00:00:00.000Z", "cat00000000000000000021"],
      sql: `update tracks
            set backfill_beatport_attempted_at = ?, backfill_beatport_failures = 0
            where track_id = ?`,
    });

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, false);

    expect(result.catalogueResolvedCount).toBe(0);
    expect(result.catalogueUnresolvedCount).toBe(0);
    expect(resolveBeatportUrl).not.toHaveBeenCalled();
  });

  it("DOES re-admit a row whose scrape only ever FAILED — nothing was concluded there", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000022" });
    await withIsrc("cat00000000000000000022", "ISRC022");
    await db.execute({
      args: ["2020-01-01T00:00:00.000Z", "cat00000000000000000022"],
      sql: `update tracks
            set backfill_beatport_attempted_at = ?, backfill_beatport_failures = 1
            where track_id = ?`,
    });
    resolveBeatportUrl.mockResolvedValueOnce({ configured: true, ok: true, url: null });

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, false);

    expect(result.catalogueUnresolved).toEqual(["cat00000000000000000022"]);
  });

  it("excludes a certified row from the catalogue tier (that is the findings tier's job)", async () => {
    await seedTrack(db, {
      addedToSpotify: true,
      logId: "LOG-BP",
      postedToTelegram: true,
      trackId: "finding0000000000000003",
    });
    await withIsrc("finding0000000000000003", "ISRCBP");
    // The findings tier would normally scrape it; make it unconfigured so only the tier boundary
    // is on trial here, then assert the catalogue tier reported nothing for it.
    resolveBeatportUrl.mockResolvedValue({ configured: false, ok: false });

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, false);

    expect(result.catalogueResolvedCount).toBe(0);
    expect(result.catalogueUnresolvedCount).toBe(0);
    expect(result.catalogueFailedCount).toBe(0);
  });

  it("honours the operator's sub-cap, and treats 0 as a kill switch", async () => {
    for (const suffix of ["30", "31", "32"]) {
      await seedCatalogueTrack(db, { trackId: `cat000000000000000000${suffix}` });
      await withIsrc(`cat000000000000000000${suffix}`, `ISRC${suffix}`);
    }
    resolveBeatportUrl.mockResolvedValue({ configured: true, ok: true, url: null });

    vi.stubEnv("FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT", "2");
    const { backfillBeatportUrls } = await import("./backfill");
    const capped = await backfillBeatportUrls(10, false);
    expect(capped.catalogueUnresolvedCount).toBe(2);

    vi.clearAllMocks();
    resolveBeatportUrl.mockResolvedValue({ configured: true, ok: true, url: null });
    vi.stubEnv("FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT", "0");
    const off = await backfillBeatportUrls(10, false);
    expect(off.catalogueUnresolvedCount).toBe(0);
    expect(resolveBeatportUrl).not.toHaveBeenCalled();
  });

  it("falls back to the small default when the cap is a typo — a mistake never widens spend", async () => {
    for (const suffix of ["40", "41", "42", "43", "44", "45"]) {
      await seedCatalogueTrack(db, { trackId: `cat000000000000000000${suffix}` });
      await withIsrc(`cat000000000000000000${suffix}`, `ISRC${suffix}`);
    }
    resolveBeatportUrl.mockResolvedValue({ configured: true, ok: true, url: null });
    vi.stubEnv("FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT", "lots please");

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, false);

    // The in-code default, not "unbounded" and not "zero".
    expect(result.catalogueUnresolvedCount).toBe(5);
  });

  it("does NOT run while the certified feed still has a pass left — the spend bound", async () => {
    // Two guarantees in one: certified rows genuinely come first, and the sub-cap means what it
    // says. The CLI LOOPS this endpoint until the feed drains, so a catalogue drain on every pass
    // would silently multiply the operator's cap by the number of passes a tick happens to take.
    // Only the pass that exhausts the feed (nextCursor null) may spend on the catalogue.
    for (const suffix of ["1", "2", "3", "4"]) {
      await seedTrack(db, {
        addedToSpotify: true,
        logId: `LOG-BUSY-${suffix}`,
        postedToTelegram: true,
        trackId: `findingbusy00000000000${suffix}`,
      });
      await withIsrc(`findingbusy00000000000${suffix}`, `ISRCBUSY${suffix}`);
    }
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000060" });
    await withIsrc("cat00000000000000000060", "ISRC060");

    resolveBeatportUrl.mockResolvedValue({
      configured: true,
      ok: true,
      url: "https://www.beatport.com/track/x/9",
    });

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, false);

    // The pass filled its certified budget and handed back a cursor, so the catalogue waits.
    expect(result.nextCursor).not.toBeNull();
    expect(result.resolvedCount).toBeGreaterThan(0);
    expect(result.catalogueResolvedCount).toBe(0);
    expect((await readTrack("cat00000000000000000060"))?.beatport_url).toBeNull();
  });

  it("dry-run previews the catalogue tier without a scrape or a write", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000050" });
    await withIsrc("cat00000000000000000050", "ISRC050");

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(10, true);

    expect(result.catalogueUnresolved).toEqual(["cat00000000000000000050"]);
    expect(resolveBeatportUrl).not.toHaveBeenCalled();
    expect((await readTrack("cat00000000000000000050"))?.beatport_url).toBeNull();
  });
});

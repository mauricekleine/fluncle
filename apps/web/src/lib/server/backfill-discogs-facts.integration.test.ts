import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedAlbum, seedTrack } from "./integration-db";

// THE DISCOGS RELEASE-FACTS DRAIN, proven against the REAL generated schema on a real libSQL
// engine. The claims on trial are the ones only a real engine can settle, because every one of
// them is a property of the SQL rather than of the TypeScript around it:
//
//   - the worklist joins `tracks.in_release_id` to its album and GROUPS BY album, so ten findings
//     off one record cost ONE release lookup rather than ten;
//   - `discogs_state = 'pending'` is the drain gate, so a ruled album (either way) leaves the
//     worklist for good and a re-run is a genuine no-op;
//   - a release that carries a number resolves the album; one that carries none is TERMINAL;
//   - a failed lookup advances the streak and leaves the album `pending` — nothing was concluded;
//   - a THROTTLE stamps nothing at all, so every album stays eligible for the next tick.
//
// The vendor client is mocked (this proves the sweep's SQL, not Discogs' HTTP), the database is
// real, and the DDL is the migration chain's own.

let db: Client;

const fetchDiscogsReleaseFacts = vi.fn();
const readOptionalEnv = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./discogs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discogs")>();

  return {
    ...actual,
    fetchDiscogsReleaseFacts: (...args: unknown[]) => fetchDiscogsReleaseFacts(...args),
  };
});

vi.mock("./env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env")>();

  return { ...actual, readOptionalEnv: (...args: unknown[]) => readOptionalEnv(...args) };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { backfillDiscogsFacts } = await import("./backfill");

/** Point a seeded track at an album and give it the Discogs release id the worklist starts from. */
async function linkTrack(
  client: Client,
  trackId: string,
  albumId: string,
  releaseId: null | number,
): Promise<void> {
  await client.execute({
    args: [albumId, releaseId, trackId],
    sql: `update tracks set album_id = ?, in_release_id = ? where track_id = ?`,
  });
}

/** The album's Discogs ledger + facts, as the page and the next pass will read them. */
async function albumFacts(
  client: Client,
  id: string,
): Promise<{
  attempted_at: null | string;
  discogs_catno: null | string;
  discogs_failures: number;
  discogs_state: string;
  discogs_styles: null | string;
}> {
  const result = await client.execute({
    args: [id],
    sql: `select discogs_catno, discogs_styles, discogs_state, discogs_failures,
                 discogs_attempted_at as attempted_at
          from albums where id = ?`,
  });

  return result.rows[0] as unknown as {
    attempted_at: null | string;
    discogs_catno: null | string;
    discogs_failures: number;
    discogs_state: string;
    discogs_styles: null | string;
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  fetchDiscogsReleaseFacts.mockReset();
  readOptionalEnv.mockReset();
  readOptionalEnv.mockResolvedValue("test-token");
});

describe("backfillDiscogsFacts (integration)", () => {
  it("prepares box work without a Discogs call or ledger write", async () => {
    await seedAlbum(db, { id: "alb-box", name: "Box", slug: "box" });
    await seedTrack(db, { logId: "241.7.box", trackId: "t-box" });
    await linkTrack(db, "t-box", "alb-box", 77);

    const result = await backfillDiscogsFacts(10, false, { boxFetch: true });

    expect(result.discogsWork).toEqual([{ releaseId: 77, slug: "box" }]);
    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
    expect((await albumFacts(db, "alb-box")).discogs_state).toBe("pending");
    expect((await albumFacts(db, "alb-box")).attempted_at).toBeNull();
  });

  it("accepts box facts only when the release id still matches the DB row", async () => {
    await seedAlbum(db, { id: "alb-box", name: "Box", slug: "box" });
    await seedTrack(db, { logId: "241.7.box", trackId: "t-box" });
    await linkTrack(db, "t-box", "alb-box", 77);

    const mismatch = await backfillDiscogsFacts(10, false, {
      boxFetch: true,
      discogsCandidates: [
        {
          release: {
            artists: [],
            formats: [],
            id: 78,
            labels: [{ catno: "WRONG" }],
            styles: [],
            tracklist: [],
          },
          slug: "box",
        },
      ],
    });

    expect(mismatch.failedCount).toBe(1);
    expect((await albumFacts(db, "alb-box")).discogs_state).toBe("pending");
    expect((await albumFacts(db, "alb-box")).attempted_at).toBeNull();

    const resolved = await backfillDiscogsFacts(10, false, {
      boxFetch: true,
      discogsCandidates: [
        {
          release: {
            artists: [],
            formats: [],
            id: 77,
            labels: [{ catno: "BOX001" }],
            styles: ["Drum n Bass"],
            tracklist: [],
          },
          slug: "box",
        },
      ],
    });

    expect(resolved.resolved).toEqual([{ catno: "BOX001", slug: "box" }]);
    expect((await albumFacts(db, "alb-box")).discogs_catno).toBe("BOX001");
    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
  });

  it("buys ONE lookup per record, stores the number, and drains on the next pass", async () => {
    await seedAlbum(db, { id: "alb-ram", name: "Gate EP", slug: "gate-ep" });
    // Three findings off the SAME record, each with its own resolved Discogs release id. A
    // per-track worklist would spend three lookups on one catalogue number.
    for (const trackId of ["t1", "t2", "t3"]) {
      await seedTrack(db, { logId: `241.7.${trackId}`, trackId });
      await linkTrack(db, trackId, "alb-ram", 6414598);
    }

    fetchDiscogsReleaseFacts.mockResolvedValue({
      facts: { catno: "RAMM123", styles: ["Drum n Bass", "Neurofunk"] },
      found: true,
      rateLimited: false,
    });

    const first = await backfillDiscogsFacts(10, false);

    expect(fetchDiscogsReleaseFacts, "one record, one lookup").toHaveBeenCalledTimes(1);
    expect(first.resolved).toEqual([{ catno: "RAMM123", slug: "gate-ep" }]);
    expect(first.noneCount).toBe(0);
    expect(first.failedCount).toBe(0);

    const stored = await albumFacts(db, "alb-ram");

    expect(stored.discogs_catno).toBe("RAMM123");
    expect(JSON.parse(stored.discogs_styles ?? "null")).toEqual(["Drum n Bass", "Neurofunk"]);
    expect(stored.discogs_state).toBe("resolved");

    // THE DRAIN. A ruled album is out of the worklist, so the next tick is a free no-op.
    fetchDiscogsReleaseFacts.mockClear();

    const second = await backfillDiscogsFacts(10, false);

    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
    expect(second.resolvedCount + second.noneCount + second.failedCount).toBe(0);
  });

  it("rules a release with no number TERMINAL, so its lookup is never bought twice", async () => {
    await seedAlbum(db, { id: "alb-white", name: "White Label", slug: "white-label" });
    await seedTrack(db, { logId: "241.7.4", trackId: "t4" });
    await linkTrack(db, "t4", "alb-white", 999);

    // The release answered, and the honest answer is "there is no catalogue number".
    fetchDiscogsReleaseFacts.mockResolvedValue({
      facts: { styles: ["Jungle"] },
      found: true,
      rateLimited: false,
    });

    const first = await backfillDiscogsFacts(10, false);

    expect(first.none).toEqual(["white-label"]);
    expect(first.resolvedCount).toBe(0);

    const stored = await albumFacts(db, "alb-white");

    expect(stored.discogs_state, "terminal — a pressing does not grow a number later").toBe("none");
    expect(stored.discogs_catno).toBeNull();
    // The styles still land: a release can list them and carry no number.
    expect(JSON.parse(stored.discogs_styles ?? "null")).toEqual(["Jungle"]);

    fetchDiscogsReleaseFacts.mockClear();
    await backfillDiscogsFacts(10, false);
    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
  });

  it("counts a failed lookup as a FAILURE and leaves the album pending for a later tick", async () => {
    await seedAlbum(db, { id: "alb-gone", name: "Gone", slug: "gone" });
    await seedTrack(db, { logId: "241.7.5", trackId: "t5" });
    await linkTrack(db, "t5", "alb-gone", 1234);

    fetchDiscogsReleaseFacts.mockResolvedValue({ found: false, rateLimited: false });

    const result = await backfillDiscogsFacts(10, false);

    expect(result.failedCount).toBe(1);
    expect(result.failed[0]?.slug).toBe("gone");

    const stored = await albumFacts(db, "alb-gone");

    expect(stored.discogs_state, "nothing was concluded — it stays in the worklist").toBe(
      "pending",
    );
    expect(stored.discogs_failures, "the streak scales the cooldown").toBe(1);
    expect(stored.attempted_at).not.toBeNull();
  });

  it("stamps NOTHING on a throttle and stops the pass — the batch stays eligible", async () => {
    const records = [
      { albumId: "alb-a", slug: "record-a", trackId: "ta" },
      { albumId: "alb-b", slug: "record-b", trackId: "tb" },
    ];

    for (const { albumId, slug, trackId } of records) {
      await seedAlbum(db, { id: albumId, name: slug, slug });
      await seedTrack(db, { logId: `241.7.${trackId}`, trackId });
      await linkTrack(db, trackId, albumId, 555);
    }

    fetchDiscogsReleaseFacts.mockResolvedValue({ found: false, rateLimited: true });

    const result = await backfillDiscogsFacts(10, false);

    expect(result.rateLimited).toBe(true);
    expect(fetchDiscogsReleaseFacts, "the pass stops on the FIRST throttle").toHaveBeenCalledTimes(
      1,
    );
    expect(result.resolvedCount + result.noneCount + result.failedCount).toBe(0);

    // A budget-blocked album is not an answered one: nothing is stamped, so the next tick's fresh
    // window sees both records exactly as it would have before.
    for (const albumId of ["alb-a", "alb-b"]) {
      const stored = await albumFacts(db, albumId);

      expect(stored.discogs_state).toBe("pending");
      expect(stored.discogs_failures).toBe(0);
      expect(stored.attempted_at).toBeNull();
    }
  });

  it("ignores an album no Discogs-resolved track points at", async () => {
    await seedAlbum(db, { id: "alb-unresolved", name: "Unresolved", slug: "unresolved" });
    await seedTrack(db, { logId: "241.7.6", trackId: "t6" });
    // Linked to the album, but the Discogs sweep never resolved a release for it.
    await linkTrack(db, "t6", "alb-unresolved", null);

    const result = await backfillDiscogsFacts(10, false);

    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
    expect(result.resolvedCount + result.noneCount + result.failedCount).toBe(0);
  });

  it("previews the eligible records on a dry run without a vendor call or a stamp", async () => {
    await seedAlbum(db, { id: "alb-dry", name: "Dry", slug: "dry" });
    await seedTrack(db, { logId: "241.7.7", trackId: "t7" });
    await linkTrack(db, "t7", "alb-dry", 42);

    const result = await backfillDiscogsFacts(10, true);

    expect(result.dryRun).toBe(true);
    expect(result.configured, "the preview reports the REAL arming state").toBe(true);
    expect(result.none).toEqual(["dry"]);
    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
    expect((await albumFacts(db, "alb-dry")).discogs_state).toBe("pending");
  });

  it("reports UNCONFIGURED on a dry run too, rather than previewing an armed sweep", async () => {
    // A preview that says "configured" on a Worker with no token tells the operator the sweep is
    // armed when the next live tick will do nothing. The worklist preview is still useful, so it
    // still runs — only the flag has to be honest.
    readOptionalEnv.mockResolvedValue(undefined);
    await seedAlbum(db, { id: "alb-dry-inert", name: "Dry Inert", slug: "dry-inert" });
    await seedTrack(db, { logId: "241.7.9", trackId: "t9" });
    await linkTrack(db, "t9", "alb-dry-inert", 88);

    const result = await backfillDiscogsFacts(10, true);

    expect(result.configured).toBe(false);
    expect(result.none).toEqual(["dry-inert"]);
    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();
  });

  it("is a NO-OP without the Discogs token, stamping nothing", async () => {
    readOptionalEnv.mockResolvedValue(undefined);
    await seedAlbum(db, { id: "alb-inert", name: "Inert", slug: "inert" });
    await seedTrack(db, { logId: "241.7.8", trackId: "t8" });
    await linkTrack(db, "t8", "alb-inert", 77);

    const result = await backfillDiscogsFacts(10, false);

    expect(result.configured).toBe(false);
    expect(fetchDiscogsReleaseFacts).not.toHaveBeenCalled();

    const stored = await albumFacts(db, "alb-inert");

    expect(stored.discogs_state).toBe("pending");
    expect(stored.attempted_at, "an attempt nobody made must not be recorded").toBeNull();
  });
});

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { typedRows } from "./db";
import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "./integration-db";

// THE MAINTAINED HUB COUNTS, PROVEN AT EVERY WRITE PATH (docs/db-scale-backlog Wave 2 keystone 2).
//
// `renderable_track_count` / `certified_finding_count` on labels/albums/artists are maintained as
// DELTAS by the link, certify and merge paths — never recomputed, because recompute-from-truth
// measured 27,400 ms at 150k hosted against ~200 ms for the delta form. A maintained counter's
// failure mode is SILENT, so every family gets a case here, driven against the REAL migrated schema
// (the in-memory libSQL harness) so the SQL under test is byte-identical to production's.
//
// What is deliberately NOT covered, because it is not in the semantics: dismiss/duplicate-mark
// (`renderable` counts TOTAL linked tracks, so a flag moves nothing) and track deletion (no
// server-side path exists; the out-of-band prune + the future reconciliation sweep own that drift).

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so each module's `getDb` is the mocked one.
const { linkTrackToLabel, mergeLabel } = await import("./labels");
const { linkTrackToAlbum } = await import("./albums");
const { linkTracksToArtistEntities, upsertTrackArtists } = await import("./artists");
const { hubCountMoveStatements, hubCountArtistEdgeStatements } = await import("./hub-counts");

type Counts = { certified: number; renderable: number };

async function counts(table: "albums" | "artists" | "labels", id: string): Promise<Counts> {
  const result = await db.execute({
    args: [id],
    sql: `select renderable_track_count as renderable, certified_finding_count as certified
          from ${table} where id = ?`,
  });
  const row = result.rows[0];

  return { certified: Number(row?.certified ?? -1), renderable: Number(row?.renderable ?? -1) };
}

/** The single `id` a one-row lookup returned. */
async function idFrom(sql: string): Promise<string> {
  const result = await db.execute(sql);

  return typedRows<{ id: string }>(result.rows)[0]?.id ?? "";
}

/** Point a track at an entity WITHOUT the delta, to fabricate a pre-existing edge. */
async function rawLink(
  column: "album_id" | "label_id",
  entityId: string,
  trackId: string,
): Promise<void> {
  await db.execute({
    args: [entityId, trackId],
    sql: `update tracks set ${column} = ? where track_id = ?`,
  });
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-hub-counts-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("linkTrackToLabel / linkTrackToAlbum — the per-track link", () => {
  it("credits the label for a CERTIFIED track: renderable and certified both move", async () => {
    await seedLabel(db, { id: "lab-hospital", name: "Hospital Records", slug: "hospital-records" });
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });

    await linkTrackToLabel("t-cert-0000000000000a", "Hospital Records");

    expect(await counts("labels", "lab-hospital")).toEqual({ certified: 1, renderable: 1 });
  });

  it("credits the label for a CATALOGUE track: renderable moves, certified does not", async () => {
    await seedLabel(db, { id: "lab-hospital", name: "Hospital Records", slug: "hospital-records" });
    await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });

    await linkTrackToLabel("t-cat-00000000000000a", "Hospital Records");

    expect(await counts("labels", "lab-hospital")).toEqual({ certified: 0, renderable: 1 });
  });

  it("RE-POINTS a track: the source label is debited and the destination credited", async () => {
    await seedLabel(db, { id: "lab-old", name: "Old Imprint", slug: "old-imprint" });
    await seedLabel(db, { id: "lab-new", name: "New Imprint", slug: "new-imprint" });
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });

    await linkTrackToLabel("t-cert-0000000000000a", "Old Imprint");
    expect(await counts("labels", "lab-old")).toEqual({ certified: 1, renderable: 1 });

    await linkTrackToLabel("t-cert-0000000000000a", "New Imprint");

    expect(await counts("labels", "lab-old")).toEqual({ certified: 0, renderable: 0 });
    expect(await counts("labels", "lab-new")).toEqual({ certified: 1, renderable: 1 });
  });

  it("is idempotent — re-linking to the SAME label counts nothing twice", async () => {
    await seedLabel(db, { id: "lab-hospital", name: "Hospital Records", slug: "hospital-records" });
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });

    await linkTrackToLabel("t-cert-0000000000000a", "Hospital Records");
    await linkTrackToLabel("t-cert-0000000000000a", "Hospital Records");

    expect(await counts("labels", "lab-hospital")).toEqual({ certified: 1, renderable: 1 });
  });

  it("the album twin behaves identically", async () => {
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });

    await linkTrackToAlbum("t-cert-0000000000000a", "Sight To Behold");

    const albumId = await idFrom(`select id from albums where slug = 'sight-to-behold'`);
    expect(await counts("albums", albumId)).toEqual({ certified: 1, renderable: 1 });
  });
});

describe("relinkTracksToEntity — the bulk link", () => {
  it("moves a MIXED batch: some tracks unlinked, some on another label, some already here", async () => {
    await seedLabel(db, { id: "lab-old", name: "Old Imprint", slug: "old-imprint" });
    await seedLabel(db, { id: "lab-new", name: "New Imprint", slug: "new-imprint" });
    // Two certified + two catalogue tracks, spread across the three starting states.
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" }); // unlinked
    await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" }); // unlinked
    await seedTrack(db, { logId: "004.7.2B", trackId: "t-cert-0000000000000b" }); // on lab-old
    await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000b" }); // already on lab-new

    await rawLink("label_id", "lab-old", "t-cert-0000000000000b");
    await rawLink("label_id", "lab-new", "t-cat-00000000000000b");
    // Seed lab-old's counters to what the (raw) link above should have left them at.
    await db.execute(
      `update labels set renderable_track_count = 1, certified_finding_count = 1 where id = 'lab-old'`,
    );

    const { relinkTracksToEntity } = await import("./hub-counts");
    const moved = await relinkTracksToEntity("labels", "lab-new", [
      "t-cert-0000000000000a",
      "t-cat-00000000000000a",
      "t-cert-0000000000000b",
      "t-cat-00000000000000b",
    ]);

    // Three tracks genuinely moved; the one already on lab-new did not.
    expect(moved).toBe(3);
    expect(await counts("labels", "lab-old")).toEqual({ certified: 0, renderable: 0 });
    // lab-new starts at 0 (its pre-existing catalogue track was raw-linked without a delta) and
    // gains exactly the three that moved: two certified, one catalogue.
    expect(await counts("labels", "lab-new")).toEqual({ certified: 2, renderable: 3 });
    expect((await db.execute(`select distinct projection from projection_repairs`)).rows).toEqual([
      { projection: "artist_qualification" },
    ]);
    expect((await db.execute(`select count(*) as n from public_aggregate_state`)).rows[0]?.n).toBe(
      0,
    );
  });

  it("moves album relationships without creating public projection maintenance", async () => {
    await seedAlbum(db, { id: "album-target", slug: "album-target" });
    await seedCatalogueTrack(db, { trackId: "album-track-000000001" });

    const { relinkTracksToEntity } = await import("./hub-counts");
    expect(await relinkTracksToEntity("albums", "album-target", ["album-track-000000001"])).toBe(1);
    expect((await db.execute(`select count(*) as n from projection_repairs`)).rows[0]?.n).toBe(0);
    expect((await db.execute(`select count(*) as n from public_aggregate_state`)).rows[0]?.n).toBe(
      0,
    );
    expect(
      (await db.execute(`select count(*) as n from artist_qualification_state`)).rows[0]?.n,
    ).toBe(0);
  });
});

describe("upsertTrackArtists — the mint/anchor upsert", () => {
  it("counts a NEW edge once, and a re-upsert of the same edge not at all", async () => {
    await seedTrack(db, {
      artists: ["Logistics"],
      logId: "004.7.2A",
      trackId: "t-cert-0000000000000a",
    });

    await upsertTrackArtists("t-cert-0000000000000a", ["Logistics"], ["sp-logi"], {
      fillImages: false,
    });

    const artistId = await idFrom(`select id from artists where name = 'Logistics'`);
    expect(await counts("artists", artistId)).toEqual({ certified: 1, renderable: 1 });

    // The anchor path re-runs the same upsert (only `position` would change) — `on conflict do
    // update` reports rowsAffected = 1 for that, which is exactly why the delta rides a pre-read
    // diff instead.
    await upsertTrackArtists("t-cert-0000000000000a", ["Logistics"], ["sp-logi"], {
      fillImages: false,
    });

    expect(await counts("artists", artistId)).toEqual({ certified: 1, renderable: 1 });
  });

  it("counts a catalogue track's edge as renderable only", async () => {
    await seedCatalogueTrack(db, { artists: ["Logistics"], trackId: "t-cat-00000000000000a" });

    await upsertTrackArtists("t-cat-00000000000000a", ["Logistics"], ["sp-logi"], {
      fillImages: false,
    });

    const artistId = await idFrom(`select id from artists where name = 'Logistics'`);
    expect(await counts("artists", artistId)).toEqual({ certified: 0, renderable: 1 });
  });

  it("credits an artist ONCE for a track that names it twice", async () => {
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });

    await upsertTrackArtists(
      "t-cert-0000000000000a",
      ["Logistics", "Logistics"],
      ["sp-logi", "sp-logi"],
      { fillImages: false },
    );

    const artistId = await idFrom(`select id from artists where name = 'Logistics'`);
    expect(await counts("artists", artistId)).toEqual({ certified: 1, renderable: 1 });
  });
});

describe("linkTracksToArtistEntities — the crawl name-fold", () => {
  it("counts only the edges it really creates, across a mixed batch", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedTrack(db, {
      artists: ["Logistics"],
      logId: "004.7.2A",
      trackId: "t-cert-0000000000000a",
    });
    await seedCatalogueTrack(db, { artists: ["Logistics"], trackId: "t-cat-00000000000000a" });
    // A third track whose edge ALREADY exists — it must not be counted again.
    await seedCatalogueTrack(db, { artists: ["Logistics"], trackId: "t-cat-00000000000000b" });
    await db.execute(
      `insert into track_artists (track_id, artist_id, position) values ('t-cat-00000000000000b', 'art-logi', 1)`,
    );

    const written = await linkTracksToArtistEntities([
      "t-cert-0000000000000a",
      "t-cat-00000000000000a",
      "t-cat-00000000000000b",
    ]);

    expect(written).toBe(2);
    expect(await counts("artists", "art-logi")).toEqual({ certified: 1, renderable: 2 });
  });

  it("a re-run over the same batch moves nothing", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedTrack(db, {
      artists: ["Logistics"],
      logId: "004.7.2A",
      trackId: "t-cert-0000000000000a",
    });

    await linkTracksToArtistEntities(["t-cert-0000000000000a"]);
    await linkTracksToArtistEntities(["t-cert-0000000000000a"]);

    expect(await counts("artists", "art-logi")).toEqual({ certified: 1, renderable: 1 });
  });
});

describe("the certify fan-out", () => {
  // The REAL `certifyExistingTrack` fan-out (label + album + every credited artist) is pinned in
  // findings-certification.integration.test.ts, on the harness that already stubs its announce legs.
  // What is proven here is the one statement that fan-out leans on — the `track_artists` subselect,
  // which must credit EVERY credited artist off one statement, and no one else.
  it("hubCountDeltaForTrackArtistsStatement credits every credited artist and nobody else", async () => {
    await seedArtist(db, { id: "art-a", name: "Logistics", slug: "logistics" });
    await seedArtist(db, { id: "art-b", name: "Nu:Tone", slug: "nu-tone" });
    await seedArtist(db, { id: "art-c", name: "Uncredited", slug: "uncredited" });
    await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });
    await db.execute(
      `insert into track_artists (track_id, artist_id, position)
       values ('t-cat-00000000000000a', 'art-a', 1), ('t-cat-00000000000000a', 'art-b', 2)`,
    );

    const { hubCountDeltaForTrackArtistsStatement } = await import("./hub-counts");
    await db.execute(
      hubCountDeltaForTrackArtistsStatement("t-cat-00000000000000a", {
        certified: 1,
        renderable: 0,
      }),
    );

    expect(await counts("artists", "art-a")).toEqual({ certified: 1, renderable: 0 });
    expect(await counts("artists", "art-b")).toEqual({ certified: 1, renderable: 0 });
    expect(await counts("artists", "art-c")).toEqual({ certified: 0, renderable: 0 });
  });

  it("a certify whose links land AFTER the flip does not double-count", async () => {
    // The real ordering in `certifyExistingTrack`: the flip batch runs first (the track has no
    // label yet, so nothing is credited there), then `linkTrackToLabel` sees an already-certified
    // track and carries the certified delta itself.
    await seedLabel(db, { id: "lab-hospital", name: "Hospital Records", slug: "hospital-records" });
    await seedCatalogueTrack(db, { label: "Hospital Records", trackId: "t-cat-00000000000000a" });

    await db.batch(
      [
        {
          args: ["t-cat-00000000000000a"],
          sql: `insert into findings (track_id, log_id, added_at) values (?, '004.7.2Z', '2026-07-26T00:00:00.000Z')`,
        },
        {
          args: ["t-cat-00000000000000a"],
          sql: `update tracks set is_catalogue = 0 where track_id = ?`,
        },
        // No label_id yet ⇒ the certify batch credits no label.
      ],
      "write",
    );
    await linkTrackToLabel("t-cat-00000000000000a", "Hospital Records");

    expect(await counts("labels", "lab-hospital")).toEqual({ certified: 1, renderable: 1 });
  });
});

describe("mergeLabel — the loser's counts move to the canonical", () => {
  it("adds exactly what the loser held, and the loser's row (and counts) are gone", async () => {
    await seedLabel(db, { id: "lab-loser", name: "Medschool", slug: "medschool" });
    await seedLabel(db, { id: "lab-canon", name: "Med School", slug: "med-school" });
    // Two certified + one catalogue on the loser; one certified already on the canonical.
    await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });
    await seedTrack(db, { logId: "004.7.2B", trackId: "t-cert-0000000000000b" });
    await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });
    await seedTrack(db, { logId: "004.7.2C", trackId: "t-cert-0000000000000c" });

    await linkTrackToLabel("t-cert-0000000000000a", "Medschool");
    await linkTrackToLabel("t-cert-0000000000000b", "Medschool");
    await linkTrackToLabel("t-cat-00000000000000a", "Medschool");
    await linkTrackToLabel("t-cert-0000000000000c", "Med School");

    expect(await counts("labels", "lab-loser")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("labels", "lab-canon")).toEqual({ certified: 1, renderable: 1 });

    const result = await mergeLabel("medschool", "med-school");

    expect(result.repointed.tracks).toBe(3);
    expect(await counts("labels", "lab-canon")).toEqual({ certified: 3, renderable: 4 });
    const loser = await db.execute(`select 1 from labels where id = 'lab-loser'`);
    expect(loser.rows).toHaveLength(0);
  });
});

// The two pure arithmetic helpers, unit-tested away from any database — the shapes the bulk paths
// and the artist paths both fold into.
describe("the arithmetic", () => {
  it("hubCountMoveStatements skips a group already pointing at the target", () => {
    const statements = hubCountMoveStatements("labels", "lab-new", [
      { certified: 1, fromId: null, renderable: 2 },
      { certified: 2, fromId: "lab-old", renderable: 3 },
      { certified: 9, fromId: "lab-new", renderable: 9 },
    ]);

    // One debit for lab-old, one credit for lab-new summing ONLY the groups that moved.
    expect(statements).toHaveLength(2);
    expect(statements[0]?.args).toEqual([-3, -2, "lab-old"]);
    expect(statements[1]?.args).toEqual([5, 3, "lab-new"]);
  });

  it("hubCountMoveStatements emits nothing when every group is already on the target", () => {
    expect(
      hubCountMoveStatements("albums", "alb-1", [{ certified: 1, fromId: "alb-1", renderable: 1 }]),
    ).toEqual([]);
  });

  it("hubCountArtistEdgeStatements folds duplicate pairs and sums per artist", () => {
    const statements = hubCountArtistEdgeStatements([
      { artistId: "art-a", certified: true, rankable: true, trackId: "t1" },
      { artistId: "art-a", certified: true, rankable: true, trackId: "t1" }, // the same edge twice
      { artistId: "art-a", certified: false, rankable: false, trackId: "t2" },
      { artistId: "art-b", certified: true, rankable: true, trackId: "t1" },
    ]);

    expect(statements).toHaveLength(2);
    expect(statements[0]?.args).toEqual([2, 1, 1, "art-a"]);
    expect(statements[1]?.args).toEqual([1, 1, 1, "art-b"]);
  });

  it("a counter never reads negative — the clamp holds", async () => {
    await seedLabel(db, { id: "lab-1", name: "Label", slug: "label" });
    const { hubCountDeltaStatement } = await import("./hub-counts");

    await db.execute(hubCountDeltaStatement("labels", "lab-1", { certified: -5, renderable: -5 }));

    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
  });
});

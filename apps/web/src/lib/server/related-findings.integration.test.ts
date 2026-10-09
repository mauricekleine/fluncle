import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "./integration-db";
import { listArtistsByAlbum, listArtistsByLabel } from "./artists";
import {
  getFindingsByAlbum,
  getFindingsByLabel,
  listRelatedFindings,
  RELATED_FINDINGS_LIMIT,
} from "./tracks";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const TODAY = "2026-10-05";

async function place(
  trackId: string,
  graph: { albumId?: string; artistIds?: string[]; labelId?: string; releaseDate?: string },
): Promise<void> {
  await db.execute({
    args: [graph.albumId ?? null, graph.labelId ?? null, graph.releaseDate ?? null, trackId],
    sql: `update tracks set album_id = ?, label_id = ?, release_date = ? where track_id = ?`,
  });

  for (const [position, artistId] of (graph.artistIds ?? []).entries()) {
    await db.execute({
      args: [trackId, artistId, position],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
    });
  }
}

async function finding(
  trackId: string,
  logId: string,
  addedAt: string,
  graph: Parameters<typeof place>[1] = {},
): Promise<void> {
  await seedTrack(db, { addedAt, logId, title: trackId, trackId });
  await place(trackId, graph);
}

async function catalogueTrack(trackId: string, graph: Parameters<typeof place>[1]): Promise<void> {
  await seedCatalogueTrack(db, { title: trackId, trackId });
  await place(trackId, graph);
}

async function similar(artistId: string, neighbourArtistId: string, rank: number): Promise<void> {
  await db.execute({
    args: [artistId, neighbourArtistId, rank],
    sql: `insert into artist_similar
            (artist_id, neighbour_artist_id, rank, similarity, rank_corpus, computed_at)
          values (?, ?, ?, 0.9, 'test', '2026-10-01T00:00:00.000Z')`,
  });
}

function ids(rows: { trackId: string }[]): string[] {
  return rows.map((row) => row.trackId);
}

beforeEach(async () => {
  db = await createIntegrationDb();

  await seedAlbum(db, { id: "album-home", slug: "album-home" });
  await seedAlbum(db, { id: "album-away", slug: "album-away" });
  await seedLabel(db, { id: "label-home", slug: "label-home" });
  await seedLabel(db, { id: "label-away", slug: "label-away" });

  for (const id of ["artist-home", "artist-neighbour", "artist-away", "artist-roamer"]) {
    await seedArtist(db, { id, slug: id });
  }
});

describe("related findings on a catalogue track page", () => {
  it("leads with the same record, then a shared artist, then the label, then the newest", async () => {
    await catalogueTrack("seed", {
      albumId: "album-home",
      artistIds: ["artist-home"],
      labelId: "label-home",
    });
    await finding("on-label", "100.1.1A", "2026-09-01T00:00:00.000Z", {
      artistIds: ["artist-away"],
      labelId: "label-home",
    });
    await finding("by-artist", "100.1.2A", "2026-08-01T00:00:00.000Z", {
      artistIds: ["artist-home"],
      labelId: "label-away",
    });
    await finding("on-record", "100.1.3A", "2026-07-01T00:00:00.000Z", {
      albumId: "album-home",
      artistIds: ["artist-away"],
    });
    await finding("newest", "100.1.4A", "2026-10-01T00:00:00.000Z", {
      albumId: "album-away",
      artistIds: ["artist-away"],
      labelId: "label-away",
    });

    const related = await listRelatedFindings({ kind: "track", trackId: "seed" }, { today: TODAY });

    expect(ids(related)).toStrictEqual(["on-record", "by-artist", "on-label", "newest"]);
    expect(related.every((row) => row.logId !== undefined)).toBe(true);
  });

  it("falls back to the newest findings when the track shares nothing with any finding", async () => {
    await catalogueTrack("loner", {});
    await finding("older", "100.2.1A", "2026-08-01T00:00:00.000Z");
    await finding("newer", "100.2.2A", "2026-09-01T00:00:00.000Z");

    const related = await listRelatedFindings({ kind: "track", trackId: "loner" });

    expect(ids(related)).toStrictEqual(["newer", "older"]);
  });
});

describe("related findings on an album page", () => {
  it("ranks findings by the record's artists above findings on its label", async () => {
    await catalogueTrack("album-cut", {
      albumId: "album-home",
      artistIds: ["artist-home"],
      labelId: "label-home",
    });
    await finding("label-mate", "200.1.1A", "2026-09-01T00:00:00.000Z", {
      labelId: "label-home",
    });
    await finding("same-artist", "200.1.2A", "2026-07-01T00:00:00.000Z", {
      artistIds: ["artist-home"],
    });
    await finding("stranger", "200.1.3A", "2026-10-01T00:00:00.000Z");

    const related = await listRelatedFindings({ albumId: "album-home", kind: "album" });

    expect(ids(related)).toStrictEqual(["same-artist", "label-mate", "stranger"]);
  });
});

describe("related findings on an artist page", () => {
  it("ranks findings by similar artists above findings on the artist's labels", async () => {
    await similar("artist-home", "artist-neighbour", 1);
    await catalogueTrack("artist-cut", { artistIds: ["artist-home"], labelId: "label-home" });
    await finding("label-mate", "300.1.1A", "2026-09-01T00:00:00.000Z", {
      labelId: "label-home",
    });
    await finding("neighbour", "300.1.2A", "2026-07-01T00:00:00.000Z", {
      artistIds: ["artist-neighbour"],
    });
    await finding("stranger", "300.1.3A", "2026-10-01T00:00:00.000Z");

    const related = await listRelatedFindings({ artistId: "artist-home", kind: "artist" });

    expect(ids(related)).toStrictEqual(["neighbour", "label-mate", "stranger"]);
  });
});

describe("related findings on a label page", () => {
  it("ranks findings by artists who released on the label above the newest", async () => {
    await catalogueTrack("label-cut", { artistIds: ["artist-roamer"], labelId: "label-home" });
    await finding("roamer-elsewhere", "400.1.1A", "2026-07-01T00:00:00.000Z", {
      artistIds: ["artist-roamer"],
      labelId: "label-away",
    });
    await finding("stranger", "400.1.2A", "2026-10-01T00:00:00.000Z", {
      artistIds: ["artist-away"],
    });

    const related = await listRelatedFindings({ kind: "label", labelId: "label-home" });

    expect(ids(related)).toStrictEqual(["roamer-elsewhere", "stranger"]);
  });
});

describe("what a related findings band never shows", () => {
  it("leaves out dismissed, duplicate, unreleased, and excluded findings", async () => {
    await catalogueTrack("seed", { albumId: "album-home" });
    await finding("kept", "500.1.1A", "2026-07-01T00:00:00.000Z");
    await finding("dismissed", "500.1.2A", "2026-07-02T00:00:00.000Z");
    await finding("duplicate", "500.1.3A", "2026-07-03T00:00:00.000Z");
    await finding("unreleased", "500.1.4A", "2026-07-04T00:00:00.000Z", {
      releaseDate: "2026-12-01",
    });
    await finding("excluded", "500.1.5A", "2026-07-05T00:00:00.000Z");
    await db.execute(`update tracks set dismissed_at = '2026-07-10' where track_id = 'dismissed'`);
    await db.execute(
      `update tracks set duplicate_of_track_id = 'kept' where track_id = 'duplicate'`,
    );

    const related = await listRelatedFindings(
      { kind: "track", trackId: "seed" },
      { excludeTrackIds: ["excluded"], today: TODAY },
    );

    expect(ids(related)).toStrictEqual(["kept"]);
  });

  it("strips the private capture and analysis fields from every row", async () => {
    await catalogueTrack("seed", {});
    await finding("captured", "500.2.1A", "2026-07-01T00:00:00.000Z");
    await db.execute(
      `update tracks set source_audio_key = '500.2.1A/abc.m4a', analyzed_at = '2026-07-02',
         analyzed_from = 'preview', bpm = 174, bpm_source = 'essentia', key = '8A',
         key_source = 'essentia'
       where track_id = 'captured'`,
    );

    const [row] = await listRelatedFindings({ kind: "track", trackId: "seed" });

    expect(row).toMatchObject({ trackId: "captured" });
    expect(row).not.toHaveProperty("sourceAudioKey", expect.anything());
    expect(row).not.toHaveProperty("analyzedAt", expect.anything());
    expect(row).not.toHaveProperty("analyzedFrom", expect.anything());
    expect(row).not.toHaveProperty("bpmSource", expect.anything());
    expect(row).not.toHaveProperty("keySource", expect.anything());
  });

  it("stops at the band's size", async () => {
    await catalogueTrack("seed", {});

    for (let index = 0; index < RELATED_FINDINGS_LIMIT + 3; index += 1) {
      await finding(`f${index}`, `600.1.${index}A`, `2026-07-0${index + 1}T00:00:00.000Z`);
    }

    const related = await listRelatedFindings({ kind: "track", trackId: "seed" });

    expect(related).toHaveLength(RELATED_FINDINGS_LIMIT);
  });
});

describe("the related findings statement at catalogue scale", () => {
  it("seeks each finding's artist edges by track and tests them against the entity's artists as a set", async () => {
    const executed: InStatement[] = [];
    const execute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation((statement: InStatement) => {
      executed.push(statement);
      return execute(statement);
    });

    await listRelatedFindings({ kind: "label", labelId: "label-home" });
    await listRelatedFindings({ albumId: "album-home", kind: "album" });
    await listRelatedFindings({ artistId: "artist-home", kind: "artist" });
    await listRelatedFindings({ kind: "track", trackId: "missing" });

    expect(executed).toHaveLength(4);
    for (const statement of executed) {
      if (typeof statement === "string") {
        continue;
      }
      const plan = await execute({
        args: statement.args,
        sql: `explain query plan ${statement.sql}`,
      });
      const edgeSeeks = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .filter((detail) => detail.startsWith("SEARCH fa "));
      expect(edgeSeeks.length).toBeGreaterThan(0);
      for (const detail of edgeSeeks) {
        expect(detail).toMatch(/\(track_id=\?\)$/);
      }
    }
  });
});

describe("an entity page's findings and artist chips", () => {
  it("lists the label's and album's findings and the artists credited on them", async () => {
    await finding("home-old", "700.1.1A", "2026-07-01T00:00:00.000Z", {
      albumId: "album-home",
      artistIds: ["artist-home"],
      labelId: "label-home",
    });
    await finding("home-new", "700.1.2A", "2026-08-01T00:00:00.000Z", {
      artistIds: ["artist-neighbour", "artist-home"],
      labelId: "label-home",
    });
    await finding("away", "700.1.3A", "2026-09-01T00:00:00.000Z", {
      albumId: "album-away",
      artistIds: ["artist-away"],
      labelId: "label-away",
    });
    await catalogueTrack("home-unlit", {
      albumId: "album-home",
      artistIds: ["artist-roamer"],
      labelId: "label-home",
    });

    expect(ids(await getFindingsByLabel("label-home", TODAY))).toStrictEqual([
      "home-new",
      "home-old",
    ]);
    expect(ids(await getFindingsByAlbum("album-home"))).toStrictEqual(["home-old"]);
    expect((await listArtistsByLabel("label-home")).map((chip) => chip.slug)).toStrictEqual([
      "artist-home",
      "artist-neighbour",
    ]);
    expect((await listArtistsByAlbum("album-home")).map((chip) => chip.slug)).toStrictEqual([
      "artist-home",
    ]);
  });

  it("drives from the findings, never from a walk of every track on the label or album", async () => {
    const executed: InStatement[] = [];
    const execute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation((statement: InStatement) => {
      executed.push(statement);
      return execute(statement);
    });

    await getFindingsByLabel("label-home", TODAY);
    await getFindingsByAlbum("album-home");
    await listArtistsByLabel("label-home");
    await listArtistsByAlbum("album-home");

    expect(executed).toHaveLength(4);
    for (const statement of executed) {
      if (typeof statement === "string") {
        continue;
      }
      const plan = await execute({
        args: statement.args,
        sql: `explain query plan ${statement.sql}`,
      });
      const outer = plan.rows
        .filter((row) => Number(row.parent) === 0)
        .map((row) => (typeof row.detail === "string" ? row.detail : ""));
      expect(outer[0]).toMatch(/^SCAN findings\b/);
      expect(outer.filter((detail) => detail.startsWith("SCAN "))).toHaveLength(1);
    }
  });
});

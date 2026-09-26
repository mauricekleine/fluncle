import { type Client } from "@libsql/client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
} from "./integration-db";

let db: Client;
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});
const { albumTracklistStatement, entityFindingsStatement, entityNewestStatement, listEntityQueue } =
  await import("./entity-queue");
const { toQueueTrack } = await import("../player-tracks");

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedAlbum(db, { id: "alb", slug: "album" });
  await seedArtist(db, { id: "art", slug: "artist" });
  await seedLabel(db, { id: "lab", slug: "label" });
});

async function track(
  id: string,
  date: string | null,
  preview: string | null = "https://preview.example/audio",
) {
  await seedCatalogueTrack(db, { artists: ["Artist"], title: `Title ${id}`, trackId: id });
  await db.execute({
    args: [date, preview, id],
    sql: `update tracks set album_id = 'alb',
    label_id = 'lab', release_date = ?, preview_url = ? where track_id = ?`,
  });
  await db.execute({
    args: [id],
    sql: "insert into track_artists (track_id, artist_id, position) values (?, 'art', 1)",
  });
}

it("plays a whole album, caps artists and labels at 20, and filters unplayable and future rows", async () => {
  for (let i = 0; i < 23; i++) {
    await track(`t-${String(i).padStart(2, "0")}`, `2026-01-${String(i + 1).padStart(2, "0")}`);
  }
  await track("no-preview", "2026-01-25", null);
  await track("future", "2999-01-01");
  await track("undated", null);
  for (const [id, added] of [
    ["t-00", "2026-01-01"],
    ["t-01", "2026-02-01"],
  ] as const) {
    await db.execute({
      args: [id, `log-${id}`, added],
      sql: "insert into findings (track_id, log_id, added_at) values (?, ?, ?)",
    });
    await db.execute({ args: [id], sql: "update tracks set is_catalogue = 0 where track_id = ?" });
  }
  const album = await listEntityQueue("album", "album");
  const artist = await listEntityQueue("artist", "artist");
  const label = await listEntityQueue("label", "label");
  expect(album).toHaveLength(24);
  expect(artist).toHaveLength(20);
  expect(label).toHaveLength(20);
  expect(album?.slice(0, 2).map((row) => row.trackId)).toEqual(["t-01", "t-00"]);
  expect(artist?.slice(0, 3).map((row) => row.trackId)).toEqual(["t-01", "t-00", "t-22"]);
  expect(label?.slice(0, 3).map((row) => row.trackId)).toEqual(["t-01", "t-00", "t-22"]);
  expect(album?.some((row) => row.trackId === "future" || row.trackId === "no-preview")).toBe(
    false,
  );
  expect(toQueueTrack(album?.[0] ?? { artists: [], title: "", trackId: "" }).href).toBe(
    "/log/log-t-01",
  );
});

it("returns undefined for unknown and unlisted artists", async () => {
  expect(await listEntityQueue("artist", "unknown")).toBeUndefined();
  await db.execute("update artists set mbid = 'mbid-pop' where id = 'art'");
  await db.execute({
    args: ["rule", "mbid-pop", "Pop", "2026-01-01", "2026-01-01"],
    sql: `insert into artist_rules (id, artist_mbid, artist_name, verdict, label_id,
      source, created_at, updated_at) values (?, ?, ?, 'unlisted', null, 'operator', ?, ?)`,
  });
  expect(await listEntityQueue("artist", "artist")).toBeUndefined();
});

it("includes an undated track with an ISRC-only preview source", async () => {
  await track("isrc-only", null, null);
  await db.execute("update tracks set isrc = 'GBAAA2600001' where track_id = 'isrc-only'");
  expect((await listEntityQueue("label", "label"))?.map((row) => row.trackId)).toEqual([
    "isrc-only",
  ]);
});

it("keeps long catalogue tracks out of hub play queues while retaining long findings", async () => {
  await track("long-catalogue", "2026-01-02");
  await track("long-finding", "2026-01-01");
  await db.execute(
    "update tracks set duration_ms = 900000 where track_id in ('long-catalogue', 'long-finding')",
  );
  await db.execute(
    "insert into findings (track_id, log_id, added_at) values ('long-finding', '701.1.0A', '2026-01-03')",
  );
  await db.execute("update tracks set is_catalogue = 0 where track_id = 'long-finding'");

  for (const kind of ["album", "artist", "label"] as const) {
    expect((await listEntityQueue(kind, kind))?.map((row) => row.trackId)).toEqual([
      "long-finding",
    ]);
  }
});

async function plan(statement: { args: (number | string)[]; sql: string }) {
  const result = await db.execute({
    args: statement.args,
    sql: `explain query plan ${statement.sql}`,
  });
  return result.rows.map((row) => (typeof row.detail === "string" ? row.detail : "")).join("\n");
}

it("reads findings from the findings table and newest tracks without sorting a label's whole catalogue", async () => {
  await track("one", "2026-01-01");
  const today = "2026-09-25";
  for (const kind of ["album", "artist", "label"] as const) {
    const id = kind === "album" ? "alb" : kind === "artist" ? "art" : "lab";
    expect(await plan(entityFindingsStatement(kind, id, today))).toMatch(/^SCAN findings/);
  }
  const labelNewest = await plan(entityNewestStatement("label", "lab", today));
  expect(labelNewest).toContain("tracks_label_cover_idx (label_id=?)");
  expect(labelNewest).not.toContain("TEMP B-TREE");
  expect(await plan(entityNewestStatement("artist", "art", today))).toMatch(
    /^SEARCH ta USING (COVERING )?INDEX track_artists_artist_id_idx/,
  );
  expect(await plan(albumTracklistStatement("alb", today))).toContain("tracks_album_id_idx");
});

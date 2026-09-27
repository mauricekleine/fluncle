import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportedAtOf,
  readExportMeta,
  refreshScoringExport,
  writeScoringExport,
} from "./label-outliers-export";

const scratch: string[] = [];

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "label-outliers-export-"));
  scratch.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function replica(directory: string): string {
  const path = join(directory, "source-replica.db");
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run(`create table tracks (track_id text primary key, label_id text, album_id text,
    is_catalogue integer not null, has_embedding integer not null, title text)`);
  database.run(
    "create table track_embeddings (track_id text primary key, embedding_blob blob not null)",
  );
  database.run("create table track_artists (track_id text not null, artist_id text not null)");
  database.run("create table albums (id text primary key, discogs_styles text, name text)");
  database.run("create table findings (track_id text primary key)");
  const blob = new Uint8Array(4096);
  blob[0] = 1;

  for (const [trackId, catalogue, embedded] of [
    ["cat_1", 1, true],
    ["cat_2", 1, true],
    ["cat_unembedded", 1, false],
    ["finding_1", 0, true],
  ] as const) {
    database.run("insert into tracks values (?, 'lbl_1', 'alb_1', ?, ?, 'Title')", [
      trackId,
      catalogue,
      embedded ? 1 : 0,
    ]);
    if (embedded) {
      database.run("insert into track_embeddings values (?, ?)", [trackId, blob]);
    }
    database.run("insert into track_artists values (?, 'art_1')", [trackId]);
  }
  database.run("insert into albums values ('alb_1', '[\"Jungle\"]', 'Album')");
  database.run("insert into albums values ('alb_2', null, 'Untagged')");
  database.close();

  return path;
}

describe("the scoring export", () => {
  test("carries only embedded catalogue tracks, their credits, and tagged albums, stamped with its time", async () => {
    const directory = scratchDir();
    const exportFile = join(directory, "label-outliers-inputs.db");

    await writeScoringExport(replica(directory), exportFile, "2026-09-28T03:00:00.000Z");

    const database = new Database(exportFile, { readonly: true, strict: true });
    const tables = database
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((row) => row.name);
    const tracks = database
      .query<{ track_id: string }, []>("select track_id from tracks order by track_id")
      .all()
      .map((row) => row.track_id);
    const credits = database
      .query<{ n: number }, []>("select count(*) as n from track_artists")
      .get();
    const albums = database.query<{ id: string }, []>("select id from albums").all();

    expect(tables).toEqual([
      "albums",
      "export_meta",
      "track_artists",
      "track_embeddings",
      "tracks",
    ]);
    expect(tracks).toEqual(["cat_1", "cat_2"]);
    expect(credits?.n).toBe(2);
    expect(albums).toEqual([{ id: "alb_1" }]);
    expect(readExportMeta(database)).toEqual({
      embeddedTracks: 2,
      exportedAt: "2026-09-28T03:00:00.000Z",
    });
    database.close();
  });

  test("a failed write leaves the previous export intact and no temporary file behind", async () => {
    const directory = scratchDir();
    const exportFile = join(directory, "label-outliers-inputs.db");
    await writeScoringExport(replica(directory), exportFile, "2026-09-27T03:00:00.000Z");
    const broken = join(directory, "broken.db");
    writeFileSync(broken, "not a database");

    const failed = await writeScoringExport(broken, exportFile, "2026-09-28T03:00:00.000Z").then(
      () => false,
      () => true,
    );

    expect(failed).toBe(true);
    expect(await exportedAtOf(exportFile)).toBe("2026-09-27T03:00:00.000Z");
    expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("a fresh export is not rewritten", async () => {
    const directory = scratchDir();
    const exportFile = join(directory, "label-outliers-inputs.db");
    await writeScoringExport(replica(directory), exportFile, "2026-09-28T03:00:00.000Z");
    let writes = 0;

    const status = await refreshScoringExport(join(directory, "source-replica.db"), exportFile, {
      now: () => new Date("2026-09-28T10:00:00.000Z"),
      write: async () => {
        writes += 1;
      },
    });

    expect(status).toMatchObject({ exportedAt: "2026-09-28T03:00:00.000Z", status: "fresh" });
    expect(writes).toBe(0);
  });

  test("a missing or aged export is rewritten", async () => {
    const directory = scratchDir();
    const exportFile = join(directory, "label-outliers-inputs.db");
    const replicaFile = replica(directory);

    const first = await refreshScoringExport(replicaFile, exportFile, {
      now: () => new Date("2026-09-27T03:00:00.000Z"),
    });
    const second = await refreshScoringExport(replicaFile, exportFile, {
      now: () => new Date("2026-09-28T03:00:00.000Z"),
    });

    expect(first.status).toBe("written");
    expect(second).toMatchObject({ exportedAt: "2026-09-28T03:00:00.000Z", status: "written" });
    expect(await exportedAtOf(exportFile)).toBe("2026-09-28T03:00:00.000Z");
  });

  test("a failing refresh reports failure and never throws", async () => {
    const directory = scratchDir();

    const status = await refreshScoringExport(
      join(directory, "absent-replica.db"),
      join(directory, "label-outliers-inputs.db"),
    );

    expect(status.status).toBe("failed");
    expect(status.error).not.toBeNull();
    expect(existsSync(join(directory, "label-outliers-inputs.db"))).toBe(false);
  });
});

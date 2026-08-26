import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveDeviceDatabase,
  publishDeviceArtifactAtomically,
  validateDeviceArtifact,
} from "../../../../apps/web/scripts/derive-device-db";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "../../../../apps/web/src/lib/server/integration-db";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function sourceFixture(options: { brokenAlbumPointer?: boolean } = {}): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "device-derive-test-"));
  temporaryDirectories.push(directory);
  const source = join(directory, "source.db");
  const client = await createIntegrationDb({ url: `file:${source}` });
  const timestamp = "2026-08-25T12:00:00.000Z";

  await seedTrack(client, { logId: "001.1.1A", title: "Certified", trackId: "certified" });
  await seedCatalogueTrack(client, { title: "Anchored", trackId: "anchored" });
  await seedEmbedding(client, "anchored", [0.1, 0.2]);
  await client.batch(
    [
      {
        args: ["label-parent", "Parent", "parent", timestamp, timestamp],
        sql: `INSERT INTO labels (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      },
      {
        args: ["label-child", "Child", "child", "label-parent", timestamp, timestamp],
        sql: `INSERT INTO labels (id, name, slug, parent_label_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      },
      {
        args: ["album-1", "Album", "album", timestamp, timestamp],
        sql: `INSERT INTO albums (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      },
      {
        args: ["artist-1", "Artist", "artist", timestamp, timestamp],
        sql: `INSERT INTO artists (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      },
      {
        args: [options.brokenAlbumPointer ? "missing-album" : "album-1", "label-child", "anchored"],
        sql: `UPDATE tracks SET album_id = ?, label_id = ? WHERE track_id = ?`,
      },
      {
        args: ["anchored", "artist-1", 1],
        sql: `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)`,
      },
    ],
    "write",
  );
  client.close();

  const database = new Database(source);
  database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  return source;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("deriveDeviceDatabase", () => {
  test("builds a deterministic, closed artifact and carries recursive label ancestry", async () => {
    const source = await sourceFixture();
    const directory = join(source, "..");
    const first = join(directory, "first.db");
    const second = join(directory, "second.db");
    const firstResult = await deriveDeviceDatabase({ cut: "anchored", out: first, source });
    const secondResult = await deriveDeviceDatabase({ cut: "anchored", out: second, source });

    expect(firstResult.validation).toBe("verified");
    expect(firstResult.contentFingerprint).toBe(secondResult.contentFingerprint);
    expect(readFileSync(first)).toEqual(readFileSync(second));
    expect(firstResult.selectedTrackCount).toBe(2);
    expect(firstResult.rowCounts.labels).toBe(2);

    const artifact = new Database(first, { readonly: true });
    expect(
      artifact
        .query("SELECT id FROM labels ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["label-child", "label-parent"]);
    artifact.close();
  });

  test("keeps the previous bytes when copy/build or pre-publication cutover fails", async () => {
    const source = await sourceFixture();
    const out = join(source, "..", "device.db");
    const oldBytes = Buffer.from("last-good-device-artifact");
    writeFileSync(out, oldBytes);

    expect(
      await rejectionMessage(
        deriveDeviceDatabase(
          { cut: "anchored", out, source },
          {
            afterCopy: () => {
              throw new Error("copy interrupted");
            },
          },
        ),
      ),
    ).toContain("copy interrupted");
    expect(readFileSync(out)).toEqual(oldBytes);

    expect(
      await rejectionMessage(
        deriveDeviceDatabase(
          { cut: "anchored", out, source },
          {
            publish: async () => {
              throw new Error("rename interrupted");
            },
          },
        ),
      ),
    ).toContain("rename interrupted");
    expect(readFileSync(out)).toEqual(oldBytes);
  });

  test("a lost response after atomic rename leaves the complete new artifact", async () => {
    const source = await sourceFixture();
    const out = join(source, "..", "device.db");
    writeFileSync(out, "last-good-device-artifact");

    expect(
      await rejectionMessage(
        deriveDeviceDatabase(
          { cut: "anchored", out, source },
          {
            publish: async (temporary, destination) => {
              await publishDeviceArtifactAtomically(temporary, destination);
              throw new Error("publication response lost");
            },
          },
        ),
      ),
    ).toContain("publication response lost");

    const database = new Database(out, { readonly: true });
    const metadata = database.query("SELECT cut_name FROM device_sync_meta").get() as {
      cut_name: string;
    };
    database.close();
    expect(metadata.cut_name).toBe("anchored");
  });

  test("rejects every dangling copied pointer before publication", async () => {
    const source = await sourceFixture({ brokenAlbumPointer: true });
    const out = join(source, "..", "device.db");
    const oldBytes = Buffer.from("last-good-device-artifact");
    writeFileSync(out, oldBytes);

    expect(
      await rejectionMessage(deriveDeviceDatabase({ cut: "anchored", out, source })),
    ).toContain("tracks.album_id -> albums.id");
    expect(readFileSync(out)).toEqual(oldBytes);
  });

  test("replaces a corrupt destination without manual cleanup", async () => {
    const source = await sourceFixture();
    const out = join(source, "..", "device.db");
    writeFileSync(out, "corrupt");

    const result = await deriveDeviceDatabase({ cut: "anchored", out, source });
    const validation = await validateDeviceArtifact(out, {
      cut: "anchored",
      sourceWatermark: result.sourceWatermark,
    });

    expect(validation.validation).toBe("verified");
  });
});

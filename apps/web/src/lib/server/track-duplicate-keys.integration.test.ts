import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("track_duplicate_keys maintenance and lookup plan", () => {
  it("moves the normalized ISRC atomically through the real generic writer", async () => {
    const { updateTrack } = await import("./track-update");
    await seedCatalogueTrack(db, {
      artists: ["Calibre"],
      title: "No Reply",
      trackId: "key-writer",
    });

    await updateTrack("key-writer", { isrc: "  GB-ABC-12-34567  " });

    const row = await db.execute({
      args: ["key-writer"],
      sql: `select match_key, normalized_isrc
            from track_duplicate_keys where track_id = ?`,
    });

    expect(row.rows[0]).toEqual({
      match_key: '[["calibre"],"no reply",""]',
      normalized_isrc: "GBABC1234567",
    });
  });

  it("uses each composite identity index for a candidate-key equality lookup", async () => {
    const plans: Record<"match_key" | "normalized_isrc", string> = {
      match_key: "track_duplicate_keys_match_key_track_id_idx",
      normalized_isrc: "track_duplicate_keys_isrc_track_id_idx",
    };

    for (const [column, indexName] of Object.entries(plans)) {
      const result = await db.execute({
        args: ["candidate-key"],
        sql: `explain query plan
              select duplicate_keys.track_id
              from track_duplicate_keys duplicate_keys
              join tracks on tracks.track_id = duplicate_keys.track_id
              where duplicate_keys.${column} in (?)
                and tracks.is_catalogue = 1
                and tracks.source_audio_key is not null
                and tracks.dismissed_at is null`,
      });
      const planRows = result.rows as unknown as { detail: string }[];
      const detail = planRows.map((row) => row.detail).join("\n");

      expect(detail).toContain(indexName);
    }
  });

  it("cascades the derived row when its track is deleted", async () => {
    await seedCatalogueTrack(db, {
      artists: ["dBridge"],
      title: "True Romance",
      trackId: "delete-key",
    });

    await db.execute({ args: ["delete-key"], sql: `delete from tracks where track_id = ?` });

    const row = await db.execute({
      args: ["delete-key"],
      sql: `select 1 from track_duplicate_keys where track_id = ?`,
    });
    expect(row.rows).toHaveLength(0);
  });
});

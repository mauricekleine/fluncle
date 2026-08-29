import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { REC_ELIGIBLE_WHERE } from "../../src/lib/catalogue-eligibility";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "../../src/lib/server/integration-db";
import {
  DEVICE_SELECTED_TRACKS_TABLE,
  materializeSelectedTrackIdsSql,
  selectDeviceRowsSql,
} from "./device-db-derivation";
import { DEVICE_DB_COLUMNS, DEVICE_SOURCE_TABLES } from "./device-db-schema";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("device database source selection", () => {
  test("executes every allowlisted projection against the generated production schema", async () => {
    for (const sql of materializeSelectedTrackIdsSql("anchored", REC_ELIGIBLE_WHERE, "main")) {
      await db.execute(sql);
    }

    for (const table of DEVICE_SOURCE_TABLES) {
      const result = await db.execute(selectDeviceRowsSql(table, "anchored", "main"));

      expect(result.columns, table).toEqual([...DEVICE_DB_COLUMNS[table]]);
    }
  });

  test("selects the certified and recommendation-eligible anchored cut deterministically", async () => {
    await seedTrack(db, {
      logId: "001.1.1A",
      title: "Certified",
      trackId: "certified",
    });
    await seedCatalogueTrack(db, { title: "Anchored", trackId: "anchored" });
    await seedEmbedding(db, "anchored", [0.1, 0.2]);
    await seedCatalogueTrack(db, { title: "No embedding", trackId: "no-embedding" });
    await seedCatalogueTrack(db, { title: "Dismissed", trackId: "dismissed" });
    await seedEmbedding(db, "dismissed", [0.1, 0.2]);
    await db.execute({
      args: ["2026-07-31T00:00:00.000Z", "dismissed"],
      sql: "update tracks set dismissed_at = ? where track_id = ?",
    });
    await seedCatalogueTrack(db, { title: "Duplicate", trackId: "duplicate" });
    await seedEmbedding(db, "duplicate", [0.1, 0.2]);
    await db.execute({
      args: ["anchored", "duplicate"],
      sql: "update tracks set duplicate_of_track_id = ? where track_id = ?",
    });
    await seedCatalogueTrack(db, {
      durationMs: 15 * 60_000,
      title: "Long form",
      trackId: "long-form",
    });
    await seedEmbedding(db, "long-form", [0.1, 0.2]);
    await seedCatalogueTrack(db, { title: "Too similar", trackId: "too-similar" });
    await seedEmbedding(db, "too-similar", [0.1, 0.2]);
    await db.execute({
      args: [0.995, "too-similar"],
      sql: "update tracks set nearest_finding_score = ? where track_id = ?",
    });

    for (const sql of materializeSelectedTrackIdsSql("anchored", REC_ELIGIBLE_WHERE, "main")) {
      await db.execute(sql);
    }

    const result = await db.execute(selectDeviceRowsSql("tracks", "anchored", "main"));

    expect(result.columns).toEqual([...DEVICE_DB_COLUMNS.tracks]);
    expect(result.columns).not.toContain("embedding_blob");
    expect(result.rows.map((row) => row.track_id)).toEqual(["anchored", "certified"]);
  });

  test("materializes the growing anchored scan once and makes every copy read that relation", () => {
    const materialization = materializeSelectedTrackIdsSql("anchored", REC_ELIGIBLE_WHERE, "main");

    expect(materialization).toHaveLength(2);
    expect(materialization[1]).toContain("track_embeddings");
    expect(materialization[1]).toContain(REC_ELIGIBLE_WHERE);

    for (const table of DEVICE_SOURCE_TABLES) {
      const copySql = selectDeviceRowsSql(table, "anchored", "main");

      expect(copySql, table).toContain(`temp."${DEVICE_SELECTED_TRACKS_TABLE}"`);
      expect(copySql, table).not.toContain("track_embeddings");
      expect(copySql, table).not.toContain(REC_ELIGIBLE_WHERE);
    }
  });
});

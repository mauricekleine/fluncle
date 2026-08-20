import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createIntegrationDb } from "../src/lib/server/integration-db";
import {
  trackDuplicateKeyValues,
  upsertTrackDuplicateKeyStatement,
} from "../src/lib/server/track-duplicate-keys";
import { backfillTrackDuplicateKeys } from "./backfill-track-duplicate-keys";

let db: Client;

const FIXTURES = [
  { artists: ["B", "A"], isrc: "GB-ABC-12-34567", title: "Signal (VIP)", trackId: "t-1" },
  { artists: ["Calibre"], isrc: null, title: "No Reply", trackId: "t-2" },
  { artists: ["Alix Perez"], isrc: "", title: "Crooklyn", trackId: "t-3" },
];

beforeEach(async () => {
  db = await createIntegrationDb();

  for (const fixture of FIXTURES) {
    await db.execute({
      args: [
        fixture.trackId,
        fixture.title,
        JSON.stringify(fixture.artists),
        fixture.isrc,
        240_000,
      ],
      sql: `insert into tracks (track_id, title, artists_json, isrc, duration_ms)
            values (?, ?, ?, ?, ?)`,
    });
  }
});

describe("track_duplicate_keys backfill", () => {
  it("resumes from existing rows, fills bounded chunks, and asserts one key row per track", async () => {
    const first = FIXTURES[0];

    if (!first) {
      throw new Error("duplicate-key backfill fixture is missing");
    }

    await db.execute(
      upsertTrackDuplicateKeyStatement({
        artistsJson: JSON.stringify(first.artists),
        isrc: first.isrc,
        title: first.title,
        trackId: first.trackId,
      }),
    );

    const result = await backfillTrackDuplicateKeys(db, 1);

    expect(result).toEqual({ backfilled: 2, keys: 3, skipped: false, tracks: 3 });

    const rows = await db.execute(
      `select track_id, match_key, normalized_isrc
       from track_duplicate_keys order by track_id`,
    );

    expect(rows.rows).toEqual(
      FIXTURES.map((fixture) => {
        const artistsJson = JSON.stringify(fixture.artists);
        const keys = trackDuplicateKeyValues({
          artistsJson,
          isrc: fixture.isrc,
          title: fixture.title,
          trackId: fixture.trackId,
        });

        return {
          match_key: keys.matchKey,
          normalized_isrc: keys.normalizedIsrc,
          track_id: fixture.trackId,
        };
      }),
    );

    expect(await backfillTrackDuplicateKeys(db, 1)).toEqual({
      backfilled: 0,
      keys: 3,
      skipped: true,
      tracks: 3,
    });
  });
});

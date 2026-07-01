import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillRecording019 } from "../../../scripts/backfill-recording-019f1a";
import { createIntegrationDb, rowCount, seedTrack } from "./integration-db";

// The 019.F.1A backfill (RFC recording-primitive, Design B) runs against the REAL
// migrated schema via the in-memory libSQL harness (integration-db applies every
// generated Drizzle migration, including the Wave 1 recordings migration). The
// point of these cases is the idempotency guarantee: a second run leaves the
// database byte-identical.

const MIXTAPE_ID = "mixtape-uuid-019";
const LOG_ID = "019.F.1A";

async function seedMixtape019(db: Client): Promise<void> {
  const now = "2026-06-18T18:27:21.000Z";

  await db.execute({
    args: [
      MIXTAPE_ID,
      LOG_ID,
      "Fluncle Drum & Bass Mixtape #1",
      now,
      4304790,
      "published",
      now,
      now,
    ],
    sql: `insert into mixtapes
      (id, log_id, title, recorded_at, duration_ms, status, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  // Two cued members (one with a start_ms cue, one without) + one clip already
  // cut from the set.
  await seedTrack(db, {
    artists: ["Netsky", "Bev Lee Harling"],
    logId: "aaa.1A",
    title: "Let's Leave Tomorrow",
    trackId: "track-1",
  });
  await seedTrack(db, {
    artists: ["Dawn Wall"],
    logId: "bbb.1A",
    title: "I See You",
    trackId: "track-2",
  });

  await db.execute({
    args: [MIXTAPE_ID, "track-1", 1, null],
    sql: `insert into mixtape_tracks (mixtape_id, track_id, position, start_ms) values (?, ?, ?, ?)`,
  });
  await db.execute({
    args: [MIXTAPE_ID, "track-2", 2, 125000],
    sql: `insert into mixtape_tracks (mixtape_id, track_id, position, start_ms) values (?, ?, ?, ?)`,
  });

  await db.execute({
    args: ["clip-1", MIXTAPE_ID, 1000, 20000, 0, "done", now, now],
    sql: `insert into mixtape_clips
      (id, mixtape_id, in_ms, out_ms, x_offset, status, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

/** Snapshot the tables this backfill touches, for byte-identical comparison. */
async function snapshot(db: Client): Promise<string> {
  const recordings = await db.execute("select * from recordings order by id");
  const mixtapes = await db.execute("select id, recording_id from mixtapes order by id");
  const clips = await db.execute("select id, recording_id from mixtape_clips order by id");

  return JSON.stringify({
    clips: clips.rows,
    mixtapes: mixtapes.rows,
    recordings: recordings.rows,
  });
}

describe("backfillRecording019", () => {
  let db: Client;

  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  it("synthesises a recording and links the mixtape + its clips", async () => {
    await seedMixtape019(db);

    const result = await backfillRecording019(db);

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("unreachable");
    }
    expect(result.memberCount).toBe(2);
    expect(result.clipsLinked).toBe(1);

    // Exactly one recording, owning the EXISTING R2 key (no bytes moved).
    expect(await rowCount(db, "recordings")).toBe(1);
    const rec = (await db.execute("select * from recordings")).rows[0];
    expect(rec?.id).toBe(result.recordingId);
    expect(rec?.r2_key).toBe("019.F.1A/set.mp4");
    expect(rec?.title).toBe("Fluncle Drum & Bass Mixtape #1");
    expect(rec?.recorded_at).toBe("2026-06-18T18:27:21.000Z");
    expect(rec?.duration_ms).toBe(4304790);

    // The tracklist carries the projected cue shape, ordered by position.
    const tracklistJson = rec?.tracklist_json;
    expect(typeof tracklistJson).toBe("string");
    const tracklist = JSON.parse(typeof tracklistJson === "string" ? tracklistJson : "[]");
    expect(tracklist).toHaveLength(2);
    expect(tracklist[0]).toMatchObject({
      artists: ["Netsky", "Bev Lee Harling"],
      startMs: null,
      title: "Let's Leave Tomorrow",
    });
    expect(tracklist[1]).toMatchObject({
      artists: ["Dawn Wall"],
      startMs: 125000,
      title: "I See You",
    });
    expect(typeof tracklist[0].id).toBe("string");

    // The mixtape and its clip both point at the new recording.
    const mixtape = (
      await db.execute({
        args: [LOG_ID],
        sql: "select recording_id from mixtapes where log_id = ?",
      })
    ).rows[0];
    expect(mixtape?.recording_id).toBe(result.recordingId);
    const clip = (
      await db.execute({
        args: ["clip-1"],
        sql: "select recording_id from mixtape_clips where id = ?",
      })
    ).rows[0];
    expect(clip?.recording_id).toBe(result.recordingId);
  });

  it("is idempotent — a second run is a no-op and leaves identical state", async () => {
    await seedMixtape019(db);

    const first = await backfillRecording019(db);
    expect(first.status).toBe("created");
    if (first.status !== "created") {
      throw new Error("unreachable");
    }

    const before = await snapshot(db);

    const second = await backfillRecording019(db);
    expect(second.status).toBe("already-linked");
    if (second.status !== "already-linked") {
      throw new Error("unreachable");
    }
    expect(second.recordingId).toBe(first.recordingId);

    // Still exactly one recording; the whole table snapshot is byte-identical.
    expect(await rowCount(db, "recordings")).toBe(1);
    expect(await snapshot(db)).toBe(before);
  });

  it("no-ops when the 019.F.1A mixtape is absent", async () => {
    const result = await backfillRecording019(db);

    expect(result.status).toBe("mixtape-missing");
    expect(await rowCount(db, "recordings")).toBe(0);
  });
});

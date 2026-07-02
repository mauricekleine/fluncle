import { type Client } from "@libsql/client";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillPlanRecordingMixtape } from "../../../scripts/backfill-plan-recording-mixtape";
import { createIntegrationDb, rowCount, seedTrack } from "./integration-db";

// The plan→recording→mixtape Deploy-1 backfill runs against the REAL migrated
// schema via the in-memory libSQL harness (integration-db applies every generated
// Drizzle migration, including 0043/0044). Because `db:backfill` runs on EVERY
// deploy, the load-bearing cases are the idempotency guarantee (a second run is a
// byte-identical no-op) and the S3/S4/S5 data-loss guards from the RFC:
//   - mixtape #1's existing recording is REUSED, never re-synthesized, and its
//     cues seed from `mixtape_tracks` (exact track_id), NOT from tracklist_json;
//   - legacy tracklist_json cues resolve findings by NORMALIZED title+artist,
//     never by cue.id; unresolved stays NULL + snapshot;
//   - both-owned / sentinel clips normalize to a single owner.

const NOW = "2026-06-18T18:27:21.000Z";

// Mixtape #1 — published, ALREADY linked to its recording (the shipped 019 state).
const M1 = "mixtape-1";
const M1_LOG = "019.F.1A";
const REC_019 = "rec-019";

// Mixtape #2 — distributing, NOT yet linked (the synthesize-a-take case).
const M2 = "mixtape-2";
const M2_LOG = "020.F.1B";

// A draft (→ plan) and the standalone recordings.
const DRAFT = "mixtape-draft";
const REC_ROLLING = "rec-rolling"; // the empty rolling set (no tracklist_json)
const REC_HAND = "rec-hand"; // hand-authored tracklist_json, resolved by text

async function insertMixtape(
  db: Client,
  row: {
    id: string;
    logId?: string | null;
    note?: string | null;
    plannedFor?: string | null;
    recordingId?: string | null;
    status: string;
    title?: string;
  },
): Promise<void> {
  await db.execute({
    args: [
      row.id,
      row.logId ?? null,
      row.title ?? "",
      row.status,
      row.note ?? null,
      row.plannedFor ?? null,
      row.recordingId ?? null,
      NOW,
      NOW,
    ],
    sql: `insert into mixtapes
      (id, log_id, title, status, note, planned_for, recording_id, recorded_at, duration_ms, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z', 4304790, ?, ?)`,
  });
}

async function insertMember(
  db: Client,
  mixtapeId: string,
  trackId: string,
  position: number,
  startMs: number | null,
): Promise<void> {
  await db.execute({
    args: [mixtapeId, trackId, position, startMs],
    sql: `insert into mixtape_tracks (mixtape_id, track_id, position, start_ms) values (?, ?, ?, ?)`,
  });
}

async function insertRecording(
  db: Client,
  row: { id: string; r2Key: string | null; title: string; tracklistJson?: string | null },
): Promise<void> {
  await db.execute({
    args: [row.id, row.title, row.r2Key, row.tracklistJson ?? null, NOW, NOW],
    sql: `insert into recordings (id, title, r2_key, tracklist_json, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function insertClip(
  db: Client,
  row: { id: string; mixtapeId: string | null; recordingId: string | null },
): Promise<void> {
  await db.execute({
    args: [row.id, row.mixtapeId, row.recordingId, NOW, NOW],
    sql: `insert into mixtape_clips
      (id, mixtape_id, recording_id, in_ms, out_ms, x_offset, status, created_at, updated_at)
      values (?, ?, ?, 1000, 20000, 0, 'done', ?, ?)`,
  });
}

/** The prod-shaped seed from the RFC's acceptance criteria. */
async function seedProdShape(db: Client): Promise<void> {
  await seedTrack(db, {
    artists: ["Netsky", "Bev Lee Harling"],
    logId: "aaa.1A",
    title: "Let's Leave Tomorrow",
    trackId: "t1",
  });
  await seedTrack(db, {
    artists: ["Dawn Wall"],
    logId: "bbb.1A",
    title: "I See You",
    trackId: "t2",
  });
  await seedTrack(db, {
    artists: ["Alix Perez"],
    logId: "ccc.2B",
    title: "Burning Babylon",
    trackId: "t3",
  });
  await seedTrack(db, { artists: ["Hedex"], logId: "ddd.3C", title: "Bam Bam", trackId: "t4" });

  // #1: published + already linked to its recording; tracklist_json was built by
  // the 019 backfill with RANDOM cue ids (no track ids) — the trap this Deploy
  // fixes. Its mixtape_tracks hold the EXACT links.
  await insertRecording(db, {
    id: REC_019,
    r2Key: `${M1_LOG}/set.mp4`,
    title: "Fluncle Drum & Bass Mixtape #1",
    tracklistJson: JSON.stringify([
      {
        artists: ["Netsky", "Bev Lee Harling"],
        id: "cue-uuid-1",
        startMs: null,
        title: "Let's Leave Tomorrow",
      },
      { artists: ["Dawn Wall"], id: "cue-uuid-2", startMs: 125000, title: "I See You" },
    ]),
  });
  await insertMixtape(db, {
    id: M1,
    logId: M1_LOG,
    recordingId: REC_019,
    status: "published",
    title: "Fluncle Drum & Bass Mixtape #1",
  });
  await insertMember(db, M1, "t1", 1, null);
  await insertMember(db, M1, "t2", 2, 125000);

  // #2: distributing, no recording yet, one legacy mixtape-only clip.
  await insertMixtape(db, {
    id: M2,
    logId: M2_LOG,
    status: "distributing",
    title: "Fluncle Drum & Bass Mixtape #2",
  });
  await insertMember(db, M2, "t4", 1, 30000);
  await insertClip(db, { id: "clip-legacy", mixtapeId: M2, recordingId: null });

  // A draft (→ plan) with a pencilled member + planned date + note.
  await insertMixtape(db, {
    id: DRAFT,
    note: "warm-up plan",
    plannedFor: "2026-07-10T20:00:00.000Z",
    status: "draft",
  });
  await insertMember(db, DRAFT, "t3", 1, null);

  // The rolling set (no cues at all) + a hand-authored standalone recording.
  await insertRecording(db, {
    id: REC_ROLLING,
    r2Key: `recordings/${REC_ROLLING}/set.mp4`,
    title: "Rolling set",
  });
  await insertRecording(db, {
    id: REC_HAND,
    r2Key: `recordings/${REC_HAND}/set.mp4`,
    title: "Warehouse set",
    tracklistJson: JSON.stringify([
      // Reordered + case-varied identity — resolved by NORMALIZED text (the
      // matcher needs the same artist SET, so both credited artists appear).
      {
        artists: ["Bev Lee Harling", "NETSKY"],
        id: "hand-cue-1",
        startMs: 0,
        title: "let's leave tomorrow",
      },
      { artists: ["Unknown Artist"], id: "hand-cue-2", startMs: 90000, title: "Dubplate 7" },
    ]),
  });

  // The both-owned clip (019 linked without unlinking) + a sentinel clip.
  await insertClip(db, { id: "clip-both", mixtapeId: M1, recordingId: REC_019 });
  await insertClip(db, { id: "clip-sentinel", mixtapeId: "", recordingId: REC_ROLLING });
}

/** Snapshot every table the backfill touches, for byte-identical comparison. */
async function snapshot(db: Client): Promise<string> {
  const recordings = await db.execute(
    "select id, title, note, planned_for, r2_key, parent_id, version from recordings order by id",
  );
  const cues = await db.execute(
    "select recording_id, position, finding_id, artists_text, title_text, start_ms from recording_cues order by recording_id, position",
  );
  const mixtapes = await db.execute("select id, recording_id from mixtapes order by id");
  const members = await db.execute(
    "select mixtape_id, position, track_id, finding_id, artists_text, title_text from mixtape_tracks order by mixtape_id, position",
  );
  const clips = await db.execute(
    "select id, mixtape_id, recording_id from mixtape_clips order by id",
  );

  return JSON.stringify({
    clips: clips.rows,
    cues: cues.rows,
    members: members.rows,
    mixtapes: mixtapes.rows,
    recordings: recordings.rows,
  });
}

describe("backfillPlanRecordingMixtape", () => {
  let db: Client;

  beforeEach(async () => {
    db = await createIntegrationDb();
    await seedProdShape(db);
  });

  it("turns the draft into a plan-recording (r2Key NULL) with exact finding-linked cues", async () => {
    const result = await backfillPlanRecordingMixtape(db);

    expect(result.plansCreated).toBe(1);
    expect(result.planCuesInserted).toBe(1);

    const draft = (
      await db.execute({ args: [DRAFT], sql: "select recording_id from mixtapes where id = ?" })
    ).rows[0];
    const planId = draft?.recording_id;
    expect(typeof planId).toBe("string");

    const plan = (
      await db.execute({
        args: [planId ?? null],
        sql: "select * from recordings where id = ?",
      })
    ).rows[0];
    expect(plan?.r2_key).toBeNull();
    expect(plan?.parent_id).toBeNull();
    expect(plan?.version).toBe(1);
    expect(plan?.note).toBe("warm-up plan");
    expect(plan?.planned_for).toBe("2026-07-10T20:00:00.000Z");
    // The plan's title IS its Galaxy-vocab handle — a three-word slug (RFC
    // §6/D-handle), deterministic in the draft id.
    expect(plan?.title).toMatch(/^[a-z]+(-[a-z]+){2}$/);
    expect(plan?.title).toBe(galaxySlug(DRAFT));

    const cues = (
      await db.execute({
        args: [planId ?? null],
        sql: "select * from recording_cues where recording_id = ? order by position",
      })
    ).rows;
    expect(cues).toHaveLength(1);
    expect(cues[0]?.finding_id).toBe("t3");
    expect(cues[0]?.position).toBe(1);
    expect(cues[0]?.artists_text).toBe("Alix Perez");
    expect(cues[0]?.title_text).toBe("Burning Babylon");
  });

  it("re-syncs a still-draft plan's note/planned_for but never re-mints the handle", async () => {
    await backfillPlanRecordingMixtape(db);
    const handleBefore = (
      await db.execute({
        sql: `select r.title as title from recordings r join mixtapes m on m.recording_id = r.id where m.id = '${DRAFT}'`,
      })
    ).rows[0]?.title;

    await db.execute({
      args: [DRAFT],
      sql: "update mixtapes set note = 'rewritten plan note', title = 'operator typed a title' where id = ?",
    });

    const second = await backfillPlanRecordingMixtape(db);
    expect(second.plansCreated).toBe(0);
    expect(second.plansSynced).toBe(1);

    const plan = (
      await db.execute({
        sql: `select r.note as note, r.title as title from recordings r join mixtapes m on m.recording_id = r.id where m.id = '${DRAFT}'`,
      })
    ).rows[0];
    expect(plan?.note).toBe("rewritten plan note");
    // The handle is minted once — a draft title edit never overwrites it.
    expect(plan?.title).toBe(handleBefore);
    expect(plan?.title).toBe(galaxySlug(DRAFT));
  });

  it("mints a deterministic handle — the same draft yields the same slug on a re-run", async () => {
    await backfillPlanRecordingMixtape(db);
    const first = (
      await db.execute({
        sql: `select r.title as title from recordings r join mixtapes m on m.recording_id = r.id where m.id = '${DRAFT}'`,
      })
    ).rows[0]?.title;

    // A re-run creates no new plan and leaves the handle untouched.
    const second = await backfillPlanRecordingMixtape(db);
    expect(second.plansCreated).toBe(0);

    const after = (
      await db.execute({
        sql: `select r.title as title from recordings r join mixtapes m on m.recording_id = r.id where m.id = '${DRAFT}'`,
      })
    ).rows[0]?.title;
    expect(after).toBe(first);
    expect(after).toBe(galaxySlug(DRAFT));
  });

  it("salts the handle on collision so two drafts never share a slug", async () => {
    // A second draft whose id would collide is re-rolled; both plans get a valid,
    // distinct three-word slug.
    const draftB = "mixtape-draft-b";
    await insertMixtape(db, { id: draftB, status: "draft", title: "" });
    // Pre-seat draftB's attempt-0 slug on an unrelated recording to FORCE the
    // salted re-roll path.
    await insertRecording(db, { id: "collide", r2Key: null, title: galaxySlug(draftB) });

    await backfillPlanRecordingMixtape(db);

    const slugs = (
      await db.execute({
        sql: `select r.title as title from recordings r
              join mixtapes m on m.recording_id = r.id
              where m.id in ('${DRAFT}', '${draftB}')`,
      })
    ).rows.map((row) => (typeof row.title === "string" ? row.title : ""));

    expect(slugs).toHaveLength(2);
    expect(new Set(slugs).size).toBe(2);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z]+(-[a-z]+){2}$/);
    }
    // draftB re-rolled off its taken attempt-0 slug.
    expect(slugs).not.toContain(galaxySlug(draftB));
    expect(slugs).toContain(galaxySlug(draftB, 1));
  });

  it("reuses #1's existing recording (never re-synthesizes) and seeds its cues from mixtape_tracks, not tracklist_json", async () => {
    const result = await backfillPlanRecordingMixtape(db);

    expect(result.takesSynthesized).toBe(1); // M2 only — M1 is reused.

    // #1 still links the SAME recording; no duplicate row appeared for it.
    const m1 = (
      await db.execute({ args: [M1], sql: "select recording_id from mixtapes where id = ?" })
    ).rows[0];
    expect(m1?.recording_id).toBe(REC_019);

    // Cues carry the EXACT mixtape_tracks links (S3), not text-matched JSON.
    const cues = (
      await db.execute({
        args: [REC_019],
        sql: "select finding_id, position, start_ms from recording_cues where recording_id = ? order by position",
      })
    ).rows;
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ finding_id: "t1", position: 1, start_ms: null });
    expect(cues[1]).toMatchObject({ finding_id: "t2", position: 2, start_ms: 125000 });
  });

  it("synthesizes a take for the un-linked distributing mixtape and repoints its legacy clip", async () => {
    await backfillPlanRecordingMixtape(db);

    const m2 = (
      await db.execute({ args: [M2], sql: "select recording_id from mixtapes where id = ?" })
    ).rows[0];
    const recordingId = m2?.recording_id;
    expect(typeof recordingId).toBe("string");

    const recording = (
      await db.execute({
        args: [recordingId ?? null],
        sql: "select r2_key, recorded_at, duration_ms from recordings where id = ?",
      })
    ).rows[0];
    expect(recording?.r2_key).toBe(`${M2_LOG}/set.mp4`);

    const cues = (
      await db.execute({
        args: [recordingId ?? null],
        sql: "select finding_id, start_ms from recording_cues where recording_id = ?",
      })
    ).rows;
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ finding_id: "t4", start_ms: 30000 });

    // The legacy clip now carries the recording as its single owner.
    const clip = (
      await db.execute({
        sql: "select mixtape_id, recording_id from mixtape_clips where id = 'clip-legacy'",
      })
    ).rows[0];
    expect(clip?.recording_id).toBe(recordingId);
    expect(clip?.mixtape_id).toBeNull();
  });

  it("migrates legacy tracklist_json cues by normalized text (never cue.id), leaving unresolved NULL + snapshot", async () => {
    const result = await backfillPlanRecordingMixtape(db);

    expect(result.tracklistCuesInserted).toBe(2);
    expect(result.tracklistCuesUnresolved).toBe(1);

    const cues = (
      await db.execute({
        args: [REC_HAND],
        sql: "select id, finding_id, artists_text, title_text, position, start_ms from recording_cues where recording_id = ? order by position",
      })
    ).rows;
    expect(cues).toHaveLength(2);
    // Resolved across feat./case variance — by TEXT, not by the random cue id.
    expect(cues[0]).toMatchObject({ finding_id: "t1", id: "hand-cue-1", position: 1, start_ms: 0 });
    // Unresolved → NULL + the honest snapshot.
    expect(cues[1]).toMatchObject({
      artists_text: "Unknown Artist",
      finding_id: null,
      id: "hand-cue-2",
      title_text: "Dubplate 7",
    });

    // The empty rolling set stays cue-less (nothing invented).
    const rolling = (
      await db.execute({
        args: [REC_ROLLING],
        sql: "select count(*) as n from recording_cues where recording_id = ?",
      })
    ).rows[0];
    expect(Number(rolling?.n)).toBe(0);
  });

  it("fills mixtape_tracks.finding_id and normalizes every clip to a single owner", async () => {
    const result = await backfillPlanRecordingMixtape(db);

    expect(result.trackFindingIdsFilled).toBe(4);
    const unfilled = (
      await db.execute({ sql: "select count(*) as n from mixtape_tracks where finding_id is null" })
    ).rows[0];
    expect(Number(unfilled?.n)).toBe(0);
    const mismatched = (
      await db.execute({
        sql: "select count(*) as n from mixtape_tracks where finding_id != track_id",
      })
    ).rows[0];
    expect(Number(mismatched?.n)).toBe(0);

    // Every clip now has exactly one owner; the '' sentinel is gone.
    const both = (
      await db.execute({
        sql: "select count(*) as n from mixtape_clips where recording_id is not null and mixtape_id is not null",
      })
    ).rows[0];
    expect(Number(both?.n)).toBe(0);
    const sentinel = (
      await db.execute({ sql: "select count(*) as n from mixtape_clips where mixtape_id = ''" })
    ).rows[0];
    expect(Number(sentinel?.n)).toBe(0);
    const owned = (
      await db.execute({
        sql: "select count(*) as n from mixtape_clips where recording_id is not null",
      })
    ).rows[0];
    expect(Number(owned?.n)).toBe(3);
  });

  it("is idempotent — a second run reports zero work and leaves identical state", async () => {
    const first = await backfillPlanRecordingMixtape(db);
    expect(first.plansCreated).toBe(1);

    const before = await snapshot(db);
    const rowCounts = {
      clips: await rowCount(db, "mixtape_clips"),
      cues: await rowCount(db, "recording_cues"),
      recordings: await rowCount(db, "recordings"),
    };

    const second = await backfillPlanRecordingMixtape(db);

    expect(second).toEqual({
      clipsNormalized: 0,
      planCuesInserted: 0,
      plansCreated: 0,
      plansSynced: 0,
      takeCuesInserted: 0,
      takesSynthesized: 0,
      trackFindingIdsFilled: 0,
      tracklistCuesInserted: 0,
      tracklistCuesUnresolved: 0,
    });
    expect(await snapshot(db)).toBe(before);
    expect(await rowCount(db, "recordings")).toBe(rowCounts.recordings);
    expect(await rowCount(db, "recording_cues")).toBe(rowCounts.cues);
    expect(await rowCount(db, "mixtape_clips")).toBe(rowCounts.clips);
  });

  it("preserves every pre-existing row (nothing deleted, tracklist_json untouched)", async () => {
    await backfillPlanRecordingMixtape(db);

    // All 3 mixtapes, all 4 members, all 3 clips survive.
    expect(await rowCount(db, "mixtapes")).toBe(3);
    expect(await rowCount(db, "mixtape_tracks")).toBe(4);
    expect(await rowCount(db, "mixtape_clips")).toBe(3);
    // 3 seeded recordings + M2's synthesized take + the draft's plan.
    expect(await rowCount(db, "recordings")).toBe(5);

    // Dual-read safety: the legacy tracklist_json columns are NOT cleared.
    const legacy = (
      await db.execute({
        sql: "select count(*) as n from recordings where tracklist_json is not null",
      })
    ).rows[0];
    expect(Number(legacy?.n)).toBe(2);
  });

  it("no-ops cleanly on an empty database", async () => {
    const empty = await createIntegrationDb();
    const result = await backfillPlanRecordingMixtape(empty);

    expect(result.plansCreated).toBe(0);
    expect(result.takesSynthesized).toBe(0);
    expect(await rowCount(empty, "recordings")).toBe(0);
  });
});

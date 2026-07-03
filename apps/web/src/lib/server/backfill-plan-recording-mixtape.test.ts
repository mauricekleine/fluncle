import { type Client } from "@libsql/client";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillPlanRecordingMixtape } from "../../../scripts/backfill-plan-recording-mixtape";
import { createIntegrationDb, rowCount, seedTrack } from "./integration-db";

// The plan→recording→mixtape backfill runs against the REAL migrated schema via the
// in-memory libSQL harness (integration-db applies every generated Drizzle migration,
// including 0045 — the Deploy-2 cutover that dropped `recordings.tracklist_json`,
// `mixtapes.planned_for`, and `mixtape_clips.mixtape_id`). The legacy-column steps
// (the tracklist_json migration + the clip-owner normalization) retired with those
// columns — the LIVE Deploy-1 backfill migrated every prod row first. What remains,
// and is under test here, runs on EVERY deploy (all idempotent, guarded):
//   - drafts → plan-recordings + their cues from `mixtape_tracks` (exact track_id);
//   - mixtape #1's existing recording is REUSED, never re-synthesized; an unlinked
//     published/distributing mixtape gets a synthesized take + cues from its tracks;
//   - `mixtape_tracks.finding_id` fills `= track_id`;
//   - a second run is a byte-identical no-op.

const NOW = "2026-06-18T18:27:21.000Z";

// Mixtape #1 — published, ALREADY linked to its recording (the shipped 019 state).
const M1 = "mixtape-1";
const M1_LOG = "019.F.1A";
const REC_019 = "rec-019";

// Mixtape #2 — distributing, NOT yet linked (the synthesize-a-take case).
const M2 = "mixtape-2";
const M2_LOG = "020.F.1B";

// A draft (→ plan) and the standalone rolling-set recording.
const DRAFT = "mixtape-draft";
const REC_ROLLING = "rec-rolling"; // the empty rolling set (a cue-less standalone)

async function insertMixtape(
  db: Client,
  row: {
    id: string;
    logId?: string | null;
    note?: string | null;
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
      row.recordingId ?? null,
      NOW,
      NOW,
    ],
    sql: `insert into mixtapes
      (id, log_id, title, status, note, recording_id, recorded_at, duration_ms, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z', 4304790, ?, ?)`,
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
  row: { id: string; r2Key: string | null; title: string },
): Promise<void> {
  await db.execute({
    args: [row.id, row.title, row.r2Key, NOW, NOW],
    sql: `insert into recordings (id, title, r2_key, created_at, updated_at)
          values (?, ?, ?, ?, ?)`,
  });
}

async function insertClip(db: Client, row: { id: string; recordingId: string }): Promise<void> {
  await db.execute({
    args: [row.id, row.recordingId, NOW, NOW],
    sql: `insert into mixtape_clips
      (id, recording_id, in_ms, out_ms, x_offset, status, created_at, updated_at)
      values (?, ?, 1000, 20000, 0, 'done', ?, ?)`,
  });
}

/** The prod-shaped seed from the RFC's acceptance criteria (post-cutover schema). */
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

  // #1: published + already linked to its recording; its `mixtape_tracks` hold the
  // EXACT links the cue seed copies from.
  await insertRecording(db, {
    id: REC_019,
    r2Key: `${M1_LOG}/set.mp4`,
    title: "Fluncle Drum & Bass Mixtape #1",
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
  // #1's recording already carries its cues (the LIVE Deploy-1 seeded them).
  await db.execute({
    args: [REC_019, "t1", NOW, NOW, REC_019, "t2", 125000, NOW, NOW],
    sql: `insert into recording_cues
            (id, recording_id, finding_id, artists_text, title_text, position, start_ms, created_at, updated_at)
          values ('rc1', ?, ?, 'Netsky, Bev Lee Harling', 'Let''s Leave Tomorrow', 1, null, ?, ?),
                 ('rc2', ?, ?, 'Dawn Wall', 'I See You', 2, ?, ?, ?)`,
  });

  // #2: distributing, no recording yet — the synthesize-a-take case.
  await insertMixtape(db, {
    id: M2,
    logId: M2_LOG,
    status: "distributing",
    title: "Fluncle Drum & Bass Mixtape #2",
  });
  await insertMember(db, M2, "t4", 1, 30000);

  // A draft (→ plan) with a pencilled member + note.
  await insertMixtape(db, {
    id: DRAFT,
    note: "warm-up plan",
    status: "draft",
  });
  await insertMember(db, DRAFT, "t3", 1, null);

  // The rolling set (a cue-less standalone recording) + a clip cut from it.
  await insertRecording(db, {
    id: REC_ROLLING,
    r2Key: `recordings/${REC_ROLLING}/set.mp4`,
    title: "Rolling set",
  });
  await insertClip(db, { id: "clip-rolling", recordingId: REC_ROLLING });
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
  const clips = await db.execute("select id, recording_id from mixtape_clips order by id");

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

  it("re-syncs a still-draft plan's note but never re-mints the handle", async () => {
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

  it("reuses #1's existing recording (never re-synthesizes) and leaves its seeded cues intact", async () => {
    const result = await backfillPlanRecordingMixtape(db);

    expect(result.takesSynthesized).toBe(1); // M2 only — M1 is reused.

    // #1 still links the SAME recording; no duplicate row appeared for it.
    const m1 = (
      await db.execute({ args: [M1], sql: "select recording_id from mixtapes where id = ?" })
    ).rows[0];
    expect(m1?.recording_id).toBe(REC_019);

    // Its pre-seeded cues (from the LIVE Deploy-1) are left untouched — the zero-cue
    // gate skips a recording that already has cues.
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

  it("synthesizes a take for the un-linked distributing mixtape and seeds its cues", async () => {
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
  });

  it("fills mixtape_tracks.finding_id for every member", async () => {
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
      planCuesInserted: 0,
      plansCreated: 0,
      plansSynced: 0,
      takeCuesInserted: 0,
      takesSynthesized: 0,
      trackFindingIdsFilled: 0,
    });
    expect(await snapshot(db)).toBe(before);
    expect(await rowCount(db, "recordings")).toBe(rowCounts.recordings);
    expect(await rowCount(db, "recording_cues")).toBe(rowCounts.cues);
    expect(await rowCount(db, "mixtape_clips")).toBe(rowCounts.clips);
  });

  it("preserves every pre-existing row (nothing deleted)", async () => {
    await backfillPlanRecordingMixtape(db);

    // All 3 mixtapes, all 4 members, the 1 clip survive.
    expect(await rowCount(db, "mixtapes")).toBe(3);
    expect(await rowCount(db, "mixtape_tracks")).toBe(4);
    expect(await rowCount(db, "mixtape_clips")).toBe(1);
    // 2 seeded recordings (#1 + rolling) + M2's synthesized take + the draft's plan.
    expect(await rowCount(db, "recordings")).toBe(4);
  });

  it("no-ops cleanly on an empty database", async () => {
    const empty = await createIntegrationDb();
    const result = await backfillPlanRecordingMixtape(empty);

    expect(result.plansCreated).toBe(0);
    expect(result.takesSynthesized).toBe(0);
    expect(await rowCount(empty, "recordings")).toBe(0);
  });
});

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE PIPELINE'S WORK QUEUES, PROVEN — against the REAL schema, on a real libSQL engine.
//
// Two claims are on trial here, and both are claims the previous code got WRONG:
//
//   1. A CATALOGUE TRACK IS WORKABLE. The three sweeps used to read their worklists off
//      `listTracks`, which drives through the FINDING JOIN — so a `tracks` row with no
//      `findings` row was structurally invisible to capture, analysis, and embedding. It
//      could never get a vector, and The Ear ranks by vector, so the whole feature had
//      nothing to rank. These cases seed catalogue tracks and assert the queues SEE them.
//
//   2. THE ORDER IS THE BUDGET. Audio capture bills per GB, so the drain order decides what
//      the money buys. It must be `capture_priority` DESC (with the findings ahead of the
//      catalogue) — never insertion order, never alphabetical. And a label the operator
//      RULED OUT must not be captured AT ALL: `it("never hands a VETOED label to the capture
//      queue")` is the case that a "sort it last" implementation cannot pass, because a
//      queue drains and last eventually arrives.
//
// The ordering is done by SQL, so only a real engine can prove it. Mocks cannot.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

/** Give a track captured audio (and, optionally, an existing analysis / vector). */
async function withAudio(
  trackId: string,
  fields: { analyzedFrom?: "full" | "preview"; embedding?: boolean } = {},
): Promise<void> {
  await db.execute({
    args: [
      `${trackId}/sha.webm`,
      fields.analyzedFrom ?? null,
      fields.analyzedFrom ? "2026-07-01T00:00:00.000Z" : null,
      fields.embedding ? JSON.stringify(Array.from({ length: 1024 }, () => 0.01)) : null,
      trackId,
    ],
    sql: `update tracks
          set source_audio_key = ?, analyzed_from = ?, analyzed_at = ?, embedding_json = ?,
              capture_status = 'done'
          where track_id = ?`,
  });
}

/** Stamp a catalogue row's Ear-assigned capture tier (what `rank_catalogue` writes). */
async function withPriority(trackId: string, priority: number): Promise<void> {
  await db.execute({
    args: [priority, trackId],
    sql: `update tracks set capture_priority = ? where track_id = ?`,
  });
}

async function seedDisabledLabel(name: string, slug: string): Promise<void> {
  await db.execute({
    args: [`lbl-${slug}`, name, slug],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, 'disabled', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("listTrackWork — the catalogue is workable", () => {
  it("embeds a CATALOGUE track: the queue the finding join used to hide it from", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { title: "Uncertified", trackId: "cat0000000000000000000" });
    await withAudio("cat0000000000000000000");

    const work = await listTrackWork({ kind: "embed" });

    // Under the old `findings join tracks` worklist this array was EMPTY — which is the
    // entire bug: no vector, so The Ear had nothing to rank.
    expect(work.map((item) => item.trackId)).toEqual(["cat0000000000000000000"]);
    expect(work[0]?.certified).toBe(false);
    expect(work[0]?.logId).toBeNull();
  });

  it("analyses a CATALOGUE track, and drops it once analysed from the FULL song", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat0000000000000000000" });
    await withAudio("cat0000000000000000000");

    expect((await listTrackWork({ kind: "analyze" })).map((i) => i.trackId)).toEqual([
      "cat0000000000000000000",
    ]);

    // The analyze queue is DATA-derived, not status-derived — a catalogue track has no
    // `enrichment_status` (that lives on the certification), so the queue reads the columns
    // that actually say whether the work is done.
    await withAudio("cat0000000000000000000", { analyzedFrom: "full" });
    expect(await listTrackWork({ kind: "analyze" })).toEqual([]);

    // A PREVIEW-grade analysis is not done: the captured song is the better source, and
    // re-deriving from it is the whole point of having bought the bytes.
    await withAudio("cat0000000000000000000", { analyzedFrom: "preview" });
    expect((await listTrackWork({ kind: "analyze" })).map((i) => i.trackId)).toEqual([
      "cat0000000000000000000",
    ]);
  });

  it("never queues a track with no captured audio for analyze/embed", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat0000000000000000000" });

    // No `source_audio_key` on either. A 30s preview is never an admissible source (a
    // preview vector is garbage — ratified), so "no audio" means "no work", not "fall back".
    expect(await listTrackWork({ kind: "analyze" })).toEqual([]);
    expect(await listTrackWork({ kind: "embed" })).toEqual([]);
  });

  it("honours the scope: findings-only, catalogue-only, or both", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat0000000000000000000" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withAudio("cat0000000000000000000");

    const ids = async (scope: "all" | "catalogue" | "findings") =>
      (await listTrackWork({ kind: "embed", scope })).map((item) => item.trackId);

    expect(await ids("findings")).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
    expect(await ids("catalogue")).toEqual(["cat0000000000000000000"]);
    expect(await ids("all")).toEqual(["aaaaaaaaaaaaaaaaaaaaaa", "cat0000000000000000000"]);
  });
});

describe("listTrackWork — the order is the budget", () => {
  it("drains in capture_priority order, NOT insertion or alphabetical order", async () => {
    const { listTrackWork } = await import("./track-work");

    // Seeded in ASCENDING id order and with priorities that DISAGREE with it, so a queue
    // that drained by insertion order (or by id, or by title) would return them backwards.
    await seedCatalogueTrack(db, { title: "Aaa Nothing", trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { title: "Bbb Seed", trackId: "cat2000000000000000000" });
    await seedCatalogueTrack(db, { title: "Ccc Label", trackId: "cat3000000000000000000" });
    await seedCatalogueTrack(db, { title: "Ddd Artist", trackId: "cat4000000000000000000" });

    await withPriority("cat1000000000000000000", 0); // none
    await withPriority("cat2000000000000000000", 1); // seed-label
    await withPriority("cat3000000000000000000", 2); // label carries a finding
    await withPriority("cat4000000000000000000", 3); // an artist he has logged

    const work = await listTrackWork({ kind: "capture" });

    expect(work.map((item) => item.trackId)).toEqual([
      "cat4000000000000000000", // artist — the strongest signal there is
      "cat3000000000000000000", // label
      "cat2000000000000000000", // seed-label
      "cat1000000000000000000", // nothing
    ]);
    expect(work.map((item) => item.capturePriority)).toEqual([3, 2, 1, 0]);
  });

  it("never hands a VETOED label to the capture queue — the money is never spent", async () => {
    const { listTrackWork } = await import("./track-work");
    const { rankCatalogue } = await import("./catalogue");

    // The real shape that caught this: every one of the operator's disabled labels CARRIES a
    // finding (each arrived on a single crossover remix). So the `label` rung fires on them,
    // and without a veto the metered per-GB budget goes on trance.
    await seedDisabledLabel("Anjunabeats", "anjunabeats");
    await seedTrack(db, {
      artists: ["Some Trance Act"],
      label: "Anjunabeats",
      logId: "004.7.2I",
      title: "The Crossover Remix",
      trackId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await seedCatalogueTrack(db, {
      artists: ["Another Trance Act"],
      label: "Anjunabeats",
      title: "More Trance",
      trackId: "cat1000000000000000000",
    });
    await seedCatalogueTrack(db, {
      artists: ["Nobody We Know"],
      label: "Some Unknown Label",
      title: "In Our Lane, Unproven",
      trackId: "cat2000000000000000000",
    });

    // The Ear's sweep writes the tiers — and the veto gets its OWN tier (−1), which is the
    // only reason SQL can tell it apart from `none`'s 0.
    await rankCatalogue();

    const priorities = await db.execute(
      `select track_id, capture_priority from tracks where track_id like 'cat%' order by track_id`,
    );
    expect(priorities.rows.map((row) => Number(row.capture_priority))).toEqual([-1, 0]);

    // THE PROOF. The vetoed track is not merely ordered last — it is NOT IN THE QUEUE. A veto
    // that only sorts last is not a veto: the queue drains, and last eventually arrives.
    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((item) => item.trackId)).toEqual(["cat2000000000000000000"]);
  });

  it("still MEASURES a vetoed track whose bytes are already bought", async () => {
    const { listTrackWork } = await import("./track-work");

    // The ruling governs ACQUISITION (docs/label-entity.md — a capture IS an acquisition),
    // not measurement. If the audio is already on file, analysing and embedding it is free,
    // and the resulting vector is how The Ear gets to disagree with the ladder. So the veto
    // is scoped to `capture` and the row simply sorts last in the other two queues.
    await seedCatalogueTrack(db, { label: "Anjunabeats", trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { label: "Hospital", trackId: "cat2000000000000000000" });
    await withAudio("cat1000000000000000000");
    await withAudio("cat2000000000000000000");
    await withPriority("cat1000000000000000000", -1); // the veto
    await withPriority("cat2000000000000000000", 2); // a label he has found on

    const work = await listTrackWork({ kind: "embed" });

    expect(work.map((item) => item.trackId)).toEqual([
      "cat2000000000000000000",
      "cat1000000000000000000", // present, and LAST
    ]);
  });

  it("puts CERTIFIED work ahead of the whole catalogue — the telescope can never starve it", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "zzz1000000000000000000" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withAudio("zzz1000000000000000000");
    // The catalogue row carries the TOP rung, and still loses: Fluncle already said yes to
    // the finding. A speculative row never gets in front of a track he has been to.
    await withPriority("zzz1000000000000000000", 3);

    const work = await listTrackWork({ kind: "embed" });

    expect(work.map((item) => item.trackId)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
      "zzz1000000000000000000",
    ]);
    expect(work.map((item) => item.certified)).toEqual([true, false]);
  });

  it("keeps an UNRANKED catalogue row out of the capture queue — rank first, then spend", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    // No `capture_priority`: the Ear's sweep has not looked at it. Capturing it now would BE
    // draining the queue in insertion order — the exact failure the priority exists to stop.
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);

    await withPriority("cat1000000000000000000", 1);
    expect((await listTrackWork({ kind: "capture", scope: "catalogue" })).length).toBe(1);
  });

  it("keeps a coordinate-less FINDING out of the capture queue (the R2 key needs a Log ID)", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: null, trackId: "aaaaaaaaaaaaaaaaaaaaaa" });

    expect(await listTrackWork({ kind: "capture", scope: "findings" })).toEqual([]);
  });

  it("drops a track from the capture queue once its capture is terminal", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    expect((await listTrackWork({ kind: "capture" })).length).toBe(1);

    for (const status of ["done", "unmatched"]) {
      await db.execute({
        args: [status],
        sql: `update tracks set capture_status = ? where track_id = 'aaaaaaaaaaaaaaaaaaaaaa'`,
      });
      expect(await listTrackWork({ kind: "capture" })).toEqual([]);
    }
  });
});

describe("listTrackWork — the wire", () => {
  it("carries only identity + the two facts a sweep acts on; no vector, no note", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, {
      artists: ["Krakota"],
      label: "Hospital",
      title: "See For Miles",
      trackId: "cat1000000000000000000",
    });
    await withAudio("cat1000000000000000000", { embedding: false });

    const [item] = await listTrackWork({ kind: "embed" });

    expect(item).toEqual({
      artists: ["Krakota"],
      capturePriority: null,
      certified: false,
      durationMs: 0,
      isrc: null,
      label: "Hospital",
      logId: null,
      sourceAudioKey: "cat1000000000000000000/sha.webm",
      title: "See For Miles",
      trackId: "cat1000000000000000000",
    });
  });

  it("drops an embedded track from the embed queue (idempotent by construction)", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000", { embedding: true });

    expect(await listTrackWork({ kind: "embed" })).toEqual([]);
  });
});

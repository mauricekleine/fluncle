import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE PIPELINE'S WORK QUEUES, PROVEN — against the REAL schema, on a real libSQL engine.
//
// Three claims are on trial here, and the first two are claims the previous code got WRONG:
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
//   3. …AND THE ORDER IS NOT THE WHOLE BUDGET. The order decides WHAT the metered GB buy; it
//      has nothing to say about HOW MUCH, and at catalogue scale that gap is the one that
//      costs real money. The CAPTURE BUDGET (./capture-budget.ts) is the how-much, and the
//      final describe block proves the three properties it has to have: the budget STOPS the
//      sweep when it is spent, the kill switch stops it in ONE flip and is default-deny, and
//      a CERTIFIED finding still captures normally when the catalogue budget is gone.
//
// The ordering and the gating are done in SQL, so only a real engine can prove them. Mocks
// cannot. NO AUDIO IS DOWNLOADED ANYWHERE IN THIS SUITE — the queue is the thing under test,
// and the queue is the thing that decides whether a download ever happens.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

/**
 * Open the catalogue capture budget — the ONE flip.
 *
 * Almost every catalogue-capture case below has to call this first, and that is not a test
 * inconvenience: it is the shipped default asserting itself. The feature is DEFAULT-DENY, so
 * an untouched database (a fresh deploy, a preview branch, this test file before its first
 * line runs) hands out NO catalogue capture work at all.
 */
async function openCaptureBudget(): Promise<void> {
  const { setCatalogueCapturePaused } = await import("./capture-budget");

  await setCatalogueCapturePaused(false);
}

/** Simulate N catalogue captures inside the rolling window — the spend, without the spending. */
async function spendCatalogueCaptures(count: number, bytesEach = 1_000_000): Promise<void> {
  const at = new Date().toISOString();

  for (let index = 0; index < count; index += 1) {
    const trackId = `spent${String(index).padStart(17, "0")}`;

    await seedCatalogueTrack(db, { trackId });
    await db.execute({
      args: [at, at, bytesEach, trackId],
      sql: `update tracks
            set capture_status = 'done', source_audio_key = 'k/x.webm',
                source_audio_attempted_at = ?, source_audio_captured_at = ?,
                source_audio_bytes = ?
            where track_id = ?`,
    });
  }
}

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

    await openCaptureBudget();

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

    await openCaptureBudget();

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

    await openCaptureBudget();

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

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE BRAKE. Three properties, and the whole feature is worthless without all three.
//
// The brake lives HERE, at the queue, rather than in the sweep that downloads — and these
// cases are why that matters. `listTrackWork` is the only door a catalogue row can reach a
// metered download through, so a brake on this function binds EVERY client: the box sweep,
// the CLI, a future sweep nobody has written yet. A brake inside the box script would be
// re-bakeable, bypassable, and one `curl` away from irrelevant.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("listTrackWork — the capture budget stops the money", () => {
  it("PROOF 1 — the budget STOPS the sweep once it is spent", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCaptureBudget } = await import("./capture-budget");

    await openCaptureBudget();
    await setCatalogueCaptureBudget({ dailyBytes: 1024 * 1024 * 1024, dailyTracks: 3 });

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    // Budget intact: the queue hands the track over, and the sweep would buy its audio.
    expect((await listTrackWork({ kind: "capture", scope: "catalogue" })).length).toBe(1);

    // Now spend the day's 3. Nothing else changes — the track is still ranked, still
    // non-vetoed, still top of the ladder, still the very next thing the money should buy.
    await spendCatalogueCaptures(3);

    // And the queue is EMPTY. Not reordered, not deferred — empty. The sweep reads an empty
    // batch and downloads nothing, which is the only mechanism that actually stops a bill.
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });

  it("PROOF 1b — the BYTE cap stops it too, with count to spare", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCaptureBudget } = await import("./capture-budget");

    await openCaptureBudget();
    await setCatalogueCaptureBudget({ dailyBytes: 10_000_000, dailyTracks: 500 });

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    // Two fat files: 2 of 500 tracks (the count cap is nowhere near), 10 MB of 10 MB. The
    // count cap cannot see this — a file's size is knowable only AFTER it is downloaded —
    // and the byte cap is exactly the backstop for it.
    await spendCatalogueCaptures(2, 5_000_000);

    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });

  it("PROOF 2 — the kill switch stops it in ONE flip, and is DEFAULT-DENY", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    // DEFAULT-DENY, and this is the assertion the whole "ships OFF" decision rests on: NOTHING
    // has been configured. No settings row exists. This is what a fresh deploy, a preview
    // branch, a restored backup, and a dropped `settings` table all look like — and every one
    // of them must hand out zero metered work rather than draining the catalogue.
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);

    // ONE flip opens it. No deploy, no rebuild, no box re-bake.
    await setCatalogueCapturePaused(false);
    expect((await listTrackWork({ kind: "capture", scope: "catalogue" })).length).toBe(1);

    // ONE flip shuts it again — effective on the very next queue read, with a full budget
    // still unspent underneath. That is the 3am property: the operator sees the bill climbing
    // and stops it in one move, without shipping anything.
    await setCatalogueCapturePaused(true);
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });

  it("PROOF 3 — a CERTIFIED finding still captures when the catalogue budget is gone", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCaptureBudget } = await import("./capture-budget");

    await openCaptureBudget();
    await setCatalogueCaptureBudget({ dailyBytes: 1, dailyTracks: 0 });

    await seedTrack(db, {
      logId: "004.7.2I",
      title: "A Real Banger",
      trackId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    // THE ARCHIVE IS NEVER STARVED BY THE TELESCOPE. The catalogue budget is at zero — the
    // hardest possible shut — and the finding is handed over anyway, in its usual order. His
    // capture is a handful a week, it was never the spend, and it is not this budget's business.
    const work = await listTrackWork({ kind: "capture" });

    expect(work.map((item) => item.trackId)).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
    expect(work[0]?.certified).toBe(true);

    // The brake NARROWS the queue to the findings; it never empties it. A `scope: "findings"`
    // read is not gated at all — the budget cannot even see that half.
    expect((await listTrackWork({ kind: "capture", scope: "findings" })).length).toBe(1);
  });

  it("PROOF 3b — and the same holds under the KILL SWITCH, not just a spent cap", async () => {
    const { listTrackWork } = await import("./track-work");

    // Nothing configured ⇒ paused (default-deny). The finding must still capture: shipping the
    // catalogue half dark must be invisible to the pipeline that was already running.
    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    expect((await listTrackWork({ kind: "capture" })).map((item) => item.trackId)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("gates CAPTURE alone — bytes already bought are free to analyse and embed", async () => {
    const { listTrackWork } = await import("./track-work");

    // The budget is shut (default-deny, nothing configured). A catalogue track whose audio is
    // ALREADY on file cost its money long ago; measuring it now spends nothing, and its vector
    // is how The Ear gets to disagree with the ladder. Gating analyse/embed on a CAPTURE budget
    // would be throwing away bytes he has already paid for — the same reasoning that scopes the
    // label veto to capture alone.
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");

    expect((await listTrackWork({ kind: "analyze" })).length).toBe(1);
    expect((await listTrackWork({ kind: "embed" })).length).toBe(1);
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });
});

describe("countTrackWork — how big is the backlog, not how big is the page", () => {
  it("counts the WHOLE queue, past the page ceiling a read is capped at", async () => {
    const { countTrackWork, listTrackWork } = await import("./track-work");

    // A page read is capped at 200 rows, so `tracks.length` answers "how many did I get" and
    // never "how much is left". The GPU batch (docs/gpu-batch-embed.md) reports the second number
    // at the end of a run, and the operator rents his next hour off it — a run that says "done"
    // while thousands are still queued is simply lying to him. This is that number.
    for (let index = 0; index < 12; index += 1) {
      const trackId = `cat${String(index).padStart(19, "0")}`;

      await seedCatalogueTrack(db, { trackId });
      await withAudio(trackId);
    }

    expect((await listTrackWork({ kind: "embed", limit: 5 })).length).toBe(5);
    expect(await countTrackWork({ kind: "embed" })).toBe(12);
  });

  it("counts the same predicate the page selects — an embedded track leaves both", async () => {
    const { countTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");
    await seedCatalogueTrack(db, { trackId: "cat2000000000000000000" });
    await withAudio("cat2000000000000000000", { embedding: true });

    // The vector is the whole state machine: the embedded one is out of the queue, and out of
    // the count. That equivalence is what makes the batch resumable with nothing checkpointed.
    expect(await countTrackWork({ kind: "embed" })).toBe(1);
  });

  it("honours the scope, so a run over one half reports that half's backlog", async () => {
    const { countTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");

    expect(await countTrackWork({ kind: "embed" })).toBe(2);
    expect(await countTrackWork({ kind: "embed", scope: "findings" })).toBe(1);
    expect(await countTrackWork({ kind: "embed", scope: "catalogue" })).toBe(1);
  });

  it("applies the SAME capture brake as the queue — it cannot advertise work the queue refuses", async () => {
    const { countTrackWork } = await import("./track-work");

    // The budget is shut (default-deny). A count that reported the catalogue backlog anyway
    // would be reporting rows `listTrackWork` will not hand out — a queue and a count that
    // disagree are worse than no count.
    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    expect(await countTrackWork({ kind: "capture", scope: "catalogue" })).toBe(0);
    expect(await countTrackWork({ kind: "capture" })).toBe(1); // narrowed to the findings

    await openCaptureBudget();

    expect(await countTrackWork({ kind: "capture" })).toBe(2);
  });
});

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE EAR'S RANKING, PROVEN — against the REAL schema, with vectors we control.
//
// The claim The Ear makes to the operator is a specific one: "this track is close to THAT
// finding." A ranking nobody verified is a ranking nobody can trust, and the SQL that
// produces it (a cross join through `vector_distance_cos`, a window function picking each
// candidate's single nearest finding) cannot be checked by reading it. So these cases seed
// catalogue tracks whose embeddings are PERTURBATIONS of specific findings' embeddings, run
// the sweep, and assert it picks the finding we know is nearest.
//
// The load-bearing case is `it("ranks by max-similarity to ANY finding, never to a centroid")`.
// Everything else could pass with a centroid ranking; that one cannot. It is the whole
// design decision, executable.
//
// Runs on the in-memory libSQL database built from the generated migrations, so the vector
// SQL under test (`vector32`, `vector_distance_cos`, `row_number() over (partition by …)`)
// is executed by a real engine against the real DDL — not a mock.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;

/** A unit vector pointing along one axis — an "artificial genre" we can aim tracks at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

/** Normalize, so every fixture vector is unit-length like a real MuQ vector. */
function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

/** A vector `weight` of the way from `from` toward `toward` — a controlled near-neighbour. */
function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

/** The dual write the agent-tier `update_track` path performs: JSON + the ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  const json = JSON.stringify(vector);

  await db.execute({
    args: [json, json, trackId],
    sql: `update tracks set embedding_json = ?, embedding_blob = vector32(?) where track_id = ?`,
  });
}

/** A certified finding, optionally embedded. */
async function seedFinding(
  trackId: string,
  options: { artists?: string[]; label?: string; title?: string; vector?: number[] } = {},
): Promise<void> {
  await seedTrack(db, {
    artists: options.artists ?? ["Finding Artist"],
    logId: `00${trackId.slice(-1)}.1.1A`,
    title: options.title ?? `Finding ${trackId}`,
    trackId,
  });

  if (options.label) {
    await db.execute({ args: [options.label, trackId], sql: labelSql });
  }

  if (options.vector) {
    await embed(trackId, options.vector);
  }
}

/** A catalogue track: a `tracks` row with NO `findings` row. Optionally embedded. */
async function seedCatalogue(
  trackId: string,
  options: { artists?: string[]; label?: string; title?: string; vector?: number[] } = {},
): Promise<void> {
  await seedCatalogueTrack(db, {
    artists: options.artists ?? ["Catalogue Artist"],
    title: options.title ?? `Catalogue ${trackId}`,
    trackId,
  });

  if (options.label) {
    await db.execute({ args: [options.label, trackId], sql: labelSql });
  }

  if (options.vector) {
    await embed(trackId, options.vector);
  }
}

const labelSql = `update tracks set label = ? where track_id = ?`;

/** Read a catalogue row's stored ranking columns straight from the table. */
async function rankingOf(trackId: string): Promise<{
  capture_priority: number | null;
  catalogue_rank_corpus: string | null;
  catalogue_ranked_at: string | null;
  nearest_finding_score: number | null;
  nearest_finding_track_id: string | null;
}> {
  const result = await db.execute({
    args: [trackId],
    sql: `select nearest_finding_track_id, nearest_finding_score, capture_priority,
                 catalogue_rank_corpus, catalogue_ranked_at
          from tracks where track_id = ?`,
  });
  const row = result.rows[0];

  return row as unknown as Awaited<ReturnType<typeof rankingOf>>;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("the ranking — the sweep picks the finding we know is nearest", () => {
  it("matches each catalogue track to the finding its vector was perturbed from", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // Three findings, mutually orthogonal — three "regions" of the operator's taste.
    await seedFinding("finding-liquid", { title: "Liquid Finding", vector: axis(0) });
    await seedFinding("finding-neuro", { title: "Neuro Finding", vector: axis(1) });
    await seedFinding("finding-jungle", { title: "Jungle Finding", vector: axis(2) });

    // Three catalogue tracks, each pulled 15% of the way from one finding toward another.
    // Every one is unambiguously nearest the finding it started at.
    await seedCatalogue("cat-liquid", { vector: blend(axis(0), axis(1), 0.15) });
    await seedCatalogue("cat-neuro", { vector: blend(axis(1), axis(2), 0.15) });
    await seedCatalogue("cat-jungle", { vector: blend(axis(2), axis(0), 0.15) });

    const summary = await rankCatalogue();

    expect(summary.scored).toBe(3);
    expect(summary.embeddedFindings).toBe(3);
    expect(summary.remaining).toBe(0);

    expect((await rankingOf("cat-liquid")).nearest_finding_track_id).toBe("finding-liquid");
    expect((await rankingOf("cat-neuro")).nearest_finding_track_id).toBe("finding-neuro");
    expect((await rankingOf("cat-jungle")).nearest_finding_track_id).toBe("finding-jungle");
  });

  it("stores a cosine SIMILARITY (higher is nearer), matching the vectors we chose", async () => {
    const { cosineSimilarity } = await import("./embedding");
    const { rankCatalogue } = await import("./catalogue");

    const near = blend(axis(0), axis(1), 0.05);
    const far = blend(axis(0), axis(1), 0.45);

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-near", { vector: near });
    await seedCatalogue("cat-far", { vector: far });

    await rankCatalogue();

    const nearScore = (await rankingOf("cat-near")).nearest_finding_score;
    const farScore = (await rankingOf("cat-far")).nearest_finding_score;

    // The SQL's `1 - vector_distance_cos` agrees with the pure cosine, to float32 precision
    // (the blob stores float32; the JS math is float64).
    expect(nearScore).toBeCloseTo(cosineSimilarity(near, axis(0)), 4);
    expect(farScore).toBeCloseTo(cosineSimilarity(far, axis(0)), 4);
    // And the nearer track scores HIGHER — the column sorts DESC, so this is the direction
    // the whole surface depends on.
    expect(nearScore ?? 0).toBeGreaterThan(farScore ?? 1);
  });

  it("ranks by max-similarity to ANY finding, never to a centroid", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // THE DESIGN DECISION, MADE EXECUTABLE. The operator's taste is multi-modal: here it is
    // eight findings crowded on one axis and ONE lonely finding on another. The mean of that
    // corpus sits almost exactly on the crowd — a place none of his taste actually lives.
    for (let index = 0; index < 8; index += 1) {
      await seedFinding(`finding-crowd-${index}`, {
        vector: blend(axis(0), axis(index + 10), 0.02),
      });
    }
    await seedFinding("finding-lonely", { vector: axis(5) });

    // A catalogue track that is a DEAD RINGER for the lonely finding (cos ≈ 0.995) — and
    // essentially orthogonal to the crowd, so its similarity to the CENTROID is ~0.1.
    await seedCatalogue("cat-near-lonely", { vector: blend(axis(5), axis(6), 0.07) });
    // A catalogue track that is a mediocre match for the crowd (cos ≈ 0.83) — but the crowd
    // IS the centroid, so a centroid ranking would put this one on top.
    await seedCatalogue("cat-mid-crowd", { vector: blend(axis(0), axis(7), 0.4) });

    await rankCatalogue();

    const lonely = await rankingOf("cat-near-lonely");
    const crowd = await rankingOf("cat-mid-crowd");

    // Max-similarity: the dead ringer matched the LONELY finding, and beats the mediocre
    // crowd-match. Under a centroid ranking this assertion inverts — which is the point.
    expect(lonely.nearest_finding_track_id).toBe("finding-lonely");
    expect(lonely.nearest_finding_score ?? 0).toBeGreaterThan(0.99);
    expect(crowd.nearest_finding_score ?? 0).toBeLessThan(0.9);
    expect(lonely.nearest_finding_score ?? 0).toBeGreaterThan(crowd.nearest_finding_score ?? 1);
  });

  it("never ranks a finding — the sweep's columns stay null on the certification half", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedFinding("finding-b", { vector: axis(1) });
    await seedCatalogue("cat-a", { vector: blend(axis(0), axis(1), 0.1) });

    const summary = await rankCatalogue();

    // Only the ONE catalogue row was a candidate; the two findings were anti-joined out.
    expect(summary.scored).toBe(1);

    for (const findingId of ["finding-a", "finding-b"]) {
      const ranking = await rankingOf(findingId);

      expect(ranking.nearest_finding_score).toBeNull();
      expect(ranking.nearest_finding_track_id).toBeNull();
      expect(ranking.capture_priority).toBeNull();
      expect(ranking.catalogue_rank_corpus).toBeNull();
    }
  });
});

describe("the sweep — batching, staleness, and self-healing", () => {
  it("is a no-op on an unchanged archive, and re-ranks after a finding lands", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-a", { vector: blend(axis(0), axis(1), 0.3) });

    const first = await rankCatalogue();
    expect(first.scored).toBe(1);
    expect(first.corpus).toBe("1:1");
    expect((await rankingOf("cat-a")).nearest_finding_track_id).toBe("finding-a");

    // Nothing changed: the fingerprint matches, so there is no candidate at all.
    const second = await rankCatalogue();
    expect(second.scored).toBe(0);
    expect(second.prioritized).toBe(0);
    expect(second.remaining).toBe(0);

    // A new finding lands, and it is a BETTER match for the catalogue track. The fingerprint
    // moves, the row goes stale on its own, and the next tick re-points it — no invalidation
    // call from the publish path, which is the whole point of the fingerprint.
    await seedFinding("finding-b", { vector: blend(axis(0), axis(1), 0.3) });

    const third = await rankCatalogue();
    expect(third.corpus).toBe("2:2");
    expect(third.scored).toBe(1);
    expect((await rankingOf("cat-a")).nearest_finding_track_id).toBe("finding-b");
    expect((await rankingOf("cat-a")).nearest_finding_score ?? 0).toBeCloseTo(1, 4);
  });

  it("drains a backlog in batches, reporting what is left", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    for (let index = 0; index < 5; index += 1) {
      await seedCatalogue(`cat-${index}`, { vector: blend(axis(0), axis(index + 1), 0.2) });
    }

    const first = await rankCatalogue(2);
    expect(first.scored).toBe(2);
    expect(first.remaining).toBe(3);

    const second = await rankCatalogue(2);
    expect(second.scored).toBe(2);
    expect(second.remaining).toBe(1);

    const third = await rankCatalogue(2);
    expect(third.scored).toBe(1);
    expect(third.remaining).toBe(0);
  });

  it("stamps a row it cannot score, so a hopeless row is never re-picked forever", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // No finding is embedded, so nothing can be a nearest neighbour.
    await seedFinding("finding-a");
    await seedCatalogue("cat-a", { vector: axis(0) });

    const summary = await rankCatalogue();

    expect(summary.embeddedFindings).toBe(0);
    expect(summary.scored).toBe(1);
    // Stamped, with an honest null score — not left stale to be re-picked every tick.
    const ranking = await rankingOf("cat-a");
    expect(ranking.nearest_finding_score).toBeNull();
    expect(ranking.catalogue_rank_corpus).toBe("1:0");
    expect(summary.remaining).toBe(0);
  });
});

describe("the capture queue — the pre-audio priority ladder", () => {
  beforeEach(async () => {
    await seedFinding("finding-a", {
      artists: ["Krakota"],
      label: "Hospital Records",
      vector: axis(0),
    });
    // A label the operator rules the crawler may seed from, carrying no finding yet.
    await db.execute({
      args: ["lbl-seed", "Critical Music", "critical-music", "enabled"],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values (?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    });
    // And the real shape of the veto: a label the operator ruled OUT that nonetheless CARRIES
    // a finding — a crossover remix. All 8 disabled labels in the live archive look like this.
    await seedFinding("finding-crossover", { artists: ["Above & Beyond"], label: "Anjunabeats" });
    await db.execute({
      args: ["lbl-out", "Anjunabeats", "anjunabeats", "disabled"],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values (?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    });
  });

  it("tiers an un-embedded catalogue track by how close its METADATA sits to the archive", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // No vectors on any of these — they have never been captured, which is exactly why the
    // Ear cannot rank them and this ladder has to.
    await seedCatalogue("cat-artist", { artists: ["Krakota"], label: "Some Other Label" });
    await seedCatalogue("cat-label", { artists: ["Nobody"], label: "hospital records." });
    await seedCatalogue("cat-seed", { artists: ["Nobody"], label: "Critical Music" });
    await seedCatalogue("cat-none", { artists: ["Nobody"], label: "Nobody's Imprint" });
    // The veto, on real archive shape: Anjunabeats CARRIES a finding (the crossover above) and
    // is RULED OUT. Without the veto this is tier 2 and the capture budget buys trance.
    await seedCatalogue("cat-vetoed", { artists: ["Krakota"], label: "Anjunabeats" });

    const summary = await rankCatalogue();

    expect(summary.prioritized).toBe(5);
    expect(summary.scored).toBe(0);

    // 3 — an artist already on a finding. The strongest signal there is.
    expect((await rankingOf("cat-artist")).capture_priority).toBe(3);
    // 2 — its label already carries a finding. Note the fold: `hospital records.` and
    // `Hospital Records` are one label, the same way they are everywhere else in the archive.
    expect((await rankingOf("cat-label")).capture_priority).toBe(2);
    // 1 — in-lane but unproven: a label the operator seeds from, nothing certified on it yet.
    expect((await rankingOf("cat-seed")).capture_priority).toBe(1);
    // 0 — nothing ties it to the archive.
    expect((await rankingOf("cat-none")).capture_priority).toBe(0);
    // 0 — VETOED. Its label carries a finding AND its artist is on a finding, and the operator
    // still said "not our lane". His ruling beats both signals; the row stays, ranked last.
    expect((await rankingOf("cat-vetoed")).capture_priority).toBe(0);
  });

  it("keeps the two lenses disjoint — a track with audio leaves the capture queue", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-hungry", { artists: ["Krakota"] });
    await seedCatalogue("cat-fed", { artists: ["Krakota"], vector: blend(axis(0), axis(1), 0.2) });

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    const capture = await listCatalogueTracks("capture");

    // The embedded one is in The Ear and NOT in the capture queue (it has already been
    // captured — capturing it again is the one thing the queue must never ask for).
    expect(ear.map((track) => track.trackId)).toEqual(["cat-fed"]);
    expect(capture.map((track) => track.trackId)).toEqual(["cat-hungry"]);
    expect((await rankingOf("cat-fed")).capture_priority).toBeNull();
  });
});

describe("the read — the ranked page, and the WHY on every row", () => {
  it("orders The Ear by score, DESC, and carries the finding each row matched", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-krakota", {
      artists: ["Krakota"],
      title: "See For Miles",
      vector: axis(0),
    });
    await seedFinding("finding-nutone", {
      artists: ["Nu:Tone"],
      title: "Heaven's Gate",
      vector: axis(1),
    });

    await seedCatalogue("cat-best", { vector: blend(axis(1), axis(2), 0.06) });
    await seedCatalogue("cat-mid", { vector: blend(axis(0), axis(2), 0.25) });
    await seedCatalogue("cat-worst", { vector: blend(axis(0), axis(2), 0.5) });

    await rankCatalogue();

    const page = await listCatalogueTracks("ear");

    expect(page.map((track) => track.trackId)).toEqual(["cat-best", "cat-mid", "cat-worst"]);

    // THE WHY. Not a bare score: the row names the finding it matched, hydrated with the
    // title, the artists, and the coordinate — the sentence the operator actually reads.
    const best = page[0];
    expect(best?.nearestFinding?.trackId).toBe("finding-nutone");
    expect(best?.nearestFinding?.title).toBe("Heaven's Gate");
    expect(best?.nearestFinding?.artists).toEqual(["Nu:Tone"]);
    expect(best?.nearestFinding?.logId).toBeTruthy();
    expect(best?.nearestFindingScore ?? 0).toBeGreaterThan(0.99);

    expect(page[1]?.nearestFinding?.trackId).toBe("finding-krakota");
  });

  it("orders the capture queue by priority, DESC, and carries the reason for each rung", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { artists: ["Krakota"], label: "Hospital Records" });
    await seedCatalogue("cat-none", { artists: ["Nobody"] });
    await seedCatalogue("cat-artist", { artists: ["Krakota"] });
    await seedCatalogue("cat-label", { artists: ["Nobody"], label: "Hospital Records" });

    await rankCatalogue();

    const page = await listCatalogueTracks("capture");

    expect(page.map((track) => track.trackId)).toEqual(["cat-artist", "cat-label", "cat-none"]);
    // The ladder rung is re-derived through the SAME pure function the sweep used to WRITE
    // the tier, so the sort key and the explanation cannot drift apart.
    expect(page[0]?.captureReason).toEqual({ kind: "artist", name: "Krakota" });
    expect(page[1]?.captureReason).toEqual({ kind: "label", name: "Hospital Records" });
    expect(page[2]?.captureReason).toEqual({ kind: "none", name: null });
  });

  it("shows nothing at all when the catalogue is empty — the honest state today", async () => {
    const { getCatalogueSummary, listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    const summary = await rankCatalogue();
    expect(summary.scored).toBe(0);
    expect(summary.prioritized).toBe(0);

    expect(await listCatalogueTracks("ear")).toEqual([]);
    expect(await listCatalogueTracks("capture")).toEqual([]);
    expect(await getCatalogueSummary()).toEqual({
      awaitingCapture: 0,
      awaitingRank: 0,
      ranked: 0,
      total: 0,
    });
  });

  it("counts the catalogue's shape without scanning it", async () => {
    const { getCatalogueSummary, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-scored", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-hungry");
    await seedCatalogue("cat-unranked");

    await rankCatalogue(2);

    const summary = await getCatalogueSummary();

    expect(summary.total).toBe(3);
    expect(summary.ranked).toBe(1);
    expect(summary.awaitingCapture).toBe(1);
    // The third row never made it into the batch of 2 — it has no fingerprint at all.
    expect(summary.awaitingRank).toBe(1);
  });
});

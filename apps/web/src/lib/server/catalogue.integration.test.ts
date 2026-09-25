import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { qualifiedArtistsDigest } from "./catalogue";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import {
  updateTrackDuplicateIsrcStatement,
  upsertTrackDuplicateKeyStatement,
} from "./track-duplicate-keys";

const EMPTY_DIGEST = qualifiedArtistsDigest([]);

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;

function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

async function embed(trackId: string, vector: number[]): Promise<void> {
  await seedEmbedding(db, trackId, vector);
}

type SeedOptions = {
  artists?: string[];
  isrc?: string;
  key?: string;
  label?: string;
  releaseDate?: string;
  title?: string;
  vector?: number[];
};

async function seedFinding(trackId: string, options: SeedOptions = {}): Promise<void> {
  await seedTrack(db, {
    artists: options.artists ?? ["Finding Artist"],
    logId: `00${trackId.slice(-1)}.1.1A`,
    title: options.title ?? `Finding ${trackId}`,
    trackId,
  });

  await applySeedOptions(trackId, options);
}

async function seedCatalogue(trackId: string, options: SeedOptions = {}): Promise<void> {
  await seedCatalogueTrack(db, {
    artists: options.artists ?? ["Catalogue Artist"],
    title: options.title ?? `Catalogue ${trackId}`,
    trackId,
  });

  await applySeedOptions(trackId, options);
}

async function applySeedOptions(trackId: string, options: SeedOptions): Promise<void> {
  if (options.label) {
    await db.execute({ args: [options.label, trackId], sql: labelSql });
  }

  if (options.isrc) {
    await setIsrc(trackId, options.isrc);
  }

  if (options.releaseDate) {
    await db.execute({
      args: [options.releaseDate, trackId],
      sql: "update tracks set release_date = ? where track_id = ?",
    });
  }

  if (options.key) {
    await db.execute({
      args: [options.key, trackId],
      sql: 'update tracks set "key" = ? where track_id = ?',
    });
  }

  if (options.vector) {
    await embed(trackId, options.vector);
  }
}

const labelSql = `update tracks set label = ? where track_id = ?`;
async function setIsrc(trackId: string, isrc: string): Promise<void> {
  await db.batch(
    [
      { args: [isrc, trackId], sql: `update tracks set isrc = ?, has_isrc = 1 where track_id = ?` },
      updateTrackDuplicateIsrcStatement(trackId, isrc),
    ],
    "write",
  );
}

async function seedArtistRow(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
          values (?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

async function edge(
  trackId: string,
  artistId: string,
  position = 0,
  role: null | "remixer" = null,
): Promise<void> {
  await db.execute({
    args: [trackId, artistId, position, role],
    sql: `insert into track_artists (track_id, artist_id, position, role) values (?, ?, ?, ?)`,
  });
}

async function linkLabel(trackId: string, labelId: string): Promise<void> {
  await db.execute({
    args: [labelId, trackId],
    sql: `update tracks set label_id = ? where track_id = ?`,
  });
}

async function ruleLabel(
  id: string,
  name: string,
  slug: string,
  seedState: "disabled" | "enabled" | "undecided",
): Promise<void> {
  await db.execute({
    args: [id, name, slug, seedState],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

async function rankingOf(trackId: string): Promise<{
  capture_priority: number | null;
  catalogue_rank_corpus: string | null;
  catalogue_ranked_at: string | null;
  duplicate_of_track_id: string | null;
  nearest_finding_score: number | null;
  nearest_finding_track_id: string | null;
}> {
  const result = await db.execute({
    args: [trackId],
    sql: `select nearest_finding_track_id, nearest_finding_score, capture_priority,
                 catalogue_rank_corpus, catalogue_ranked_at, duplicate_of_track_id
          from tracks where track_id = ?`,
  });
  const row = result.rows[0];

  return row as unknown as Awaited<ReturnType<typeof rankingOf>>;
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-catalogue-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("the ranking — the sweep picks the finding we know is nearest", () => {
  it("matches each catalogue track to the finding its vector was perturbed from", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-liquid", { title: "Liquid Finding", vector: axis(0) });
    await seedFinding("finding-neuro", { title: "Neuro Finding", vector: axis(1) });
    await seedFinding("finding-jungle", { title: "Jungle Finding", vector: axis(2) });

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

    expect(nearScore).toBeCloseTo(cosineSimilarity(near, axis(0)), 4);
    expect(farScore).toBeCloseTo(cosineSimilarity(far, axis(0)), 4);

    expect(nearScore ?? 0).toBeGreaterThan(farScore ?? 1);
  });

  it("ranks by max-similarity to ANY finding, never to a centroid", async () => {
    const { rankCatalogue } = await import("./catalogue");

    for (let index = 0; index < 8; index += 1) {
      await seedFinding(`finding-crowd-${index}`, {
        vector: blend(axis(0), axis(index + 10), 0.02),
      });
    }
    await seedFinding("finding-lonely", { vector: axis(5) });

    await seedCatalogue("cat-near-lonely", { vector: blend(axis(5), axis(6), 0.07) });

    await seedCatalogue("cat-mid-crowd", { vector: blend(axis(0), axis(7), 0.4) });

    await rankCatalogue();

    const lonely = await rankingOf("cat-near-lonely");
    const crowd = await rankingOf("cat-mid-crowd");

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
    expect(first.corpus).toMatch(new RegExp(`^v6:1:1:0:${EMPTY_DIGEST}:[0-9a-f]{16}$`));
    expect((await rankingOf("cat-a")).nearest_finding_track_id).toBe("finding-a");

    const second = await rankCatalogue();
    expect(second.scored).toBe(0);
    expect(second.prioritized).toBe(0);
    expect(second.remaining).toBe(0);

    await seedFinding("finding-b", { vector: blend(axis(0), axis(1), 0.4) });

    const third = await rankCatalogue();
    expect(third.corpus).toMatch(new RegExp(`^v6:2:2:0:${EMPTY_DIGEST}:[0-9a-f]{16}$`));
    expect(third.scored).toBe(1);
    expect(third.quarantined).toBe(0);
    expect((await rankingOf("cat-a")).nearest_finding_track_id).toBe("finding-b");

    expect((await rankingOf("cat-a")).nearest_finding_score ?? 0).toBeGreaterThan(0.95);
  });

  it("drains a backlog in batches via the fullness SENTINEL (no per-tick COUNT)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    for (let index = 0; index < 5; index += 1) {
      await seedCatalogue(`cat-${index}`, { vector: blend(axis(0), axis(index + 1), 0.2) });
    }

    const first = await rankCatalogue(2);
    expect(first.scored).toBe(2);
    expect(first.remaining).toBeGreaterThan(0);

    const second = await rankCatalogue(2);
    expect(second.scored).toBe(2);
    expect(second.remaining).toBeGreaterThan(0);

    const third = await rankCatalogue(2);
    expect(third.scored).toBe(1);
    expect(third.remaining).toBe(0);

    for (let index = 0; index < 5; index += 1) {
      expect((await rankingOf(`cat-${index}`)).nearest_finding_track_id).toBe("finding-a");
    }
  });

  it("shapes rank maintenance at the 500-subject due-work API boundary", async () => {
    const { rankCatalogue } = await import("./catalogue");

    const batchSize = 501;
    const transaction = await db.transaction("write");
    try {
      for (let index = 0; index < batchSize; index += 1) {
        const trackId = `cat-wide-${String(index).padStart(3, "0")}`;
        await seedCatalogueTrack(transaction, {
          artists: ["Catalogue Artist"],
          title: `Catalogue ${trackId}`,
          trackId,
        });
      }
      await transaction.commit();
    } finally {
      transaction.close();
    }

    const batchSpy = vi.spyOn(db, "batch");
    const summary = await rankCatalogue(batchSize);

    expect(summary.prioritized).toBe(batchSize);
    expect(summary.remaining).toBeGreaterThan(0);

    const rankBatch = batchSpy.mock.calls.find(([statements]) =>
      statements.some((statement) =>
        String(
          typeof statement === "string"
            ? statement
            : Array.isArray(statement)
              ? statement[0]
              : statement.sql,
        ).includes("catalogue_rank_corpus"),
      ),
    )?.[0];
    expect(rankBatch).toBeDefined();

    const sourceRepairRows = (rankBatch ?? [])
      .filter(
        (statement) =>
          typeof statement !== "string" &&
          !Array.isArray(statement) &&
          statement.sql.includes("insert into due_work") &&
          statement.sql.includes("tracks.capture_priority is not written.column2"),
      )
      .map((statement) =>
        typeof statement === "string" || Array.isArray(statement)
          ? 0
          : statement.sql.split("(?, ?, ?, ?, ?, ?, ?, ?)").length - 1,
      );
    expect(sourceRepairRows).toEqual([500, 1]);
    expect(
      (rankBatch ?? []).every(
        (statement) =>
          typeof statement === "string" ||
          Array.isArray(statement) ||
          !statement.sql.toLowerCase().includes("union all"),
      ),
    ).toBe(true);
    batchSpy.mockRestore();

    const retry = await rankCatalogue(batchSize);
    expect(retry.prioritized).toBe(0);
    expect(retry.scored).toBe(0);

    const sourceRepairs = await db.execute(`select count(*) as n from due_work
      where work_kind = 'source-repair' and subject_type = 'track'
        and subject_id like 'cat-wide-%'`);
    expect(Number(sourceRepairs.rows[0]?.n ?? 0)).toBe(batchSize);

    const publicRepairs = await db.execute(`select projection, count(*) as n
      from projection_repairs
      where subject_type = 'track' and subject_id like 'cat-wide-%'
      group by projection
      order by projection`);
    expect(publicRepairs.rows).toEqual([]);
    expect((await db.execute(`select scope from public_aggregate_state`)).rows).toEqual([]);
    expect((await db.execute(`select scope from artist_qualification_state`)).rows).toEqual([]);
  });

  it("the sweep's `remaining > 0` drain loop TERMINATES and fully ranks the backlog", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    for (let index = 0; index < 4; index += 1) {
      await seedCatalogue(`cat-${index}`, { vector: blend(axis(0), axis(index + 1), 0.2) });
    }

    const MAX_CALLS = 8;
    let calls = 0;
    let scored = 0;
    let remaining = 1;

    while (remaining > 0 && calls < MAX_CALLS) {
      const tick = await rankCatalogue(2);
      calls += 1;
      scored += tick.scored;
      remaining = tick.remaining;
    }

    expect(remaining).toBe(0);
    expect(calls).toBeLessThan(MAX_CALLS);

    expect(calls).toBe(3);
    expect(scored).toBe(4);
    for (let index = 0; index < 4; index += 1) {
      expect((await rankingOf(`cat-${index}`)).nearest_finding_track_id).toBe("finding-a");
    }
  });

  it("COUNTS what is left rather than assuming zero — a limit of 0 must not report 'drained'", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-a", { vector: blend(axis(0), axis(1), 0.2) });

    const summary = await rankCatalogue(0);

    expect(summary.scored).toBe(0);
    expect(summary.remaining).toBe(1);
  });

  it("returns the fullness SENTINEL by default and the real COUNT under countRemaining", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    for (let index = 0; index < 6; index += 1) {
      await seedCatalogue(`cat-${index}`, { vector: blend(axis(0), axis(index + 1), 0.2) });
    }

    const counted = await rankCatalogue(2, true);
    expect(counted.scored).toBe(2);
    expect(counted.remaining).toBe(4);

    const sentinel = await rankCatalogue(2);
    expect(sentinel.scored).toBe(2);
    expect(sentinel.remaining).toBe(1);

    const trueLeft = await rankCatalogue(0);
    expect(trueLeft.scored).toBe(0);
    expect(trueLeft.remaining).toBe(2);
  });

  it("re-scores a row whose OWN vector arrived after it was ranked (capture → embed)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-fa", "Finding Artist", "finding-artist");
    await seedFinding("finding-a", { artists: ["Finding Artist"], vector: axis(0) });
    await edge("finding-a", "art-fa");
    await seedCatalogue("cat-a", { artists: ["Finding Artist"] });
    await edge("cat-a", "art-fa");

    const first = await rankCatalogue();
    expect(first.prioritized).toBe(1);
    expect((await rankingOf("cat-a")).capture_priority).toBe(3);

    await embed("cat-a", blend(axis(0), axis(1), 0.2));

    const second = await rankCatalogue();
    expect(second.corpus).toBe(first.corpus);
    expect(second.scored).toBe(1);
    expect(second.remaining).toBe(0);

    const ranking = await rankingOf("cat-a");
    expect(ranking.nearest_finding_track_id).toBe("finding-a");
    expect(ranking.nearest_finding_score ?? 0).toBeGreaterThan(0.9);

    expect(ranking.capture_priority).toBeNull();
    const third = await rankCatalogue();
    expect(third.scored).toBe(0);
    expect(third.remaining).toBe(0);
  });

  it("stamps a row it cannot score, so a hopeless row is never re-picked forever", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a");
    await seedCatalogue("cat-a", { vector: axis(0) });

    const summary = await rankCatalogue();

    expect(summary.embeddedFindings).toBe(0);
    expect(summary.scored).toBe(1);

    const ranking = await rankingOf("cat-a");
    expect(ranking.nearest_finding_score).toBeNull();
    expect(ranking.catalogue_rank_corpus).toBe(summary.corpus);
    expect(summary.remaining).toBe(0);
  });
});

describe("the capture queue — authorization, then the priority ladder", () => {
  beforeEach(async () => {
    await seedArtistRow("art-krakota", "Krakota", "krakota");
    await seedFinding("finding-a", {
      artists: ["Krakota"],
      label: "Hospital Records",
      vector: axis(0),
    });
    await edge("finding-a", "art-krakota");

    await ruleLabel("lbl-hospital", "Hospital Records", "hospital-records", "enabled");

    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");

    await seedFinding("finding-crossover", { artists: ["Above & Beyond"], label: "Anjunabeats" });
    await ruleLabel("lbl-out", "Anjunabeats", "anjunabeats", "disabled");

    await seedFinding("finding-atlantic", { artists: ["A Crossover"], label: "Atlantic UK" });
  });

  it("tiers AUTHORIZED tracks by the priority ladder, and SINKS the unauthorized", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-artist", { artists: ["Krakota"], label: "Some Other Label" });
    await edge("cat-artist", "art-krakota");

    await seedCatalogue("cat-label", { artists: ["Nobody"], label: "hospital records." });

    await seedCatalogue("cat-seed", { artists: ["Nobody"], label: "Critical Music" });

    await seedCatalogue("cat-unauth", { artists: ["Nobody"], label: "Nobody's Imprint" });

    await seedCatalogue("cat-vetoed", { artists: ["Krakota"], label: "Anjunabeats" });
    await edge("cat-vetoed", "art-krakota");

    const summary = await rankCatalogue();

    expect(summary.prioritized).toBe(5);
    expect(summary.scored).toBe(0);

    expect((await rankingOf("cat-artist")).capture_priority).toBe(3);

    expect((await rankingOf("cat-label")).capture_priority).toBe(2);

    expect((await rankingOf("cat-seed")).capture_priority).toBe(1);

    expect((await rankingOf("cat-unauth")).capture_priority).toBe(-3);

    expect((await rankingOf("cat-vetoed")).capture_priority).toBe(-1);
  });

  it("authorizes an EDGE-LESS track via its enabled label (the pre-backfill common case)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-edgeless", { artists: ["Unknown Name"], label: "Critical Music" });

    await rankCatalogue();

    expect((await rankingOf("cat-edgeless")).capture_priority).toBe(1);
  });

  it("does NOT authorize a label-mate off a finding on a NON-enabled label (Atlantic-UK pin)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-atlantic", { artists: ["Nobody"], label: "Atlantic UK" });

    await rankCatalogue();

    expect((await rankingOf("cat-atlantic")).capture_priority).toBe(-3);
  });

  it("qualifies an artist by WEIGHTED release count ≥ 3 on enabled labels (no finding needed)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-worker", "Session Worker", "session-worker");

    for (const index of [0, 1, 2]) {
      await seedCatalogue(`rel-${index}`, { artists: ["Session Worker"], label: "Critical Music" });
      await linkLabel(`rel-${index}`, "lbl-seed");
      await edge(`rel-${index}`, "art-worker");
    }

    await seedCatalogue("cat-worker", { artists: ["Session Worker"], label: "Undecided Imprint" });
    await edge("cat-worker", "art-worker");

    await rankCatalogue();

    expect((await rankingOf("cat-worker")).capture_priority).toBe(3);
  });

  it("holds the WEIGHTED arity guard — 2 primary + 1 remixer is 2.5, below the threshold", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-light", "Light Credit", "light-credit");
    await seedCatalogue("rel-p0", { artists: ["Light Credit"], label: "Critical Music" });
    await linkLabel("rel-p0", "lbl-seed");
    await edge("rel-p0", "art-light");
    await seedCatalogue("rel-p1", { artists: ["Light Credit"], label: "Critical Music" });
    await linkLabel("rel-p1", "lbl-seed");
    await edge("rel-p1", "art-light");
    await seedCatalogue("rel-r0", { artists: ["Light Credit"], label: "Critical Music" });
    await linkLabel("rel-r0", "lbl-seed");
    await edge("rel-r0", "art-light", 0, "remixer");

    await seedCatalogue("cat-light", { artists: ["Light Credit"], label: "Undecided Imprint" });
    await edge("cat-light", "art-light");

    await rankCatalogue();

    expect((await rankingOf("cat-light")).capture_priority).toBe(-3);
  });

  it("re-ranks an old row when its OWN edge lands — the write path nulls JUST that row (v5 first-order)", async () => {
    const { rankCatalogue } = await import("./catalogue");
    const { linkTracksToArtistEntities } = await import("./artists");

    await seedArtistRow("art-late", "Late Edge", "late-edge");
    await seedFinding("finding-late", { artists: ["Late Edge"], label: "Some Label" });
    await edge("finding-late", "art-late");

    await seedCatalogue("cat-late", { artists: ["Late Edge"], label: "Undecided Imprint" });

    await seedCatalogue("cat-bystander", {
      artists: ["Nobody At All"],
      label: "Undecided Imprint",
    });

    await rankCatalogue();

    expect((await rankingOf("cat-late")).capture_priority).toBe(-3);
    const bystanderCorpusBefore = (await rankingOf("cat-bystander")).catalogue_rank_corpus;
    expect(bystanderCorpusBefore).not.toBeNull();

    await linkTracksToArtistEntities(["cat-late"]);

    expect((await rankingOf("cat-late")).catalogue_rank_corpus).toBeNull();
    expect((await rankingOf("cat-bystander")).catalogue_rank_corpus).toBe(bystanderCorpusBefore);

    await rankCatalogue();
    expect((await rankingOf("cat-late")).capture_priority).toBe(3);
    expect((await rankingOf("cat-bystander")).capture_priority).toBe(-3);
  });

  it("keeps the two lenses disjoint — a track with audio leaves the capture queue", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-hungry", { artists: ["Krakota"] });
    await edge("cat-hungry", "art-krakota");
    await seedCatalogue("cat-fed", { artists: ["Krakota"], vector: blend(axis(0), axis(1), 0.2) });
    await edge("cat-fed", "art-krakota");

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    const capture = await listCatalogueTracks("capture");

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

    await seedCatalogue("cat-best", { vector: blend(axis(1), axis(2), 0.15) });
    await seedCatalogue("cat-mid", { vector: blend(axis(0), axis(2), 0.25) });
    await seedCatalogue("cat-worst", { vector: blend(axis(0), axis(2), 0.5) });

    await rankCatalogue();

    const page = await listCatalogueTracks("ear");

    expect(page.map((track) => track.trackId)).toEqual(["cat-best", "cat-mid", "cat-worst"]);

    const best = page[0];
    expect(best?.nearestFinding?.trackId).toBe("finding-nutone");
    expect(best?.nearestFinding?.title).toBe("Heaven's Gate");
    expect(best?.nearestFinding?.artists).toEqual(["Nu:Tone"]);
    expect(best?.nearestFinding?.logId).toBeTruthy();
    expect(best?.nearestFindingScore ?? 0).toBeGreaterThan(0.98);

    expect(page[1]?.nearestFinding?.trackId).toBe("finding-krakota");
  });

  it("orders the capture queue by priority, DESC, and carries the reason for each rung", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-krakota", "Krakota", "krakota");
    await seedFinding("finding-a", { artists: ["Krakota"], label: "Hospital Records" });
    await edge("finding-a", "art-krakota");
    await ruleLabel("lbl-hospital", "Hospital Records", "hospital-records", "enabled");
    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");

    await seedCatalogue("cat-seed", { artists: ["Nobody"], label: "Critical Music" });
    await seedCatalogue("cat-artist", { artists: ["Krakota"] });
    await edge("cat-artist", "art-krakota");
    await seedCatalogue("cat-label", { artists: ["Nobody"], label: "Hospital Records" });

    await rankCatalogue();

    const page = await listCatalogueTracks("capture");

    expect(page.map((track) => track.trackId)).toEqual(["cat-artist", "cat-label", "cat-seed"]);

    expect(page[0]?.captureReason).toEqual({ kind: "artist", name: "Krakota" });
    expect(page[1]?.captureReason).toEqual({ kind: "label", name: "Hospital Records" });
    expect(page[2]?.captureReason).toEqual({ kind: "seed-label", name: "Critical Music" });
  });

  it("shows nothing at all when the catalogue is empty — the honest state today", async () => {
    const { getCatalogueSummary, listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    const summary = await rankCatalogue();
    expect(summary.scored).toBe(0);
    expect(summary.prioritized).toBe(0);

    expect(await listCatalogueTracks("ear")).toEqual([]);
    expect(await listCatalogueTracks("capture")).toEqual([]);
    expect(await listCatalogueTracks("quarantine")).toEqual([]);
    expect(await getCatalogueSummary()).toEqual({
      awaitingCapture: 0,
      awaitingRank: 0,

      computedAt: expect.any(String),
      dismissed: 0,
      quarantined: 0,
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

    expect(summary.awaitingRank).toBe(1);
  });

  it("keeps the cached summary IDENTICAL to a full recompute via the per-tick batch DELTA", async () => {
    const { computeCatalogueCounts, getCatalogueSummary, rankCatalogue, refreshCatalogueSummary } =
      await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    await seedCatalogue("cat-score-0", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-score-1", { vector: blend(axis(0), axis(2), 0.2) });
    await seedCatalogue("cat-score-2", { vector: blend(axis(0), axis(3), 0.2) });
    await seedCatalogue("cat-pre-0");
    await seedCatalogue("cat-pre-1");

    await refreshCatalogueSummary();

    for (let tick = 0; tick < 6; tick += 1) {
      const summary = await rankCatalogue(2);
      const cached = await getCatalogueSummary();
      const truth = await computeCatalogueCounts();

      expect({
        awaitingCapture: cached.awaitingCapture,
        awaitingRank: cached.awaitingRank,
        dismissed: cached.dismissed,
        quarantined: cached.quarantined,
        ranked: cached.ranked,
        total: cached.total,
      }).toEqual(truth);

      if (summary.remaining === 0) {
        break;
      }
    }
  });

  it("reads the archive affinity ONCE per tick — the pre-audio ladder feeds the display cache", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    await seedCatalogue("cat-unvectored");

    const executeSpy = vi.spyOn(db, "execute");
    await rankCatalogue();

    const calls = executeSpy.mock.calls.map((call) => {
      const arg = call[0] as string | { sql: string };

      return typeof arg === "string" ? arg : arg.sql;
    });
    const weightedFragment = calls.filter((sql) =>
      sql.includes("having sum(case when ta.role = 'remixer'"),
    );
    executeSpy.mockRestore();

    expect(weightedFragment).toHaveLength(2);
    expect(weightedFragment.every((sql) => sql.includes("union"))).toBe(true);
  });

  it("the pure bucket classifier agrees with the SQL aggregate, bucket-for-bucket (the delta drift guard)", async () => {
    const { WRONG_AUDIO_STATUS, bucketsForRow, computeCatalogueCounts, readRowBuckets } =
      await import("./catalogue");

    const setCols = async (
      trackId: string,
      cols: {
        capturePriority?: null | number;
        captureStatus?: string;
        corpus?: null | string;
        dismissedAt?: null | string;
        duplicateOf?: null | string;
        durationMs?: null | number;
        score?: null | number;
      },
    ): Promise<void> => {
      await db.execute({
        args: [
          cols.capturePriority ?? null,
          cols.captureStatus ?? "pending",
          cols.corpus ?? null,
          cols.dismissedAt ?? null,
          cols.duplicateOf ?? null,
          cols.durationMs === undefined ? 270_000 : cols.durationMs,
          cols.score ?? null,
          trackId,
        ],
        sql: `update tracks
              set capture_priority = ?, capture_status = ?, catalogue_rank_corpus = ?,
                  dismissed_at = ?, duplicate_of_track_id = ?, duration_ms = ?,
                  nearest_finding_score = ?
              where track_id = ?`,
      });
    };

    const corpus = "v5:1:1:0";
    const ids = [
      "b-awaiting-rank",
      "b-ranked",
      "b-awaiting-capture",
      "b-fresh-pending",
      "b-quarantined",
      "b-dismissed",
      "b-duplicate",
      "b-long-form",
      "b-multi",
    ];

    for (const id of ids) {
      await seedCatalogue(id);
    }

    await setCols("b-awaiting-rank", { corpus: null });
    await setCols("b-ranked", { corpus, score: 0.9 });
    await setCols("b-awaiting-capture", { capturePriority: 3, corpus });

    await setCols("b-fresh-pending", { capturePriority: 2, corpus });
    await setCols("b-quarantined", { captureStatus: WRONG_AUDIO_STATUS, corpus });
    await setCols("b-dismissed", { dismissedAt: "2026-07-22T00:00:00.000Z" });
    await setCols("b-duplicate", { corpus, duplicateOf: "finding-x", score: 0.99 });
    await setCols("b-long-form", { corpus, durationMs: 20 * 60_000, score: 0.9 });
    await setCols("b-multi", { capturePriority: 3, corpus: null });

    const sql = await computeCatalogueCounts();
    const tally = {
      awaitingCapture: 0,
      awaitingRank: 0,
      dismissed: 0,
      quarantined: 0,
      ranked: 0,
      total: 0,
    };

    for (const id of ids) {
      for (const bucket of await readRowBuckets(id)) {
        tally[bucket] += 1;
      }
    }

    expect(tally).toEqual(sql);

    expect(sql).toEqual({
      awaitingCapture: 3,
      awaitingRank: 2,
      dismissed: 1,
      quarantined: 1,
      ranked: 1,
      total: 8,
    });

    const base = {
      capturePriority: 3,
      captureStatus: "pending",
      catalogueRankCorpus: corpus,
      dismissedAt: null,
      duplicateOfTrackId: null,
      durationMs: 270_000,
      nearestFindingScore: null,
    } as const;
    expect([...bucketsForRow(base)].sort()).toEqual(["awaitingCapture", "total"]);
    expect([...bucketsForRow({ ...base, captureStatus: WRONG_AUDIO_STATUS })].sort()).toEqual([
      "quarantined",
      "total",
    ]);
    expect([...bucketsForRow({ ...base, durationMs: null })]).toEqual(["total"]);
    expect([...(await readRowBuckets("b-multi"))].sort()).toEqual([
      "awaitingCapture",
      "awaitingRank",
      "total",
    ]);
  });
});

describe("duplicates — a crawled copy of a finding is flagged, never bought", () => {
  it("flags a pre-audio ISRC duplicate: tier −2, the finding STORED, still on the board with its WHY", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-owned", { isrc: "GBAYE1234567", title: "Infinity" });
    await seedCatalogue("cat-dupe", { isrc: "gb-aye-12-34567", title: "Infinity (copy)" });

    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    await seedCatalogue("cat-real", {
      artists: ["Nobody"],
      label: "Critical Music",
      title: "A Real Candidate",
    });

    const summary = await rankCatalogue();
    expect(summary.prioritized).toBe(2);

    const dupe = await rankingOf("cat-dupe");
    expect(dupe.capture_priority).toBe(-2);
    expect(dupe.duplicate_of_track_id).toBe("finding-owned");
    expect(dupe.nearest_finding_score).toBeNull();

    const capture = await listCatalogueTracks("capture");
    expect(capture.map((track) => track.trackId)).toEqual(["cat-real", "cat-dupe"]);
    const dupeItem = capture.find((track) => track.trackId === "cat-dupe");
    expect(dupeItem?.duplicateOf?.trackId).toBe("finding-owned");
    expect(dupeItem?.duplicateOf?.title).toBe("Infinity");
    expect(capture.find((track) => track.trackId === "cat-real")?.duplicateOf).toBeNull();
  });

  it("a display-band [0.995, 0.9995) duplicate never occupies a ranked ear slot — and nothing is stored", async () => {
    const { DUPLICATE_SIMILARITY, listCatalogueTracks, rankCatalogue, WRONG_AUDIO_QUARANTINE } =
      await import("./catalogue");

    await seedFinding("finding-owned", { title: "Infinity", vector: axis(0) });

    await seedCatalogue("cat-identical", {
      title: "Infinity (copy)",
      vector: blend(axis(0), axis(1), 0.06),
    });

    await seedCatalogue("cat-near", { vector: blend(axis(0), axis(1), 0.2) });

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    expect(ear.map((track) => track.trackId)).toEqual(["cat-near"]);
    expect(ear[0]?.duplicateOf).toBeNull();

    const stored = await rankingOf("cat-identical");
    expect(stored.nearest_finding_score ?? 0).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
    expect(stored.nearest_finding_score ?? 1).toBeLessThan(WRONG_AUDIO_QUARANTINE);

    expect(stored.duplicate_of_track_id).toBeNull();
    expect(stored.capture_priority).toBeNull();
  });

  it("converges: a pre-audio duplicate is stamped and not re-picked, and CLEARS if its finding goes", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-owned", { isrc: "GBAYE1234567" });
    await seedCatalogue("cat-dupe", { isrc: "GBAYE1234567" });

    const first = await rankCatalogue();
    expect(first.prioritized).toBe(1);
    expect((await rankingOf("cat-dupe")).duplicate_of_track_id).toBe("finding-owned");

    const second = await rankCatalogue();
    expect(second.prioritized).toBe(0);
    expect(second.scored).toBe(0);
    expect(second.remaining).toBe(0);

    await db.execute({ args: ["finding-owned"], sql: `delete from findings where track_id = ?` });

    await rankCatalogue();
    const cleared = await rankingOf("cat-dupe");
    expect(cleared.duplicate_of_track_id).toBeNull();

    expect(cleared.capture_priority).toBe(-3);
  });
});

describe("matchKey duplicate — a logged track's twin is flagged, ISRC-blind and score-blind", () => {
  async function markCleared(trackId: string): Promise<void> {
    await db.execute({
      args: [trackId],
      sql: `update tracks set capture_status = 'duplicate-cleared' where track_id = ?`,
    });
  }

  it("pre-audio: a no-ISRC row with the same folded title+artist as a finding is tier −2, finding stored, last on the board", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-drifting", {
      artists: ["BOP", "Unquote"],
      title: "Drifting Away",
    });
    await seedCatalogue("cat-twin", {
      artists: ["unquote", "bop"],
      title: "DRIFTING-AWAY",
    });

    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    await seedCatalogue("cat-real", {
      artists: ["Nobody"],
      label: "Critical Music",
      title: "A Real Candidate",
    });

    const summary = await rankCatalogue();
    expect(summary.prioritized).toBe(2);

    const twin = await rankingOf("cat-twin");
    expect(twin.capture_priority).toBe(-2);
    expect(twin.duplicate_of_track_id).toBe("finding-drifting");
    expect(twin.nearest_finding_score).toBeNull();

    const capture = await listCatalogueTracks("capture");
    expect(capture.map((track) => track.trackId)).toEqual(["cat-real", "cat-twin"]);
    expect(capture.find((track) => track.trackId === "cat-twin")?.duplicateOf?.trackId).toBe(
      "finding-drifting",
    );
  });

  it("scored: a 0.94 twin (well below 0.995) is stamped −2, KEEPS its score, and never occupies an ear slot", async () => {
    const { DUPLICATE_SIMILARITY, listCatalogueTracks, rankCatalogue } =
      await import("./catalogue");

    await seedFinding("finding-drifting", {
      artists: ["BOP", "Unquote"],
      title: "Drifting Away",
      vector: axis(0),
    });
    await seedCatalogue("cat-twin", {
      artists: ["BOP", "Unquote"],
      title: "Drifting Away (copy)",
      vector: blend(axis(0), axis(1), 0.25),
    });

    await seedCatalogue("cat-disco", { vector: blend(axis(0), axis(2), 0.3) });

    await rankCatalogue();

    const twin = await rankingOf("cat-twin");
    expect(twin.duplicate_of_track_id).toBe("finding-drifting");
    expect(twin.capture_priority).toBe(-2);

    expect(twin.nearest_finding_score ?? 0).toBeGreaterThan(0.85);
    expect(twin.nearest_finding_score ?? 1).toBeLessThan(DUPLICATE_SIMILARITY);

    const ear = await listCatalogueTracks("ear");
    const earIds = ear.map((track) => track.trackId);
    expect(earIds).toContain("cat-disco");
    expect(earIds).not.toContain("cat-twin");
  });

  it("a VIP or a different artist is a DIFFERENT identity — not a duplicate, still ranks", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-dribble", {
      artists: ["Enei"],
      title: "Dribble",
      vector: axis(0),
    });
    await seedCatalogue("cat-vip", {
      artists: ["Enei"],
      title: "Dribble - VIP",
      vector: blend(axis(0), axis(1), 0.2),
    });

    await seedFinding("finding-shared", {
      artists: ["Artist A"],
      title: "Shared Title",
      vector: axis(3),
    });
    await seedCatalogue("cat-other-artist", {
      artists: ["Artist B"],
      title: "Shared Title",
      vector: blend(axis(3), axis(4), 0.2),
    });

    await rankCatalogue();

    for (const id of ["cat-vip", "cat-other-artist"]) {
      const row = await rankingOf(id);
      expect(row.duplicate_of_track_id).toBeNull();
      expect(row.capture_priority).toBeNull();
      expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.9);
    }
  });

  it("the force-capture sentinel is respected: a `duplicate-cleared` twin is NOT re-stamped, either side of the boundary", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-known", "Known", "known");
    await seedFinding("finding-twin", {
      artists: ["Known"],
      title: "The Same Song",
      vector: axis(0),
    });
    await edge("finding-twin", "art-known");

    await seedCatalogue("cat-preaudio", { artists: ["Known"], title: "The Same Song" });
    await edge("cat-preaudio", "art-known");
    await markCleared("cat-preaudio");

    await seedCatalogue("cat-scored", {
      artists: ["Known"],
      title: "The Same Song",
      vector: blend(axis(0), axis(1), 0.25),
    });
    await markCleared("cat-scored");

    await rankCatalogue();

    const preaudio = await rankingOf("cat-preaudio");
    expect(preaudio.duplicate_of_track_id).toBeNull();
    expect(preaudio.capture_priority).toBe(3);

    const scored = await rankingOf("cat-scored");
    expect(scored.duplicate_of_track_id).toBeNull();
    expect(scored.capture_priority).toBeNull();
    expect(scored.nearest_finding_score ?? 0).toBeGreaterThan(0.85);
  });
});

describe("wrong audio — a cross-title near-1.0 capture is quarantined, never trusted (docs/the-ear.md § Wrong audio)", () => {
  async function withSourceKey(trackId: string, key: string): Promise<void> {
    await db.execute({
      args: [key, trackId],
      sql: `update tracks set source_audio_key = ? where track_id = ?`,
    });
  }

  async function stateOf(trackId: string): Promise<{
    capture_status: null | string;
    embedding_blob: unknown;
    source_audio_key: null | string;
  }> {
    const result = await db.execute({
      args: [trackId],

      sql: `select t.capture_status, emb.embedding_blob, t.source_audio_key
            from tracks t
            left join track_embeddings emb on emb.track_id = t.track_id
            where t.track_id = ?`,
    });

    return result.rows[0] as unknown as Awaited<ReturnType<typeof stateOf>>;
  }

  it("quarantines a CROSS-TITLE near-1.0 row: the vector is dropped, the bad key kept, the row re-queued", async () => {
    const { WRONG_AUDIO_STATUS, rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-flowidus", "Flowidus", "flowidus");
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await edge("finding-shelter", "art-flowidus");
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await edge("cat-fyl", "art-flowidus");
    await withSourceKey("cat-fyl", "catalogue/cat-fyl/badbeef.webm");

    await db.execute(`update tracks set key = '8A'
      where track_id in ('finding-shelter', 'cat-fyl')`);
    await db.execute("update artists set rankable_track_count = 2 where id = 'art-flowidus'");

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(1);

    expect(summary.scored).toBe(0);

    const row = await rankingOf("cat-fyl");

    expect(row.nearest_finding_score).toBeNull();
    expect(row.nearest_finding_track_id).toBe("finding-shelter");
    expect(row.capture_priority).toBe(3);

    const state = await stateOf("cat-fyl");
    expect(state.capture_status).toBe(WRONG_AUDIO_STATUS);
    expect(state.embedding_blob).toBeNull();
    expect(state.source_audio_key).toBe("catalogue/cat-fyl/badbeef.webm");
    expect(
      (await db.execute("select rankable_track_count from artists where id = 'art-flowidus'"))
        .rows[0]?.rankable_track_count,
    ).toBe(1);
  });

  it("reads the archive's TITLE+ARTIST identity ONCE per tick, both directions off one statement", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-flowidus", "Flowidus", "flowidus");
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await edge("finding-shelter", "art-flowidus");
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await edge("cat-fyl", "art-flowidus");
    await withSourceKey("cat-fyl", "catalogue/cat-fyl/badbeef.webm");

    const spy = vi.spyOn(db, "execute");
    const summary = await rankCatalogue();

    expect(summary.quarantined).toBe(1);

    const identityReads = spy.mock.calls.filter((call) => {
      const sql = String((call[0] as { sql?: string })?.sql ?? "");

      return (
        sql.includes("findings.track_id as track_id") &&
        sql.includes("tracks.title as title") &&
        sql.includes("tracks.artists_json as artists_json")
      );
    });

    expect(identityReads.length).toBe(1);

    spy.mockRestore();
  });

  it("does NOT quarantine a SAME-TITLE near-1.0 row — it is a true duplicate (tier −2, finding stored, vector kept)", async () => {
    const { DUPLICATE_CAPTURE_TIER, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await seedCatalogue("cat-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(0);

    const row = await rankingOf("cat-shelter");

    expect(row.duplicate_of_track_id).toBe("finding-shelter");
    expect(row.capture_priority).toBe(DUPLICATE_CAPTURE_TIER);
    expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.99);

    const state = await stateOf("cat-shelter");
    expect(state.capture_status).not.toBe("wrong-audio");
    expect(state.embedding_blob).not.toBeNull();
  });

  it("converges: a quarantined row and a −2 true duplicate are both stable on the next tick — no re-pick loop", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await seedCatalogue("cat-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });

    const first = await rankCatalogue();
    expect(first.quarantined).toBe(1);

    const second = await rankCatalogue();
    expect(second.quarantined).toBe(0);
    expect(second.scored).toBe(0);
    expect(second.prioritized).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("the operator force-clear is sticky: a cleared row re-ranks normally and is never re-quarantined", async () => {
    const { clearWrongAudio, QUARANTINE_CLEARED, rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-flowidus", "Flowidus", "flowidus");
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await edge("finding-shelter", "art-flowidus");
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await edge("cat-fyl", "art-flowidus");
    await withSourceKey("cat-fyl", "catalogue/cat-fyl/badbeef.webm");

    await rankCatalogue();
    expect((await stateOf("cat-fyl")).capture_status).toBe("wrong-audio");

    expect(await clearWrongAudio("cat-fyl")).toBe(true);
    expect((await stateOf("cat-fyl")).capture_status).toBe(QUARANTINE_CLEARED);

    await embed("cat-fyl", axis(0));
    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(0);

    const row = await rankingOf("cat-fyl");
    expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.99);
    expect((await stateOf("cat-fyl")).capture_status).toBe(QUARANTINE_CLEARED);

    expect(await clearWrongAudio("cat-fyl")).toBe(false);
  });

  it("the operator flag rewinds a FINDING: vector out, provenance reset, bad key kept; findings-only", async () => {
    const { flagWrongAudio, WRONG_AUDIO_STATUS } = await import("./catalogue");

    await seedFinding("finding-dwyl", {
      artists: ["Freaks & Geeks"],
      title: "Down With Your Love",
      vector: axis(1),
    });
    await withSourceKey("finding-dwyl", "005.9.9L/badbeef.webm");
    await db.execute({
      args: ["finding-dwyl"],

      sql: `update tracks set analyzed_from = 'full', capture_status = 'done',
                              capture_source_pin = 'dQw4w9WgXcQ',
                              capture_source_pin_allow_duration = 1,
                              youtube_video_id = 'dQw4w9WgXcQ', youtube_video_official = 1,
                              youtube_verified_at = '2026-07-02T00:00:00.000Z',
                              youtube_verified_by = 'operator', source_verification = 'operator'
            where track_id = ?`,
    });

    await seedArtistRow("flag-artist", "Freaks & Geeks", "flag-artist");
    await edge("finding-dwyl", "flag-artist");
    await db.execute("update tracks set key = '8A' where track_id = 'finding-dwyl'");
    await db.execute("update artists set rankable_track_count = 1 where id = 'flag-artist'");

    expect(await flagWrongAudio("finding-dwyl")).toBe(true);
    expect(
      (await db.execute("select rankable_track_count from artists where id = 'flag-artist'"))
        .rows[0]?.rankable_track_count,
    ).toBe(0);

    const pinned = await db.execute({
      args: ["finding-dwyl"],
      sql: `select capture_source_pin, capture_source_pin_allow_duration, youtube_video_id,
                   youtube_video_official, youtube_verified_at,
                   youtube_verified_by, source_verification
            from tracks where track_id = ?`,
    });
    expect(pinned.rows[0]).toMatchObject({
      capture_source_pin: null,
      capture_source_pin_allow_duration: 0,
      source_verification: null,
      youtube_verified_at: null,
      youtube_verified_by: null,
      youtube_video_id: null,
      youtube_video_official: null,
    });

    const state = await stateOf("finding-dwyl");
    expect(state.capture_status).toBe(WRONG_AUDIO_STATUS);

    expect(state.embedding_blob).toBeNull();

    expect(state.source_audio_key).toBe("005.9.9L/badbeef.webm");

    const provenance = await db.execute({
      args: ["finding-dwyl"],
      sql: `select analyzed_from from tracks where track_id = ?`,
    });
    expect(provenance.rows[0]?.analyzed_from ?? null).toBeNull();

    expect(await flagWrongAudio("finding-dwyl")).toBe(false);

    await seedFinding("finding-fp", {
      artists: ["Freaks & Geeks"],
      title: "Fingerprinted",
      vector: axis(1),
    });
    await withSourceKey("finding-fp", "005.9.9M/cafebabe.webm");
    await db.execute({
      args: ["finding-fp"],
      sql: `update tracks set capture_status = 'done',
                              youtube_video_id = 'fpEarnedId0', youtube_video_official = 1,
                              youtube_verified_at = '2026-07-02T00:00:00.000Z',
                              youtube_verified_by = 'fingerprint',
                              source_verification = 'soundcloud-preview-match'
            where track_id = ?`,
    });
    expect(await flagWrongAudio("finding-fp")).toBe(true);
    const earned = await db.execute({
      args: ["finding-fp"],
      sql: `select youtube_video_id, youtube_video_official, youtube_verified_by, source_verification
            from tracks where track_id = ?`,
    });
    expect(earned.rows[0]).toMatchObject({
      source_verification: "soundcloud-preview-match",
      youtube_verified_by: "fingerprint",
      youtube_video_id: "fpEarnedId0",
      youtube_video_official: 1,
    });

    await seedCatalogue("cat-inf", {
      artists: ["Freaks & Geeks"],
      title: "Infinity",
      vector: axis(1),
    });
    await withSourceKey("cat-inf", "catalogue/cat-inf/cafef00d.webm");
    expect(await flagWrongAudio("cat-inf")).toBe(false);
  });
});

describe("the operator's actions — dismiss/restore, and the deterministic-duplicate exclusion", () => {
  it("a dismissed row leaves the ear + capture lenses and the sweep; restore puts it back", async () => {
    const { listCatalogueTracks, rankCatalogue, setTrackDismissed } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    await seedCatalogue("cat-scored", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-cold");
    await rankCatalogue();

    expect((await listCatalogueTracks("ear")).map((t) => t.trackId)).toContain("cat-scored");
    expect((await listCatalogueTracks("capture")).map((t) => t.trackId)).toContain("cat-cold");

    expect(await setTrackDismissed("cat-scored", true)).toBe(true);
    expect(await setTrackDismissed("cat-cold", true)).toBe(true);

    expect((await listCatalogueTracks("ear")).map((t) => t.trackId)).not.toContain("cat-scored");
    expect((await listCatalogueTracks("capture")).map((t) => t.trackId)).not.toContain("cat-cold");
    expect((await listCatalogueTracks("dismissed")).map((t) => t.trackId).sort()).toEqual([
      "cat-cold",
      "cat-scored",
    ]);

    await seedFinding("finding-b", { vector: axis(2) });
    const tick = await rankCatalogue();
    expect(tick.scored).toBe(0);
    expect(tick.prioritized).toBe(0);

    expect(await setTrackDismissed("cat-scored", false)).toBe(true);
    await rankCatalogue();
    expect((await listCatalogueTracks("ear")).map((t) => t.trackId)).toContain("cat-scored");
  });

  it("excludes a dismissed catalogue row from the capture WORK queue (the metered ladder)", async () => {
    const { rankCatalogue, setTrackDismissed } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    await setCatalogueCapturePaused(false);

    await seedArtistRow("art-known", "Known", "known");
    await seedFinding("finding-a", { artists: ["Known"], vector: axis(0) });
    await edge("finding-a", "art-known");

    await seedCatalogue("cat-hot", { artists: ["Known"] });
    await edge("cat-hot", "art-known");
    await rankCatalogue();

    const before = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(before.map((w) => w.trackId)).toContain("cat-hot");

    await setTrackDismissed("cat-hot", true);

    const after = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(after.map((w) => w.trackId)).not.toContain("cat-hot");
  });

  it("a deterministic duplicate (duplicate_of_track_id set) never occupies an ear-lens slot", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-owned", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-dupe", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });

    await seedCatalogue("cat-real", { vector: blend(axis(0), axis(1), 0.2) });
    await rankCatalogue();

    const stored = await rankingOf("cat-dupe");
    expect(stored.duplicate_of_track_id).toBe("finding-owned");
    expect(stored.nearest_finding_score ?? 0).toBeGreaterThan(0.99);

    const ear = (await listCatalogueTracks("ear")).map((t) => t.trackId);
    expect(ear).not.toContain("cat-dupe");
    expect(ear).toContain("cat-real");
  });

  it("keeps the summary consistent with the lenses via the mutation DELTA (dismiss, then restore)", async () => {
    const { getCatalogueSummary, rankCatalogue, setTrackDismissed } = await import("./catalogue");

    await seedFinding("finding-owned", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-dupe", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-real", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-dismissed", { vector: blend(axis(0), axis(1), 0.3) });
    await rankCatalogue();

    const afterRank = await getCatalogueSummary();
    expect(afterRank.total).toBe(3);
    expect(afterRank.ranked).toBe(2);
    expect(afterRank.dismissed).toBe(0);

    await setTrackDismissed("cat-dismissed", true);
    const afterDismiss = await getCatalogueSummary();
    expect(afterDismiss.ranked).toBe(1);
    expect(afterDismiss.dismissed).toBe(1);
    expect(afterDismiss.total).toBe(2);

    await setTrackDismissed("cat-dismissed", false);
    const afterRestore = await getCatalogueSummary();
    expect(afterRestore.ranked).toBe(2);
    expect(afterRestore.dismissed).toBe(0);
    expect(afterRestore.total).toBe(3);
  });

  it("never touches a finding — setTrackDismissed on a certified track is a no-op", async () => {
    const { setTrackDismissed } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    expect(await setTrackDismissed("finding-a", true)).toBe(false);
    const row = await db.execute({
      args: ["finding-a"],
      sql: "select dismissed_at from tracks where track_id = ?",
    });
    expect(row.rows[0]?.dismissed_at).toBeNull();
  });
});

describe("catalogue-internal duplicates — one master, one row", () => {
  async function capture(trackId: string, isrc?: string): Promise<void> {
    await db.execute({
      args: [`catalogue/${trackId}/x.webm`, trackId],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    if (isrc) {
      await setIsrc(trackId, isrc);
    }
  }

  it("marks an already-captured sibling as a duplicate of the canonical (min id, kept vector)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-a" });
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-b" });
    await capture("cat-a");
    await capture("cat-b");
    await embed("cat-a", unit(axis(3)));
    await embed("cat-b", unit(axis(3)));

    const summary = await rankCatalogue();

    expect(summary.catalogueDuplicates).toBe(1);

    expect((await rankingOf("cat-a")).duplicate_of_track_id).toBeNull();
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBe("cat-a");
    expect((await rankingOf("cat-b")).capture_priority).toBe(-2);

    const kept = await db.execute({
      args: ["cat-b"],
      sql: "select embedding_blob from track_embeddings where track_id = ?",
    });
    expect(kept.rows[0]?.embedding_blob).not.toBeNull();
  });

  it("vetoes an UNcaptured sibling off the capture queue before a byte is bought", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-have" });
    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-want" });
    await capture("cat-have");

    await rankCatalogue();

    expect((await rankingOf("cat-want")).duplicate_of_track_id).toBe("cat-have");
    expect((await rankingOf("cat-want")).capture_priority).toBe(-2);

    expect((await rankingOf("cat-have")).duplicate_of_track_id).toBeNull();
  });

  it("matches on an exact ISRC even when the titles drift between MBIDs", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, {
      artists: ["Archangel"],
      title: "Obsession",
      trackId: "cat-isrc-x",
    });
    await seedCatalogueTrack(db, {
      artists: ["Archangel"],
      title: "Obsession (Remastered)",
      trackId: "cat-isrc-y",
    });
    await capture("cat-isrc-x", "GBTEST0000001");

    await db.execute({
      args: ["catalogue/cat-isrc-y/x.webm", "cat-isrc-y"],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    await setIsrc("cat-isrc-y", "GBTEST0000001");
    await embed("cat-isrc-x", unit(axis(4)));
    await embed("cat-isrc-y", unit(axis(4)));

    await rankCatalogue();

    expect((await rankingOf("cat-isrc-y")).duplicate_of_track_id).toBe("cat-isrc-x");
  });

  it("does NOT merge a remix — a different version descriptor is a different recording", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, { artists: ["J-Cut"], title: "Deep End", trackId: "cat-orig" });
    await seedCatalogueTrack(db, {
      artists: ["J-Cut"],
      title: "Deep End (VIP)",
      trackId: "cat-vip",
    });
    await capture("cat-orig");
    await capture("cat-vip");
    await embed("cat-orig", unit(axis(6)));
    await embed("cat-vip", unit(axis(7)));

    const summary = await rankCatalogue();

    expect(summary.catalogueDuplicates).toBe(0);
    expect((await rankingOf("cat-orig")).duplicate_of_track_id).toBeNull();
    expect((await rankingOf("cat-vip")).duplicate_of_track_id).toBeNull();
  });

  it("keeps canonical selection identical across processing, tie, ISRC, clear, and re-key cases", async () => {
    const { rankCatalogue } = await import("./catalogue");

    for (const trackId of ["proc-a", "proc-z", "proc-candidate"]) {
      await seedCatalogueTrack(db, { artists: ["Proc"], title: "Shared", trackId });
    }
    await capture("proc-a");
    await capture("proc-z");
    await embed("proc-z", unit(axis(8)));

    for (const trackId of ["tie-a", "tie-b", "tie-candidate"]) {
      await seedCatalogueTrack(db, { artists: ["Tie"], title: "Shared", trackId });
    }
    await capture("tie-a");
    await capture("tie-b");

    await seedCatalogueTrack(db, {
      artists: ["ISRC"],
      title: "Original",
      trackId: "isrc-canonical",
    });
    await seedCatalogueTrack(db, {
      artists: ["ISRC"],
      title: "Different metadata",
      trackId: "isrc-candidate",
    });
    await capture("isrc-canonical", "GB-TEST-00-00001");
    await setIsrc("isrc-candidate", "gb test 00 00001");

    for (const trackId of ["clear-a", "clear-z", "clear-candidate"]) {
      await seedCatalogueTrack(db, { artists: ["Clear"], title: "Shared", trackId });
    }
    await capture("clear-a");
    await capture("clear-z");
    await db.execute({
      args: ["clear-a"],
      sql: `update tracks set capture_status = 'duplicate-cleared' where track_id = ?`,
    });

    await seedCatalogueTrack(db, {
      artists: ["Old Artist"],
      title: "Old Title",
      trackId: "rekey-old",
    });
    await seedCatalogueTrack(db, {
      artists: ["New Artist"],
      title: "New Title",
      trackId: "rekey-new",
    });
    await seedCatalogueTrack(db, {
      artists: ["Old Artist"],
      title: "Old Title",
      trackId: "rekey-candidate",
    });
    await capture("rekey-old");
    await capture("rekey-new");

    await rankCatalogue();

    expect((await rankingOf("proc-candidate")).duplicate_of_track_id).toBe("proc-z");
    expect((await rankingOf("tie-candidate")).duplicate_of_track_id).toBe("tie-a");
    expect((await rankingOf("isrc-candidate")).duplicate_of_track_id).toBe("isrc-canonical");
    expect((await rankingOf("clear-candidate")).duplicate_of_track_id).toBe("clear-z");
    expect((await rankingOf("clear-a")).duplicate_of_track_id).toBeNull();
    expect((await rankingOf("rekey-candidate")).duplicate_of_track_id).toBe("rekey-old");

    const artistsJson = JSON.stringify(["New Artist"]);
    await db.batch(
      [
        {
          args: ["New Title", artistsJson, "rekey-candidate"],
          sql: `update tracks
                set title = ?, artists_json = ?, catalogue_rank_corpus = null
                where track_id = ?`,
        },
        upsertTrackDuplicateKeyStatement({
          artistsJson,
          isrc: null,
          title: "New Title",
          trackId: "rekey-candidate",
        }),
      ],
      "write",
    );

    await rankCatalogue();

    expect((await rankingOf("rekey-candidate")).duplicate_of_track_id).toBe("rekey-new");
  });
});

describe("the dupe-veto escape hatch — force_capture", () => {
  async function statusOf(trackId: string): Promise<null | string> {
    const result = await db.execute({
      args: [trackId],
      sql: `select capture_status from tracks where track_id = ?`,
    });

    return (result.rows[0]?.capture_status as null | string) ?? null;
  }

  async function capture(trackId: string): Promise<void> {
    await db.execute({
      args: [`catalogue/${trackId}/x.webm`, trackId],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
  }

  it("lifts a catalogue-internal duplicate veto and SURVIVES a re-rank — the forced row is never re-marked", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-a" });
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-b" });
    await capture("cat-a");
    await capture("cat-b");
    await embed("cat-a", unit(axis(3)));
    await embed("cat-b", unit(axis(3)));
    await rankCatalogue();
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBe("cat-a");

    expect(await forceCapture("cat-b")).toBe(true);
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBeNull();
    expect(await statusOf("cat-b")).toBe("duplicate-cleared");

    expect(await forceCapture("cat-b")).toBe(false);

    const summary = await rankCatalogue();
    expect(summary.catalogueDuplicates).toBe(0);
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBeNull();
    expect(await statusOf("cat-b")).toBe("duplicate-cleared");

    expect((await rankingOf("cat-a")).duplicate_of_track_id).toBeNull();
  });

  it("puts an uncaptured pre-audio ISRC duplicate back on the capture ladder at its HONEST tier, and into the capture queue", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    await setCatalogueCapturePaused(false);

    await seedArtistRow("art-known", "Known", "known");
    await seedFinding("finding-owned", {
      artists: ["Known"],
      isrc: "GBTEST0000009",
      vector: axis(0),
    });
    await edge("finding-owned", "art-known");
    await seedCatalogue("cat-wrongisrc", { artists: ["Known"], isrc: "GBTEST0000009" });
    await edge("cat-wrongisrc", "art-known");
    await rankCatalogue();
    expect((await rankingOf("cat-wrongisrc")).duplicate_of_track_id).toBe("finding-owned");
    expect((await rankingOf("cat-wrongisrc")).capture_priority).toBe(-2);

    expect(await forceCapture("cat-wrongisrc")).toBe(true);

    await rankCatalogue();
    const row = await rankingOf("cat-wrongisrc");
    expect(row.duplicate_of_track_id).toBeNull();
    expect(row.capture_priority).toBe(3);

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((w) => w.trackId)).toContain("cat-wrongisrc");
  });

  it("a forced SAME-title near-1.0 row ranks on its own merits instead of being re-marked a finding duplicate", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-owned", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-dupe", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await rankCatalogue();

    expect((await rankingOf("cat-dupe")).duplicate_of_track_id).toBe("finding-owned");

    expect(await forceCapture("cat-dupe")).toBe(true);

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(0);
    const row = await rankingOf("cat-dupe");
    expect(row.duplicate_of_track_id).toBeNull();
    expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.99);
    expect(await statusOf("cat-dupe")).toBe("duplicate-cleared");
  });

  it("still quarantines WRONG AUDIO on a duplicate-cleared row — bypasses the DUPLICATE veto, never the VERIFICATION gate", async () => {
    const { WRONG_AUDIO_STATUS, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });

    await db.execute({
      args: ["cat-fyl"],
      sql: `update tracks
            set capture_status = 'duplicate-cleared', source_audio_key = 'catalogue/cat-fyl/x.webm'
            where track_id = ?`,
    });

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(1);
    expect(await statusOf("cat-fyl")).toBe(WRONG_AUDIO_STATUS);
  });

  it("refuses a finding and a non-duplicate row — an honest no-op success", async () => {
    const { forceCapture } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-plain");

    expect(await forceCapture("finding-a")).toBe(false);

    expect(await forceCapture("cat-plain")).toBe(false);

    expect(await forceCapture("nope")).toBe(false);
  });

  it("FULL ARC: force → capture done (real update path) → embed → re-rank — the ruling is never reversed", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");
    const { updateTrack } = await import("./track-update");

    await seedFinding("finding-x", { vector: axis(5) });

    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-can" });
    await seedCatalogueTrack(db, {
      artists: ["Whiney"],
      title: "Nightfall",
      trackId: "cat-forced",
    });
    await capture("cat-can");
    await embed("cat-can", unit(axis(3)));
    await rankCatalogue();
    expect((await rankingOf("cat-forced")).duplicate_of_track_id).toBe("cat-can");

    expect(await forceCapture("cat-forced")).toBe(true);
    await rankCatalogue();
    expect((await rankingOf("cat-forced")).capture_priority).toBe(0);

    const now = new Date().toISOString();
    await updateTrack(
      "cat-forced",
      {
        captureStatus: "done",
        sourceAudioAttemptedAt: now,
        sourceAudioBytes: 1234,
        sourceAudioCapturedAt: now,
        sourceAudioKey: "catalogue/cat-forced/fresh.webm",
      },
      { writer: "agent" },
    );
    expect(await statusOf("cat-forced")).toBe("duplicate-cleared");
    const captured = await db.execute({
      args: ["cat-forced"],
      sql: `select source_audio_key from tracks where track_id = ?`,
    });
    expect(captured.rows[0]?.source_audio_key).toBe("catalogue/cat-forced/fresh.webm");

    await embed("cat-forced", unit(axis(3)));
    const summary = await rankCatalogue();
    expect(summary.catalogueDuplicates).toBe(0);
    const row = await rankingOf("cat-forced");
    expect(row.duplicate_of_track_id).toBeNull();
    expect(row.nearest_finding_score).not.toBeNull();
    expect(row.capture_priority).toBeNull();
    expect(await statusOf("cat-forced")).toBe("duplicate-cleared");
  });

  it("a CAPTURED duplicate-cleared row never re-enters the capture worklist — even in the window before the next re-rank", async () => {
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    await setCatalogueCapturePaused(false);

    await seedFinding("finding-a", { artists: ["Known"], vector: axis(0) });
    await seedCatalogue("cat-forced", { artists: ["Known"] });
    await db.execute({
      args: ["cat-forced"],
      sql: `update tracks
            set capture_status = 'duplicate-cleared',
                capture_priority = 3,
                source_audio_key = 'catalogue/cat-forced/fresh.webm'
            where track_id = ?`,
    });

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((w) => w.trackId)).not.toContain("cat-forced");
  });

  it("a duplicate-cleared row WITH audio is embed- and analyze-eligible — the forced row still gets its vector", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogue("cat-forced");
    await db.execute({
      args: ["cat-forced"],
      sql: `update tracks
            set capture_status = 'duplicate-cleared',
                capture_priority = 0,
                source_audio_key = 'catalogue/cat-forced/fresh.webm'
            where track_id = ?`,
    });

    const embedWork = await listTrackWork({ kind: "embed", scope: "catalogue" });
    expect(embedWork.map((w) => w.trackId)).toContain("cat-forced");
    const analyzeWork = await listTrackWork({ kind: "analyze", scope: "catalogue" });
    expect(analyzeWork.map((w) => w.trackId)).toContain("cat-forced");
  });

  it("a FAILED forced capture keeps the sentinel (never re-marked) and backs off on the attempt stamp", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");
    const { updateTrack } = await import("./track-update");

    await setCatalogueCapturePaused(false);

    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-have" });
    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-want" });
    await capture("cat-have");
    await rankCatalogue();
    expect((await rankingOf("cat-want")).duplicate_of_track_id).toBe("cat-have");
    expect(await forceCapture("cat-want")).toBe(true);
    await rankCatalogue();

    await updateTrack(
      "cat-want",
      {
        captureStatus: "failed",
        sourceAudioAttemptedAt: new Date().toISOString(),
        sourceAudioFailures: 1,
      },
      { writer: "agent" },
    );
    expect(await statusOf("cat-want")).toBe("duplicate-cleared");
    await rankCatalogue();
    expect((await rankingOf("cat-want")).duplicate_of_track_id).toBeNull();

    const fresh = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(fresh.map((w) => w.trackId)).not.toContain("cat-want");

    await db.execute({
      args: ["2000-01-01T00:00:00.000Z", "cat-want"],
      sql: `update tracks set source_audio_attempted_at = ? where track_id = ?`,
    });
    const cooled = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(cooled.map((w) => w.trackId)).toContain("cat-want");
  });
});

describe("the long-form veto — a continuous mix never reaches a lens or the money", () => {
  async function captureAt(trackId: string): Promise<void> {
    await db.execute({
      args: [`catalogue/${trackId}/x.webm`, trackId],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
  }

  it("a scored 70-minute mix is excluded from the ear lens (and its ranked count) — a 6-minute track is not", async () => {
    const { getCatalogueSummary, listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogueTrack(db, {
      artists: ["Etherwood"],
      durationMs: 70 * 60_000,
      title: "Ten Years of Test (continuous mix)",
      trackId: "cat-mix",
    });
    await seedCatalogueTrack(db, {
      artists: ["Etherwood"],
      durationMs: 6 * 60_000,
      title: "Real Single",
      trackId: "cat-single",
    });
    await captureAt("cat-mix");
    await captureAt("cat-single");

    await embed("cat-mix", blend(axis(0), axis(1), 0.05));
    await embed("cat-single", blend(axis(0), axis(1), 0.2));

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    expect(ear.map((t) => t.trackId)).toEqual(["cat-single"]);

    const summary = await getCatalogueSummary();
    expect(summary.ranked).toBe(1);
  });

  it("an uncaptured 70-minute mix never enters the capture worklist — the money half", async () => {
    const { rankCatalogue } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    await setCatalogueCapturePaused(false);
    await seedFinding("finding-a", { vector: axis(0) });

    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    await seedCatalogueTrack(db, {
      artists: ["Someone"],
      durationMs: 78 * 60_000,
      label: "Critical Music",
      title: "Summer Selection (Continuous mix 1)",
      trackId: "cat-mix-uncaptured",
    });
    await seedCatalogueTrack(db, {
      artists: ["Someone"],
      durationMs: 5 * 60_000,
      label: "Critical Music",
      title: "Buy Me",
      trackId: "cat-buyme",
    });

    await rankCatalogue();

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    const ids = work.map((item) => item.trackId);
    expect(ids).toContain("cat-buyme");
    expect(ids).not.toContain("cat-mix-uncaptured");
  });

  it("a captured row with NO store preview still auditions — hasCapturedAudio is the fallback signal", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    await seedCatalogueTrack(db, {
      artists: ["Changing Faces"],
      durationMs: 4 * 60_000 + 30_000,
      title: "Talk to You",
      trackId: "cat-noprev",
    });
    await captureAt("cat-noprev");
    await embed("cat-noprev", blend(axis(0), axis(1), 0.2));

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    const row = ear.find((t) => t.trackId === "cat-noprev");
    expect(row?.hasPreview).toBe(false);
    expect(row?.hasCapturedAudio).toBe(true);
  });

  it("re-queues only clean-duration unmatched CATALOGUE rows; vetoed rows and findings stay put", async () => {
    const { requeueUnmatchedCaptures } = await import("./catalogue");

    await seedCatalogueTrack(db, { durationMs: 270_000, trackId: "unm-clean" });
    await seedCatalogueTrack(db, { durationMs: 0, trackId: "unm-nodur" });
    await seedCatalogueTrack(db, { durationMs: 70 * 60_000, trackId: "unm-long" });
    await seedFinding("unm-find");
    await db.execute({
      sql: `update tracks set capture_status = 'unmatched', source_audio_failures = 5
            where track_id like 'unm-%'`,
    });

    const result = await requeueUnmatchedCaptures();

    expect(result).toEqual({ requeued: 1, skippedVetoed: 2 });

    const states = await db.execute({
      sql: `select track_id, capture_status, source_audio_failures from tracks
            where track_id like 'unm-%' order by track_id`,
    });
    const rows = states.rows as unknown as Array<{
      capture_status: null | string;
      source_audio_failures: number;
      track_id: string;
    }>;
    const byId = new Map(
      rows.map((row) => [
        row.track_id,
        { failures: Number(row.source_audio_failures), status: row.capture_status },
      ]),
    );
    expect(byId.get("unm-clean")).toEqual({ failures: 0, status: "pending" });
    expect(byId.get("unm-nodur")?.status).toBe("unmatched");
    expect(byId.get("unm-long")?.status).toBe("unmatched");

    expect(byId.get("unm-find")?.status).toBe("unmatched");

    expect(await requeueUnmatchedCaptures()).toEqual({ requeued: 0, skippedVetoed: 2 });
  });

  it("exposes capture outcomes: the unmatched and failed lenses, newest attempt first, with captureStatus", async () => {
    const { listCatalogueTracks } = await import("./catalogue");

    await seedCatalogueTrack(db, { trackId: "obs-unm-old" });
    await seedCatalogueTrack(db, { trackId: "obs-unm-new" });
    await seedCatalogueTrack(db, { trackId: "obs-fail" });
    await seedCatalogueTrack(db, { trackId: "obs-pending" });
    await seedFinding("obs-find");
    await db.execute({
      sql: `update tracks set capture_status = 'unmatched',
                              source_audio_attempted_at = '2026-07-10T00:00:00Z'
            where track_id = 'obs-unm-old'`,
    });
    await db.execute({
      sql: `update tracks set capture_status = 'unmatched',
                              source_audio_attempted_at = '2026-07-14T00:00:00Z'
            where track_id = 'obs-unm-new'`,
    });
    await db.execute({
      sql: `update tracks set capture_status = 'failed',
                              source_audio_attempted_at = '2026-07-12T00:00:00Z'
            where track_id in ('obs-fail', 'obs-find')`,
    });
    await db.execute({
      sql: `update tracks set capture_status = 'pending', capture_priority = 3
            where track_id = 'obs-pending'`,
    });

    const unmatched = await listCatalogueTracks("unmatched");
    expect(unmatched.map((t) => t.trackId)).toEqual(["obs-unm-new", "obs-unm-old"]);
    expect(unmatched[0]?.captureStatus).toBe("unmatched");

    expect(unmatched.map((t) => t.sourceAudioAttemptedAt)).toEqual([
      "2026-07-14T00:00:00Z",
      "2026-07-10T00:00:00Z",
    ]);

    const failed = await listCatalogueTracks("failed");
    expect(failed.map((t) => t.trackId)).toEqual(["obs-fail"]);
    expect(failed[0]?.captureStatus).toBe("failed");
    expect(failed[0]?.sourceAudioAttemptedAt).toBe("2026-07-12T00:00:00Z");

    const capture = await listCatalogueTracks("capture");
    const pending = capture.find((t) => t.trackId === "obs-pending");
    expect(pending?.captureStatus).toBe("pending");

    expect(pending?.sourceAudioAttemptedAt).toBeNull();
  });
});

describe("the diversity decay — the ear page spreads artists, years, and keys", () => {
  it("a same-artist clone wall is interleaved: the fresh artist rises past the second clone", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-anchor", { vector: axis(0) });

    await seedCatalogue("cat-clone-1", {
      artists: ["Clone Artist"],
      key: "A Minor",
      releaseDate: "2019-05-01",
      vector: blend(axis(0), axis(1), 0.16),
    });
    await seedCatalogue("cat-clone-2", {
      artists: ["Clone Artist"],
      key: "A Minor",
      releaseDate: "2019-06-01",
      vector: blend(axis(0), axis(1), 0.18),
    });
    await seedCatalogue("cat-clone-3", {
      artists: ["Clone Artist"],
      key: "A Minor",
      releaseDate: "2019-07-01",
      vector: blend(axis(0), axis(1), 0.2),
    });

    await seedCatalogue("cat-fresh", {
      artists: ["Fresh Artist"],
      key: "F Major",
      releaseDate: "2023-01-01",
      vector: blend(axis(0), axis(1), 0.19),
    });

    await rankCatalogue();

    const page = await listCatalogueTracks("ear");

    expect(page.map((track) => track.trackId)).toEqual([
      "cat-clone-1",
      "cat-fresh",
      "cat-clone-2",
      "cat-clone-3",
    ]);

    const fresh = page.find((track) => track.trackId === "cat-fresh");
    expect(fresh?.nearestFindingScore ?? 0).toBeGreaterThan(0.9);
  });
});

describe("the staleness fingerprint — v5 targeted re-staling", () => {
  it("a label ruling flip re-stales EXACTLY that label's rows, not the whole catalogue", async () => {
    const { rankCatalogue } = await import("./catalogue");
    const { updateLabelSeedState } = await import("./labels");

    await ruleLabel("lbl-x", "Label X", "label-x", "undecided");
    await ruleLabel("lbl-y", "Label Y", "label-y", "undecided");
    await seedCatalogue("cat-x1", { artists: ["Nobody"], label: "Label X" });
    await linkLabel("cat-x1", "lbl-x");
    await seedCatalogue("cat-x2", { artists: ["Nobody"], label: "Label X" });
    await linkLabel("cat-x2", "lbl-x");
    await seedCatalogue("cat-y1", { artists: ["Nobody"], label: "Label Y" });
    await linkLabel("cat-y1", "lbl-y");

    await rankCatalogue();

    for (const id of ["cat-x1", "cat-x2", "cat-y1"]) {
      expect((await rankingOf(id)).capture_priority).toBe(-3);
      expect((await rankingOf(id)).catalogue_rank_corpus).not.toBeNull();
    }
    const yCorpusBefore = (await rankingOf("cat-y1")).catalogue_rank_corpus;

    await updateLabelSeedState("lbl-x", "enabled");

    expect((await rankingOf("cat-x1")).catalogue_rank_corpus).toBeNull();
    expect((await rankingOf("cat-x2")).catalogue_rank_corpus).toBeNull();
    expect((await rankingOf("cat-y1")).catalogue_rank_corpus).toBe(yCorpusBefore);

    await rankCatalogue();
    expect((await rankingOf("cat-x1")).capture_priority).toBe(1);
    expect((await rankingOf("cat-x2")).capture_priority).toBe(1);
    expect((await rankingOf("cat-y1")).capture_priority).toBe(-3);
  });

  it("a disable ruling re-stales its own rows to the VETO (the money-bug direction)", async () => {
    const { rankCatalogue } = await import("./catalogue");
    const { updateLabelSeedState } = await import("./labels");

    await ruleLabel("lbl-z", "Label Z", "label-z", "enabled");
    await seedCatalogue("cat-z1", { artists: ["Nobody"], label: "Label Z" });
    await linkLabel("cat-z1", "lbl-z");

    await rankCatalogue();
    expect((await rankingOf("cat-z1")).capture_priority).toBe(1);

    await updateLabelSeedState("lbl-z", "disabled");
    expect((await rankingOf("cat-z1")).catalogue_rank_corpus).toBeNull();

    await rankCatalogue();

    expect((await rankingOf("cat-z1")).capture_priority).toBe(-1);
  });

  it("a qualification CROSSING re-ranks the artist's OTHER-label rows the tipping edge never touched", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await ruleLabel("lbl-enabled", "Enabled Imprint", "enabled-imprint", "enabled");
    await seedArtistRow("art-rise", "On The Rise", "on-the-rise");

    for (const index of [0, 1]) {
      await seedCatalogue(`rise-${index}`, { artists: ["On The Rise"], label: "Enabled Imprint" });
      await linkLabel(`rise-${index}`, "lbl-enabled");
      await edge(`rise-${index}`, "art-rise");
    }

    await seedCatalogue("cat-major", { artists: ["On The Rise"], label: "Major Label" });
    await edge("cat-major", "art-rise");

    await rankCatalogue();

    expect((await rankingOf("cat-major")).capture_priority).toBe(-3);
    const majorCorpusBefore = (await rankingOf("cat-major")).catalogue_rank_corpus;

    await seedCatalogue("rise-2", { artists: ["On The Rise"], label: "Enabled Imprint" });
    await linkLabel("rise-2", "lbl-enabled");
    await edge("rise-2", "art-rise");

    await rankCatalogue();
    expect((await rankingOf("cat-major")).capture_priority).toBe(3);

    expect((await rankingOf("cat-major")).catalogue_rank_corpus).not.toBe(majorCorpusBefore);
  });
});

describe("the rank tick's repair markers — minted by real change", () => {
  async function sourceMarkersFor(trackId: string): Promise<number> {
    const result = await db.execute({
      args: [trackId],
      sql: `select count(*) as n from due_work
        where work_kind = 'source-repair' and subject_type = 'track' and subject_id = ?`,
    });

    return Number(result.rows[0]?.n ?? 0);
  }

  async function clearSourceMarkers(): Promise<void> {
    await db.execute(`delete from due_work where work_kind = 'source-repair'`);
  }

  it("mints nothing for a corpus restamp that moves no projected input", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("find-nr1", { vector: axis(0) });
    await seedCatalogue("cat-steady", { vector: unit([1, 0.02, ...axis(2).slice(2)]) });

    await rankCatalogue();
    const ranked = await rankingOf("cat-steady");
    expect(ranked.nearest_finding_track_id).toBe("find-nr1");
    await clearSourceMarkers();

    await seedFinding("find-fr2", { vector: axis(7) });

    const restamp = await rankCatalogue();
    expect(restamp.scored).toBe(1);
    const afterRestamp = await rankingOf("cat-steady");
    expect(afterRestamp.catalogue_rank_corpus).not.toBe(ranked.catalogue_rank_corpus);
    expect(afterRestamp.nearest_finding_score).toBe(ranked.nearest_finding_score);
    expect(await sourceMarkersFor("cat-steady")).toBe(0);
  });

  it("mints a marker when a projected input really moves", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("find-nr1", { vector: axis(0) });
    await seedCatalogue("cat-moved", { vector: unit([1, 0.4, ...axis(2).slice(2)]) });

    await rankCatalogue();
    await clearSourceMarkers();

    await seedFinding("find-nr3", { vector: unit([1, 0.4, ...axis(2).slice(2)]) });

    await rankCatalogue();
    expect((await rankingOf("cat-moved")).nearest_finding_track_id).toBe("find-nr3");
    expect(await sourceMarkersFor("cat-moved")).toBe(1);
  });

  it("keeps a catalogue-rank row another producer wrote after this tick selected its candidates", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-raced");

    await db.execute(`insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      values ('catalogue-rank', 'track', 'cat-raced', 'ready', 'k',
        '2999-01-01T00:00:00.000Z', 'v-fresh', 'live', '2999-01-01T00:00:00.000Z')`);

    await rankCatalogue();

    const survived = await db.execute(
      `select source_version from due_work
       where work_kind = 'catalogue-rank' and subject_id = 'cat-raced'`,
    );
    expect(survived.rows.map((row) => row.source_version)).toEqual(["v-fresh"]);
  });

  it("mints a marker when another producer moves an input this tick never writes", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-flipped");
    await clearSourceMarkers();

    const batchSpy = vi.spyOn(db, "batch").mockImplementation(async (statements, mode) => {
      batchSpy.mockRestore();
      await db.execute({
        args: ["2026-01-01T00:00:00.000Z", "cat-flipped"],
        sql: `update tracks set dismissed_at = ? where track_id = ?`,
      });

      return db.batch(statements, mode);
    });

    await rankCatalogue();

    expect(await sourceMarkersFor("cat-flipped")).toBe(1);
  });

  it("settles its own catalogue-rank due row instead of paying a source repair for it", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-settled");

    await db.execute(`insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      values ('catalogue-rank', 'track', 'cat-settled', 'ready', 'k',
        '2026-01-01T00:00:00.000Z', 'v1', 'live', '2026-01-01T00:00:00.000Z')`);

    await rankCatalogue();

    const remaining = await db.execute(
      `select count(*) as n from due_work
       where work_kind = 'catalogue-rank' and subject_id = 'cat-settled'`,
    );
    expect(Number(remaining.rows[0]?.n ?? 0)).toBe(0);
  });
});

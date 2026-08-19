import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE VECTOR SATELLITE (schema.ts § `trackEmbeddings`, docs/track-lifecycle.md).
//
// The MuQ vector used to be a `tracks` column; it now lives 1:1 in `track_embeddings`, and
// `tracks.has_embedding` mirrors that row's EXISTENCE. Three things have to hold for that split to
// be invisible to everything above it, and each gets a case here:
//
//   1. THE WRITE IS ATOMIC. The satellite row and its mirror move in one libSQL write batch. A
//      track with a vector but no mirror is hidden from the embed queue; a mirror with no vector is
//      a funnel that over-reports and a `/mix` gate that opens on nothing. Neither is an error the
//      database would raise — it is silent corruption, so it is pinned rather than trusted.
//   2. A MOVED JOIN READ still ranks. `getSimilarFindings` computes `vector_distance_cos` against
//      the satellite in SQL, and its join is INNER — which is the old `embedding_blob is not null`
//      filter, spelled as membership.
//   3. A MOVED EXISTS READ still answers. `listEmbeddingPresenceForTracks` probes the satellite by
//      primary key for the admin board's Embeddings cell.
//
// Driven against the REAL migrated schema (`createIntegrationDb`), so the SQL under test is
// byte-identical to production's — including the foreign key and its cascade.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const TARGET = "aaaaaaaaaaaaaaaaaaaaaa"; // 22 chars, the tracks PK shape
const NEAR = "bbbbbbbbbbbbbbbbbbbbbb";
const FAR = "cccccccccccccccccccccc";

/** A unit vector leaning `first` toward axis 0 — the whole corpus sits on one plane. */
function vector(first: number): number[] {
  return [first, ...Array.from({ length: 1023 }, () => 0.01)];
}

/** The mirror `tracks` carries, and the count of satellite rows for the same track. */
async function stateOf(trackId: string): Promise<{ mirror: number; vectors: number }> {
  const result = await db.execute({
    args: [trackId, trackId],
    sql: `select (select has_embedding from tracks where track_id = ?) as mirror,
                 (select count(*) from track_embeddings where track_id = ?) as vectors`,
  });

  return {
    mirror: Number(result.rows[0]?.mirror ?? 0),
    vectors: Number(result.rows[0]?.vectors ?? 0),
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("the vector write keeps the satellite row and its mirror in step", () => {
  beforeEach(async () => {
    await seedTrack(db, { logId: "010.1.1A", title: "Target", trackId: TARGET });
  });

  it("writes the satellite row AND has_embedding on the same update_track call", async () => {
    const { updateTrack } = await import("./track-update");

    expect(await stateOf(TARGET)).toEqual({ mirror: 0, vectors: 0 });

    const result = await updateTrack(TARGET, { embedding: JSON.stringify(vector(1)) });

    expect(await stateOf(TARGET)).toEqual({ mirror: 1, vectors: 1 });
    // The caller is still told the vector moved, even though it is no longer a `tracks` column.
    expect(result.fields).toContain("embedding_blob");
    expect(result.fields).toContain("has_embedding");
  });

  it("re-embedding REPLACES the vector in place rather than failing on the primary key", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(TARGET, { embedding: JSON.stringify(vector(1)) });
    await updateTrack(TARGET, { embedding: JSON.stringify(vector(0.5)) });

    // Still exactly one row — a fresh capture must overwrite, never accumulate or throw.
    expect(await stateOf(TARGET)).toEqual({ mirror: 1, vectors: 1 });

    const { readEmbeddingBlob } = await import("./embedding");
    const stored = await db.execute({
      args: [TARGET],
      sql: "select embedding_blob from track_embeddings where track_id = ?",
    });

    expect(readEmbeddingBlob(stored.rows[0]?.embedding_blob)?.[0]).toBeCloseTo(0.5, 5);
  });

  it("clearing drops BOTH halves — the satellite row and the mirror", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(TARGET, { embedding: JSON.stringify(vector(1)) });
    await updateTrack(TARGET, { embedding: "" });

    expect(await stateOf(TARGET)).toEqual({ mirror: 0, vectors: 0 });
  });

  it("a quarantine clears both halves, and a GUARDED quarantine that matches nothing clears neither", async () => {
    // `flagWrongAudio` carries its guard in the update's WHERE, and the satellite delete is driven
    // by the `has_embedding = 0` that update writes — so a guard that matched no row must leave the
    // vector standing. That is the whole reason the delete reads the mirror instead of re-spelling
    // the guard, and it is the case a second copy of the guard would get wrong.
    const { flagWrongAudio } = await import("./catalogue");
    const { updateTrack } = await import("./track-update");

    await updateTrack(TARGET, {
      embedding: JSON.stringify(vector(1)),
      sourceAudioKey: "010.1.1A/beef.webm",
    });

    // No captured audio on this one, so the guard cannot match: nothing moves.
    await seedTrack(db, { logId: "011.1.1A", title: "Untouched", trackId: NEAR });
    await updateTrack(NEAR, { embedding: JSON.stringify(vector(0.9)) });

    expect(await flagWrongAudio(NEAR)).toBe(false);
    expect(await stateOf(NEAR)).toEqual({ mirror: 1, vectors: 1 });

    // This one qualifies, so both halves go.
    expect(await flagWrongAudio(TARGET)).toBe(true);
    expect(await stateOf(TARGET)).toEqual({ mirror: 0, vectors: 0 });
  });

  it("cascades the vector away when its track is deleted", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(TARGET, { embedding: JSON.stringify(vector(1)) });
    await db.execute("pragma foreign_keys = on");
    await db.execute({ args: [TARGET], sql: "delete from findings where track_id = ?" });
    await db.execute({ args: [TARGET], sql: "delete from tracks where track_id = ?" });

    // An orphan vector is not merely untidy — it is a vector the ranking can still reach for a
    // track that no longer exists.
    expect((await stateOf(TARGET)).vectors).toBe(0);
  });
});

describe("the moved reads still answer off the satellite", () => {
  beforeEach(async () => {
    const { updateTrack } = await import("./track-update");

    await seedTrack(db, { logId: "020.1.1A", title: "Target", trackId: TARGET });
    await seedTrack(db, { logId: "021.1.1A", title: "Near", trackId: NEAR });
    await seedTrack(db, { logId: "022.1.1A", title: "Far", trackId: FAR });
    await updateTrack(TARGET, { embedding: JSON.stringify(vector(1)) });
    await updateTrack(NEAR, { embedding: JSON.stringify(vector(0.95)) });
    await updateTrack(FAR, { embedding: JSON.stringify(vector(0.1)) });
  });

  it("the JOIN read ranks by cosine to the satellite's vector, nearest first", async () => {
    const { getSimilarFindings } = await import("./tracks");

    const similar = await getSimilarFindings(TARGET, 6);

    expect(similar.map((item) => item.trackId)).toEqual([NEAR, FAR]);
  });

  it("the JOIN read is INNER, so an un-embedded finding is skipped rather than ranked null", async () => {
    const { getSimilarFindings } = await import("./tracks");
    const { updateTrack } = await import("./track-update");

    await updateTrack(NEAR, { embedding: "" });

    const similar = await getSimilarFindings(TARGET, 6);

    expect(similar.map((item) => item.trackId)).toEqual([FAR]);
  });

  it("the EXISTS read returns exactly the tracks holding a satellite row", async () => {
    const { listEmbeddingPresenceForTracks } = await import("./tracks");
    const { updateTrack } = await import("./track-update");

    await seedCatalogueTrack(db, { title: "Bare", trackId: "dddddddddddddddddddddd" });
    await updateTrack(FAR, { embedding: "" });

    const present = await listEmbeddingPresenceForTracks([
      TARGET,
      NEAR,
      FAR,
      "dddddddddddddddddddddd",
    ]);

    expect([...present].sort()).toEqual([NEAR, TARGET].sort());
  });

  it("the EXISTS read answers [] for an empty ask without touching the database", async () => {
    const { listEmbeddingPresenceForTracks } = await import("./tracks");

    expect(await listEmbeddingPresenceForTracks([])).toEqual(new Set());
  });

  // The cluster engine's corpus read is the ONE path that ships whole vectors over the wire
  // (cursor-paged, off the hot path — docs/agents/cluster-engine.md), so its join is the one
  // place a wrong satellite read would poison every galaxy assignment rather than one page.
  it("the cluster corpus read pages coordinate-bearing embedded findings, decoding each vector", async () => {
    const { listTrackEmbeddingsPage } = await import("./galaxies-map");
    const { updateTrack } = await import("./track-update");

    // A finding with no vector, and a catalogue track WITH one: neither belongs in the corpus.
    await seedTrack(db, {
      logId: "023.1.1A",
      title: "Unembedded",
      trackId: "eeeeeeeeeeeeeeeeeeeeee",
    });
    await seedCatalogueTrack(db, { title: "Uncertified", trackId: "ffffffffffffffffffffff" });
    await updateTrack("ffffffffffffffffffffff", { embedding: JSON.stringify(vector(0.6)) });

    const first = await listTrackEmbeddingsPage(undefined, 2);

    expect(first.embeddings.map((row) => row.trackId)).toEqual([TARGET, NEAR]);
    expect(first.embeddings[0]?.embedding[0]).toBeCloseTo(1, 5);
    expect(first.nextCursor).not.toBeNull();

    const second = await listTrackEmbeddingsPage(first.nextCursor ?? undefined, 2);

    expect(second.embeddings.map((row) => row.trackId)).toEqual([FAR]);
    expect(second.nextCursor).toBeNull();
  });
});

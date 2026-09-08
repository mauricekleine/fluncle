import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS, readEmbeddingBlob } from "./embedding";
import { createIntegrationDb, seedCatalogueTrack, seedEmbedding } from "./integration-db";
import { type SonarFilter, type SonarMatch } from "./sonar";

const isSonarTrackEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({ isSonarTrackEnabled, searchSonar }));

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

import { listSonicNeighbours } from "./track-page";

type SonarRequest = {
  excludeIds?: string[];
  filter?: SonarFilter;
  probes: number[][];
  topK: number;
};

function unit(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

  return values.map((value) => value / norm);
}

function vector(cosine: number): number[] {
  const values = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0);
  values[0] = cosine;
  values[1] = Math.sqrt(1 - cosine * cosine);

  return values;
}

function cosine(left: number[], right: number[]): number {
  const a = unit(left);
  const b = unit(right);

  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

async function referenceSonar(request: SonarRequest): Promise<SonarMatch[]> {
  const result = await db.execute(
    `select tracks.track_id, tracks.bpm, tracks.dismissed_at, tracks.duplicate_of_track_id,
       track_embeddings.embedding_blob
     from tracks
     join track_embeddings on track_embeddings.track_id = tracks.track_id`,
  );
  const excluded = new Set(request.excludeIds ?? []);
  const matches: SonarMatch[] = [];

  for (const row of result.rows) {
    const id = typeof row.track_id === "string" ? row.track_id : "";
    const embedding = readEmbeddingBlob(row.embedding_blob);
    const bpm = row.bpm === null ? undefined : Number(row.bpm);
    const filter = request.filter;

    if (
      !embedding ||
      excluded.has(id) ||
      (filter?.dismissed !== undefined && (row.dismissed_at !== null) !== filter.dismissed) ||
      (filter?.is_duplicate !== undefined &&
        (row.duplicate_of_track_id !== null) !== filter.is_duplicate) ||
      (filter?.bpm_min !== undefined && (bpm === undefined || bpm < filter.bpm_min)) ||
      (filter?.bpm_max !== undefined && (bpm === undefined || bpm > filter.bpm_max))
    ) {
      continue;
    }

    matches.push({
      id,
      score: Math.max(...request.probes.map((probe) => cosine(probe, embedding))),
    });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, request.topK);
}

async function seed(trackId: string, bpm: number, embedding: number[]): Promise<void> {
  await seedCatalogueTrack(db, { trackId });
  await seedEmbedding(db, trackId, embedding);
  await db.execute({ args: [bpm, trackId], sql: "update tracks set bpm = ? where track_id = ?" });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  isSonarTrackEnabled.mockReset();
  searchSonar.mockReset();

  await seed("target", 174, vector(1));
  await seed("tempo-near", 176, vector(0.9));
  await seed("tempo-next", 170, vector(0.8));
  await seed("half-time-closer", 87, vector(0.99));
});

describe("listSonicNeighbours — the /track sonar route", () => {
  it("returns the same ids in the same order through sonar and the bounded Turso path", async () => {
    isSonarTrackEnabled.mockResolvedValue(false);
    const turso = await listSonicNeighbours("target", 2);

    isSonarTrackEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);
    const sonar = await listSonicNeighbours("target", 2);

    expect(sonar.map((row) => row.trackId)).toEqual(turso.map((row) => row.trackId));
    expect(sonar.map((row) => row.trackId)).toEqual(["tempo-near", "tempo-next"]);
    expect(searchSonar).toHaveBeenCalledOnce();
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          bpm_max: 174 * 1.08,
          bpm_min: 174 * 0.92,
          dismissed: false,
          is_duplicate: false,
        },
      }),
    );
  });

  it("drops a ranked id that no longer hydrates instead of inventing a neighbour", async () => {
    isSonarTrackEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([
      { id: "deleted-after-refresh", score: 0.99 },
      { id: "tempo-near", score: 0.9 },
    ]);

    const neighbours = await listSonicNeighbours("target", 2);

    expect(neighbours.map((row) => row.trackId)).toEqual(["tempo-near"]);
  });
});

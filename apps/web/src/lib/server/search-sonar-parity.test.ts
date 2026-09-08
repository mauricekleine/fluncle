import { type Client } from "@libsql/client";
import { type SearchFilters } from "@fluncle/contracts/orpc";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS, readEmbeddingBlob } from "./embedding";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { type SonarFilter, type SonarMatch } from "./sonar";

const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarArtistsEnabled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  isSonarLogEnabled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  isSonarSonicEnabled,
  searchSonar,
}));

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

import { rankTracksByVector } from "./search";

type SonarRequest = {
  excludeIds?: string[];
  filter?: SonarFilter;
  probes: number[][];
  topK: number;
};

function vector(cosine: number, axis: number): number[] {
  const values = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0);
  values[0] = cosine;
  values[axis] = Math.sqrt(1 - cosine * cosine);

  return values;
}

function cosine(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

/** The `tracks` Sonar index's inclusive BPM filter and deterministic similarity order. */
async function referenceSonar(request: SonarRequest): Promise<SonarMatch[]> {
  const result = await db.execute(
    `select tracks.track_id, tracks.bpm, track_embeddings.embedding_blob
     from tracks
     join track_embeddings on track_embeddings.track_id = tracks.track_id`,
  );
  const excluded = new Set(request.excludeIds ?? []);

  return result.rows
    .flatMap((row) => {
      const id = typeof row.track_id === "string" ? row.track_id : "";
      const embedding = readEmbeddingBlob(row.embedding_blob);
      const bpm = row.bpm === null ? null : Number(row.bpm);
      const filter = request.filter;

      if (
        !embedding ||
        excluded.has(id) ||
        (filter?.bpm_min !== undefined && (bpm === null || bpm < filter.bpm_min)) ||
        (filter?.bpm_max !== undefined && (bpm === null || bpm > filter.bpm_max))
      ) {
        return [];
      }

      return [
        {
          id,
          score: Math.max(...request.probes.map((probe) => cosine(probe, embedding))),
        },
      ];
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, request.topK);
}

async function setBpm(trackId: string, bpm: number): Promise<void> {
  await db.execute({ args: [bpm, trackId], sql: "update tracks set bpm = ? where track_id = ?" });
}

async function seedCatalogue(trackId: string, bpm: number, embedding: number[]): Promise<void> {
  await seedCatalogueTrack(db, { title: trackId, trackId });
  await setBpm(trackId, bpm);
  await seedEmbedding(db, trackId, embedding);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  isSonarSonicEnabled.mockReset();
  searchSonar.mockReset();

  await seedCatalogue("anchor", 174, vector(1, 1));
  await seedCatalogue("tied-b", 176, vector(0.8, 3));
  await seedTrack(db, { logId: "004.1.1A", title: "tied-a", trackId: "tied-a" });
  await setBpm("tied-a", 170);
  await seedEmbedding(db, "tied-a", vector(0.8, 2));
  await seedCatalogue("near", 174, vector(0.95, 1));
  await seedCatalogue("too-slow", 169, vector(0.99, 4));
  await seedCatalogue("too-fast", 177, vector(0.98, 5));
  await seedCatalogue("missing-bpm", 174, vector(0.97, 6));
  await db.execute({
    args: ["missing-bpm"],
    sql: "update tracks set bpm = null where track_id = ?",
  });
});

describe("rankTracksByVector — sonic search Sonar parity", () => {
  it("returns the same ids in the same order through Sonar and the bounded database path", async () => {
    const filters: SearchFilters = { bpmMax: 176, bpmMin: 170 };
    const probe = vector(1, 1);

    isSonarSonicEnabled.mockResolvedValue(false);
    const database = await rankTracksByVector(probe, filters, "anchor", 3);

    isSonarSonicEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);
    const sonar = await rankTracksByVector(probe, filters, "anchor", 3);

    expect(sonar.map((row) => row.trackId)).toEqual(database.map((row) => row.trackId));
    expect(sonar.map((row) => row.trackId)).toEqual(["near", "tied-a", "tied-b"]);
    expect(searchSonar).toHaveBeenCalledWith({
      excludeIds: ["anchor"],
      filter: { bpm_max: 176, bpm_min: 170 },
      index: "tracks",
      probes: [probe],
      topK: 3,
    });
  });
});

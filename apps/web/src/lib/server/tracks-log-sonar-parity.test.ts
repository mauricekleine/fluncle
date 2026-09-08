import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS, readEmbeddingBlob } from "./embedding";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { type SonarFilter, type SonarMatch } from "./sonar";

const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarLogEnabled,
  isSonarMixEnabled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  searchSonar,
}));

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

import { getSimilarFindings } from "./tracks";

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

/** The `tracks` Sonar index's certified filter and deterministic similarity order. */
async function referenceSonar(request: SonarRequest): Promise<SonarMatch[]> {
  const result = await db.execute(
    `select tracks.track_id, track_embeddings.embedding_blob, findings.log_id
     from tracks
     join track_embeddings on track_embeddings.track_id = tracks.track_id
     left join findings on findings.track_id = tracks.track_id`,
  );
  const excluded = new Set(request.excludeIds ?? []);

  return result.rows
    .flatMap((row) => {
      const id = typeof row.track_id === "string" ? row.track_id : "";
      const embedding = readEmbeddingBlob(row.embedding_blob);
      const certified = row.log_id !== null;

      if (
        !embedding ||
        excluded.has(id) ||
        (request.filter?.certified !== undefined && request.filter.certified !== certified)
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

async function seedFinding(
  trackId: string,
  logId: null | string,
  embedding: number[],
): Promise<void> {
  await seedTrack(db, { logId, title: trackId, trackId });
  await seedEmbedding(db, trackId, embedding);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  isSonarLogEnabled.mockReset();
  searchSonar.mockReset();

  await seedFinding("target", "004.0.0A", vector(1, 1));
  await seedFinding("tied-b", "004.3.3A", vector(0.8, 3));
  await seedFinding("tied-a", "004.2.2A", vector(0.8, 2));
  await seedFinding("near", "004.1.1A", vector(0.95, 1));
  await seedFinding("coordinate-less", null, vector(0.99, 4));
  await seedCatalogueTrack(db, { title: "catalogue", trackId: "catalogue" });
  await seedEmbedding(db, "catalogue", vector(0.98, 5));
});

describe("getSimilarFindings — /log Sonar parity", () => {
  it("returns the same ids in the same order through Sonar and the bounded database path", async () => {
    isSonarLogEnabled.mockResolvedValue(false);
    const database = await getSimilarFindings("target", 3, { allowBoundedSql: true });

    isSonarLogEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);
    const sonar = await getSimilarFindings("target", 3);

    expect(sonar.map((row) => row.trackId)).toEqual(database.map((row) => row.trackId));
    expect(sonar.map((row) => row.trackId)).toEqual(["near", "tied-a", "tied-b"]);
    expect(searchSonar).toHaveBeenCalledWith({
      excludeIds: ["target"],
      filter: { certified: true },
      index: "tracks",
      probes: expect.any(Array),
      topK: 3,
    });
  });
});

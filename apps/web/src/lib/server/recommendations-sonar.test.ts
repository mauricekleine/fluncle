import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS } from "./embedding";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { type PublicUser } from "./public-auth";

const isSonarArtistsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarRecsCatalogueEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarRecsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarArtistsEnabled,
  isSonarLogEnabled,
  isSonarRecsCatalogueEnabled,
  isSonarRecsEnabled,
  isSonarSonicEnabled,
  searchSonar,
}));

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

function axis(index: number): number[] {
  const vector = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0);
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

function publicUser(id: string): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: `${id}@example.com`,
    emailVerified: true,
    id,
    name: id,
    username: id,
  };
}

async function seedFinding(trackId: string, logId: string, vector: number[]): Promise<void> {
  await seedTrack(db, { logId, title: `Finding ${trackId}`, trackId });
  await embed(trackId, vector);
}

async function seedCatalogue(trackId: string, vector: number[]): Promise<void> {
  await seedCatalogueTrack(db, { title: `Catalogue ${trackId}`, trackId });
  await embed(trackId, vector);
}

async function seedWorld(): Promise<PublicUser> {
  const { saveRecSeed } = await import("./recommendations");
  const user = publicUser("user-sonar");

  await seedFinding("find-near", "001.1.1A", blend(axis(0), axis(9), 0.1));
  await seedFinding("find-mid", "002.1.1A", blend(axis(0), axis(9), 0.4));
  await seedFinding("find-far", "003.1.1A", blend(axis(0), axis(9), 0.7));
  await seedCatalogue("cat-1", blend(axis(0), axis(9), 0.2));
  await seedCatalogue("cat-2", blend(axis(0), axis(9), 0.5));

  await seedCatalogue("seed-1", axis(0));
  await saveRecSeed(user, { trackId: "seed-1" });

  return user;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  searchSonar.mockReset();
  isSonarRecsEnabled.mockReset();
  isSonarRecsEnabled.mockResolvedValue(false);
  isSonarRecsCatalogueEnabled.mockReset();
  isSonarRecsCatalogueEnabled.mockResolvedValue(false);
});

describe("listRecommendations — the sonar route (dark, default OFF)", () => {
  it("FLAG OFF: never calls sonar, and the Turso fold answers exactly as today", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    const result = await listRecommendations(user);

    expect(searchSonar).not.toHaveBeenCalled();
    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.findings.map((row) => row.trackId)).toEqual([
      "find-near",
      "find-mid",
      "find-far",
    ]);
    expect(result.catalogue.map((row) => row.trackId)).not.toContain("seed-1");
  });

  it("FLAG ON: sends ONE multi-probe call with the certified filter, the seeds excluded, and raw number[] probes", async () => {
    const { FINDINGS_SLOT_COUNT, listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([{ id: "find-mid", score: 0.9 }]);

    await listRecommendations(user);

    expect(searchSonar).toHaveBeenCalledTimes(1);
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeIds: ["seed-1"],
        filter: { certified: true },
        index: "tracks",
        topK: FINDINGS_SLOT_COUNT,
      }),
    );

    const request = searchSonar.mock.calls[0]?.[0] as undefined | { probes: number[][] };
    const probes = request?.probes ?? [];

    expect(probes).toHaveLength(1);
    expect(probes[0]).toHaveLength(EMBEDDING_DIMS);
    expect(Array.isArray(probes[0])).toBe(true);
    expect(typeof probes[0]?.[0]).toBe("number");
  });

  it("FLAG ON: the findings slots hydrate in SONAR'S order, carrying sonar's similarity", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([
      { id: "find-far", score: 0.91 },
      { id: "find-near", score: 0.42 },
    ]);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.findings.map((row) => row.trackId)).toEqual(["find-far", "find-near"]);
    expect(result.findings[0]?.similarity).toBeCloseTo(0.91, 6);
    expect(result.findings[1]?.similarity).toBeCloseTo(0.42, 6);
    expect(result.findings[0]?.logId).toBe("003.1.1A");
  });

  it("FLAG ON: the CATALOGUE half stays on the exact Turso scan (its eligibility has no sonar filter)", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([{ id: "find-mid", score: 0.9 }]);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.catalogue.map((row) => row.trackId).sort()).toEqual(["cat-1", "cat-2"]);
  });

  it("FLAG ON: a NULL sonar reply (unprovisioned/down/malformed) falls back to the Turso fold", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue(null);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.findings.map((row) => row.trackId)).toEqual([
      "find-near",
      "find-mid",
      "find-far",
    ]);
  });

  it("FLAG ON: an EMPTY sonar reply falls back to the Turso fold", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([]);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.findings.map((row) => row.trackId)).toEqual([
      "find-near",
      "find-mid",
      "find-far",
    ]);
  });
});

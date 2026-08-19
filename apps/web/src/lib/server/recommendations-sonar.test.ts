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

// THE /recommendations DRAFT ENGINE'S SONAR ROUTE (dark, DEFAULT OFF), against the REAL schema on a
// real libSQL engine — the discipline of recommendations.integration.test.ts, pointed at the one
// thing this slice adds. Three properties carry the safety contract and each is pinned here:
//
//   1. FLAG OFF ⇒ the sonar client is never even reached, and the Turso fold answers exactly as it
//      does by default. The flag being unset is the steady state.
//   2. FLAG ON ⇒ the FINDINGS SLOTS come back in SONAR'S order, with sonar's similarity, hydrated
//      through the same mapper — and the CATALOGUE half is untouched, still ranked by the exact
//      Turso scan, because REC_ELIGIBLE_WHERE has no faithful sonar filter.
//   3. A `null` (sonar unusable) or EMPTY reply falls back to the Turso fold — the documented
//      contract, and the reason a flag change can only ever restore the Turso behaviour.

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

/** A unit vector along one axis — an "artificial genre" fixture vectors can aim at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0);
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

/** The write the embed pipeline performs: validated JSON → the ranked F32_BLOB. */
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

/**
 * The shared fixture world: one seeded listener, three certified findings and two catalogue rows,
 * all embedded. The findings sit at staggered distances so the Turso fold has a definite order
 * (find-near, find-mid, find-far) that a sonar reply can visibly contradict.
 */
async function seedWorld(): Promise<PublicUser> {
  const { saveRecSeed } = await import("./recommendations");
  const user = publicUser("user-sonar");

  await seedFinding("find-near", "001.1.1A", blend(axis(0), axis(9), 0.1));
  await seedFinding("find-mid", "002.1.1A", blend(axis(0), axis(9), 0.4));
  await seedFinding("find-far", "003.1.1A", blend(axis(0), axis(9), 0.7));
  await seedCatalogue("cat-1", blend(axis(0), axis(9), 0.2));
  await seedCatalogue("cat-2", blend(axis(0), axis(9), 0.5));

  // The seed itself is a catalogue row aimed at axis 0 — so the Turso fold ranks find-near first.
  await seedCatalogue("seed-1", axis(0));
  await saveRecSeed(user, { trackId: "seed-1" });

  return user;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  searchSonar.mockReset();
  isSonarRecsEnabled.mockReset();
  isSonarRecsEnabled.mockResolvedValue(false);
  // The CATALOGUE scan rides its OWN flag (sonar_recs_catalogue_enabled) and is off throughout
  // this suite — everything here is about the findings slots.
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

    // The exact fold: nearest finding first, and the seeded row never recommended back.
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

    // Exactly ONE call — the findings slots. The catalogue scan deliberately does not route.
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

    // sonar takes the DECODED vector, not the raw f32 BLOB the Turso scan binds.
    expect(probes).toHaveLength(1);
    expect(probes[0]).toHaveLength(EMBEDDING_DIMS);
    expect(Array.isArray(probes[0])).toBe(true);
    expect(typeof probes[0]?.[0]).toBe("number");
  });

  it("FLAG ON: the findings slots hydrate in SONAR'S order, carrying sonar's similarity", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsEnabled.mockResolvedValue(true);
    // sonar contradicts the Turso order on purpose: the output must follow sonar.
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
    // Similarity survives the `1 − score` → `1 − dist` round trip intact.
    expect(result.findings[0]?.similarity).toBeCloseTo(0.91, 6);
    expect(result.findings[1]?.similarity).toBeCloseTo(0.42, 6);
    // Full voice still rides the slot — the Log ID is read from the hydrated row, never from sonar.
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

    // The uncertified, anchored, embedded rows — ranked by the Turso fold, seed excluded. sonar
    // returned no catalogue ids at all, and the page is unaffected by that.
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

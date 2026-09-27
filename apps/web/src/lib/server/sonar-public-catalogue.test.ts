import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LONG_FORM_MS } from "../catalogue-eligibility";
import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";
import { SONAR_MAX_TOP_K, type SonarMatch } from "./sonar";

const searchSonar = vi.hoisted(() => vi.fn());
let db: Client;

vi.mock("./sonar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sonar")>();

  return { ...actual, searchSonar };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

import {
  SONAR_PUBLIC_CATALOGUE_TOP_K_CEILING,
  searchSonarPublicCatalogue,
} from "./sonar-public-catalogue";

const RANKED = ["a", "spoken-1", "spoken-2", "b", "c"];

beforeEach(async () => {
  db = await createIntegrationDb();
  searchSonar.mockReset();
  for (const trackId of RANKED) {
    await seedCatalogueTrack(db, {
      title: trackId.startsWith("spoken") ? "Rewind (Commentary)" : "Rewind",
      trackId,
    });
  }
  searchSonar.mockImplementation(
    async ({ topK }: { topK: number }): Promise<SonarMatch[]> =>
      RANKED.slice(0, topK).map((id, index) => ({ id, score: 1 - index / 10 })),
  );
});

describe("searchSonarPublicCatalogue", () => {
  it("backfills past hidden hits so a spoken-word match never costs a slot", async () => {
    const matches = await searchSonarPublicCatalogue({
      index: "tracks",
      probes: [[1]],
      topK: 2,
    });

    expect(matches?.map((match) => match.id)).toEqual(["a", "b"]);
    expect(searchSonar).toHaveBeenCalledTimes(2);
    expect(searchSonar).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        filter: { duration_ms_max: LONG_FORM_MS, has_finding: false },
        topK: 2,
      }),
    );
  });

  it("asks once when the first page holds no hidden hit", async () => {
    await db.execute(`update tracks set title = 'Rewind' where track_id like 'spoken-%'`);

    const matches = await searchSonarPublicCatalogue({ index: "tracks", probes: [[1]], topK: 3 });

    expect(matches?.map((match) => match.id)).toEqual(["a", "spoken-1", "spoken-2"]);
    expect(searchSonar).toHaveBeenCalledTimes(1);
  });

  it("returns every visible hit when the corpus runs out before the page fills", async () => {
    const matches = await searchSonarPublicCatalogue({ index: "tracks", probes: [[1]], topK: 5 });

    expect(matches?.map((match) => match.id)).toEqual(["a", "b", "c"]);
  });

  it("passes an unavailable engine through as null", async () => {
    searchSonar.mockResolvedValue(null);

    expect(
      await searchSonarPublicCatalogue({ index: "tracks", probes: [[1]], topK: 2 }),
    ).toBeNull();
  });

  it("never asks the engine for more than its top-k ceiling", () => {
    expect(SONAR_PUBLIC_CATALOGUE_TOP_K_CEILING).toBe(SONAR_MAX_TOP_K);
  });
});

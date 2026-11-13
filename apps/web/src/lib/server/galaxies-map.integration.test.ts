import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

describe("updateGalaxyFields", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  it("refuses an update with no field as a 400 request error, never an internal fault", async () => {
    const { updateGalaxyFields, updateGalaxyMap } = await import("./galaxies-map");

    await updateGalaxyMap([{ centroid: [1, 0], id: "gal-live" }]);

    await expect(updateGalaxyFields("gal-live", {})).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });
});

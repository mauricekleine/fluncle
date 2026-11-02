import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { getRandomRadioTrack, getRandomTrack } from "./tracks";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  await seedTrack(db, { logId: "001.1.1A", title: "Squared", trackId: "finding-squared" });
  await seedTrack(db, { logId: "002.1.1A", title: "Unsquared", trackId: "finding-unsquared" });
  await seedCatalogueTrack(db, { title: "Catalogue", trackId: "catalogue-only" });
  await db.execute({
    args: ["2026-06-10T00:00:00.000Z", "https://example.com/observation.mp3", "finding-squared"],
    sql: `update findings set video_squared_at = ?, observation_audio_url = ? where track_id = ?`,
  });
});

describe("random finding picks", () => {
  it("only ever draws a certified finding, hydrated with its log id", async () => {
    const drawn = new Set<string>();

    for (let i = 0; i < 20; i += 1) {
      const track = await getRandomTrack();

      expect(track?.logId).toBeDefined();
      drawn.add(track?.trackId ?? "");
    }

    expect([...drawn].every((id) => id.startsWith("finding-"))).toBe(true);
  });

  it("draws the radio pick only from squared, observed findings", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await getRandomRadioTrack())?.trackId).toBe("finding-squared");
    }
  });

  it("returns nothing when no finding is radio-eligible", async () => {
    await db.execute(`update findings set video_squared_at = null`);

    expect(await getRandomRadioTrack()).toBeUndefined();
  });
});

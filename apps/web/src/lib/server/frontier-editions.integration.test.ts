import { type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FrontierEditionTrackInput,
  frontierEditionInsertStatements,
  getFrontierEdition,
  getFrontierEditions,
} from "./frontier-editions";
import { createIntegrationDb } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

async function insertEdition(
  userId: string,
  createdAt: string,
  tracks: FrontierEditionTrackInput[],
  meta?: { seedsSkipped?: string[]; seedsUsed?: number },
): Promise<void> {
  await db.batch(
    frontierEditionInsertStatements({
      createdAt,
      editionId: randomUUID(),
      seedsSkipped: meta?.seedsSkipped,
      seedsUsed: meta?.seedsUsed,
      tracks,
      userId,
    }),
    "write",
  );
}

const findingTrack: FrontierEditionTrackInput = {
  artists: ["Finding Artist", "Featured"],
  bpm: 174,
  durationMs: 270_000,
  imageUrl: "https://covers.example/finding.jpg",
  key: "A minor",
  logId: "001.1.1A",
  position: 1,
  similarity: 0.9231,
  slot: "finding",
  spotifyUri: "spotify:track:finding-1",
  spotifyUrl: "https://open.spotify.com/track/finding-1",
  title: "Finding One",
  trackId: "finding-1",
};

const catalogueTrack: FrontierEditionTrackInput = {
  artists: ["Catalogue Artist"],
  position: 2,
  slot: "catalogue",
  spotifyUrl: "https://open.spotify.com/track/cat-1",
  title: "Catalogue One",
  trackId: "cat-1",
};

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("getFrontierEditions", () => {
  it("lists a user's editions newest-first with the frozen track count", async () => {
    await insertEdition("user-A", "2026-07-04T10:00:00.000Z", [findingTrack]);
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack, catalogueTrack]);

    const editions = await getFrontierEditions("user-A");

    expect(editions.map((edition) => edition.number)).toEqual([2, 1]);
    expect(editions[0]).toEqual({
      number: 2,
      refreshedAt: "2026-07-11T10:00:00.000Z",
      trackCount: 2,
    });
    expect(editions[1]?.trackCount).toBe(1);
  });

  it("scopes to the user — B never sees A's editions", async () => {
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack]);

    expect(await getFrontierEditions("user-B")).toEqual([]);
  });
});

describe("getFrontierEdition", () => {
  it("returns the frozen tracklist in position order with the register split and readouts", async () => {
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack, catalogueTrack]);

    const edition = await getFrontierEdition("user-A", 1);

    expect(edition).toBeDefined();

    if (!edition) {
      return;
    }

    expect(edition.summary).toEqual({
      number: 1,
      refreshedAt: "2026-07-11T10:00:00.000Z",
      trackCount: 2,
    });

    const [finding, catalogue] = edition.tracks;

    expect(finding?.trackId).toBe("finding-1");
    expect(finding?.slot).toBe("finding");
    expect(finding?.logId).toBe("001.1.1A");
    expect(finding?.artists).toEqual(["Finding Artist", "Featured"]);
    expect(finding?.imageUrl).toBe("https://covers.example/finding.jpg");
    expect(finding?.spotifyUrl).toBe("https://open.spotify.com/track/finding-1");
    expect(finding?.bpm).toBe(174);
    expect(finding?.key).toBe("A minor");
    expect(finding?.durationMs).toBe(270_000);

    expect(finding?.similarity).toBeCloseTo(0.9231, 4);

    expect(catalogue?.trackId).toBe("cat-1");
    expect(catalogue?.slot).toBe("catalogue");
    expect(catalogue?.logId).toBeUndefined();
    expect(catalogue?.imageUrl).toBeUndefined();
    expect(catalogue?.bpm).toBeUndefined();
    expect(catalogue?.key).toBeUndefined();
    expect(catalogue?.durationMs).toBeUndefined();

    expect(catalogue?.similarity).toBeUndefined();
  });

  it("freezes and reads back the edition's seed-accounting honesty meta", async () => {
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack], {
      seedsSkipped: ["seed-x", "seed-y"],
      seedsUsed: 3,
    });

    const edition = await getFrontierEdition("user-A", 1);

    expect(edition?.summary.seedsUsed).toBe(3);
    expect(edition?.summary.seedsSkipped).toEqual(["seed-x", "seed-y"]);

    const [summary] = await getFrontierEditions("user-A");
    expect(summary?.seedsUsed).toBe(3);
    expect(summary?.seedsSkipped).toEqual(["seed-x", "seed-y"]);
  });

  it("degrades a seed-meta-less edition to undefined (the pre-migration shape)", async () => {
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack]);

    const [summary] = await getFrontierEditions("user-A");
    expect(summary?.seedsUsed).toBeUndefined();
    expect(summary?.seedsSkipped).toBeUndefined();
  });

  it("is user-scoped: the number alone never fetches another user's edition", async () => {
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack]);

    expect(await getFrontierEdition("user-B", 1)).toBeUndefined();
    expect(await getFrontierEdition("user-A", 99)).toBeUndefined();
  });
});

describe("frontierEditionInsertStatements", () => {
  it("derives a per-user monotonic number (coalesce(max,0)+1) across successive editions", async () => {
    await insertEdition("user-A", "2026-07-04T10:00:00.000Z", [findingTrack]);
    await insertEdition("user-A", "2026-07-11T10:00:00.000Z", [findingTrack]);
    await insertEdition("user-A", "2026-07-18T10:00:00.000Z", [findingTrack]);

    await insertEdition("user-B", "2026-07-18T10:00:00.000Z", [findingTrack]);

    expect((await getFrontierEditions("user-A")).map((edition) => edition.number)).toEqual([
      3, 2, 1,
    ]);
    expect((await getFrontierEditions("user-B")).map((edition) => edition.number)).toEqual([1]);
  });
});

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeDueWorkOrder } from "./due-work-order";
import { upsertDueWork, type DueWorkProjection } from "./due-work";
import { TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { setSetting } from "./settings";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

const ADDED_NEW = "2026-08-26T12:00:00.000Z";
const ADDED_OLD = "2026-08-25T12:00:00.000Z";

function findingOrder(addedAt: string, trackId: string, idDirection: "asc" | "desc" = "desc") {
  return encodeDueWorkOrder([
    { direction: "desc", kind: "timestamp", nulls: "last", value: addedAt },
    { direction: idDirection, kind: "text", value: trackId },
  ]);
}

function catalogueOrder(capturePriority: number | null, trackId: string) {
  return encodeDueWorkOrder([
    { direction: "desc", kind: "boolean", value: capturePriority !== null },
    { direction: "desc", kind: "number", value: capturePriority ?? 0 },
    { direction: "desc", kind: "text", value: trackId },
  ]);
}

async function project(workKind: string, subjectId: string, sortKey: string): Promise<void> {
  const projection: DueWorkProjection<string> = {
    nextDueAt: "2020-01-01T00:00:00.000Z",
    sortKey,
    sourceVersion: `test-${workKind}-${subjectId}`,
    state: "scheduled",
    subjectId,
    subjectType: "track",
    workKind,
  };
  await upsertDueWork(db, projection);
}

async function withVendorFields(
  trackId: string,
  options: { capturePriority?: number | null; isrc?: string } = {},
): Promise<void> {
  await db.execute({
    args: [options.isrc ?? `ISRC-${trackId}`, options.capturePriority ?? null, trackId],
    sql: `update tracks set isrc = ?, capture_priority = ? where track_id = ?`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  db.close();
});

describe("vendor backfill Goal C cutover", () => {
  it("is default-off and excludes unprojected findings after the exact flag is enabled", async () => {
    await seedTrack(db, {
      addedAt: ADDED_NEW,
      addedToSpotify: true,
      logId: "LOG-LEGACY",
      postedToTelegram: true,
      trackId: "legacy-finding",
    });
    await withVendorFields("legacy-finding");

    const { backfillAppleMusicUrls } = await import("./backfill");
    expect((await backfillAppleMusicUrls(1, true)).unresolved).toEqual(["LOG-LEGACY"]);

    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    expect((await backfillAppleMusicUrls(1, true)).unresolved).toEqual([]);
  });

  it("promotes ordered finding rows, hydrates only selected IDs, and preserves the legacy cursor", async () => {
    for (const row of [
      { addedAt: ADDED_NEW, logId: "LOG-NEW", trackId: "finding-new" },
      { addedAt: ADDED_OLD, logId: "LOG-OLD", trackId: "finding-old" },
      { addedAt: "2026-08-24T12:00:00.000Z", logId: "LOG-HIDDEN", trackId: "not-projected" },
    ]) {
      await seedTrack(db, {
        ...row,
        addedToSpotify: true,
        postedToTelegram: true,
      });
      await withVendorFields(row.trackId);
    }
    await project("apple-finding", "finding-old", findingOrder(ADDED_OLD, "finding-old"));
    await project("apple-finding", "finding-new", findingOrder(ADDED_NEW, "finding-new"));
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const execute = vi.spyOn(db, "execute");
    const { backfillAppleMusicUrls } = await import("./backfill");
    const first = await backfillAppleMusicUrls(1, true);
    expect(first.unresolved).toEqual(["LOG-NEW"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await backfillAppleMusicUrls(1, true, first.nextCursor ?? undefined);
    expect(second.unresolved).toEqual(["LOG-OLD"]);
    expect(second.unresolved).not.toContain("LOG-HIDDEN");

    const findingHydrations = execute.mock.calls.filter((call) => {
      const statement = call[0] as { args?: unknown[]; sql?: string };
      return statement.sql?.includes("where tracks.track_id in (") === true;
    });
    expect(
      findingHydrations.map((call) => (call[0] as unknown as { args: unknown[] }).args),
    ).toEqual([["finding-new", "finding-old"], ["finding-old"]]);
  });

  it("intersects recurring Discogs verdict evidence with the projection only when enabled", async () => {
    const rows = [
      { addedAt: ADDED_OLD, logId: "LOG-OLD", trackId: "discogs-old" },
      { addedAt: ADDED_NEW, logId: "LOG-NEW", trackId: "discogs-new" },
      {
        addedAt: "2026-08-24T12:00:00.000Z",
        logId: "LOG-HIDDEN",
        trackId: "discogs-hidden",
      },
    ];
    for (const row of rows) {
      await seedTrack(db, {
        ...row,
        addedToSpotify: true,
        postedToTelegram: true,
      });
    }
    const discogsCandidates = rows.map((row) => ({ releases: [], trackId: row.trackId }));

    const { backfillDiscogsIds } = await import("./backfill");
    const legacy = await backfillDiscogsIds(3, true, undefined, { discogsCandidates });
    expect(legacy.unresolved).toEqual(["LOG-OLD", "LOG-NEW", "LOG-HIDDEN"]);

    await project("discogs-track", "discogs-old", findingOrder(ADDED_OLD, "discogs-old"));
    await project("discogs-track", "discogs-new", findingOrder(ADDED_NEW, "discogs-new"));
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const projected = await backfillDiscogsIds(3, true, undefined, { discogsCandidates });
    expect(projected.unresolved).toEqual(["LOG-NEW", "LOG-OLD"]);
    expect(projected.unresolved).not.toContain("LOG-HIDDEN");
  });

  it("keeps findings ahead of catalogue and restores each physical projection order", async () => {
    await seedTrack(db, {
      addedAt: ADDED_NEW,
      addedToSpotify: true,
      logId: "LOG-FINDING",
      postedToTelegram: true,
      trackId: "tier-finding",
    });
    await withVendorFields("tier-finding");
    await seedCatalogueTrack(db, { trackId: "catalogue-high" });
    await withVendorFields("catalogue-high", { capturePriority: 100 });
    await seedCatalogueTrack(db, { trackId: "catalogue-low" });
    await withVendorFields("catalogue-low", { capturePriority: 1 });
    await seedCatalogueTrack(db, { trackId: "catalogue-hidden" });
    await withVendorFields("catalogue-hidden", { capturePriority: 999 });

    await project("beatport-finding", "tier-finding", findingOrder(ADDED_NEW, "tier-finding"));
    await project("beatport-catalogue", "catalogue-low", catalogueOrder(1, "catalogue-low"));
    await project("beatport-catalogue", "catalogue-high", catalogueOrder(100, "catalogue-high"));
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const { backfillBeatportUrls } = await import("./backfill");
    const result = await backfillBeatportUrls(3, true);
    expect(result.unresolved).toEqual(["LOG-FINDING"]);
    expect(result.catalogueUnresolved).toEqual(["catalogue-high", "catalogue-low"]);
    expect(result.catalogueUnresolved).not.toContain("catalogue-hidden");
  });

  it("concatenates the physical Deezer finding and catalogue pages", async () => {
    await seedTrack(db, {
      addedAt: ADDED_NEW,
      addedToSpotify: true,
      logId: "LOG-DEEZER",
      postedToTelegram: true,
      trackId: "deezer-finding",
    });
    await withVendorFields("deezer-finding");
    await seedCatalogueTrack(db, { trackId: "deezer-catalogue" });
    await withVendorFields("deezer-catalogue", { capturePriority: 500 });
    await project(
      "deezer-finding",
      "deezer-finding",
      findingOrder(ADDED_NEW, "deezer-finding", "asc"),
    );
    await project("deezer-catalogue", "deezer-catalogue", catalogueOrder(500, "deezer-catalogue"));
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const { backfillDeezer } = await import("./backfill");
    expect((await backfillDeezer(2, true)).unresolved).toEqual([
      "deezer-finding",
      "deezer-catalogue",
    ]);
  });
});

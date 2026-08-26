import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Client } from "@libsql/client";

import { createIntegrationDb } from "./integration-db";
import { compareDueWorkShadow, readProjectedTrackWorkIds } from "./due-work-shadow";
import { upsertDueWork } from "./due-work";

const NOW = new Date("2026-08-26T12:00:00.000Z");
let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("due-work shadow comparison", () => {
  it("reports membership and order drift separately", () => {
    expect(compareDueWorkShadow(["a", "b"], ["b", "a"])).toMatchObject({
      matched: false,
      missingIds: [],
      orderMismatch: true,
      unexpectedIds: [],
    });
    expect(compareDueWorkShadow(["a", "b"], ["a", "c"])).toMatchObject({
      matched: false,
      missingIds: ["b"],
      orderMismatch: false,
      unexpectedIds: ["c"],
    });
  });

  it("promotes scheduled rows and preserves findings-before-catalogue ordering", async () => {
    await upsertDueWork(
      db,
      {
        nextDueAt: "2026-08-26T11:00:00.000Z",
        sortKey: "02",
        sourceVersion: "v-finding",
        state: "scheduled",
        subjectId: "finding",
        subjectType: "track",
        workKind: "capture-findings",
      },
      { now: NOW },
    );
    await upsertDueWork(
      db,
      {
        nextDueAt: NOW.toISOString(),
        sortKey: "01",
        sourceVersion: "v-catalogue",
        state: "ready",
        subjectId: "catalogue",
        subjectType: "track",
        workKind: "capture-catalogue",
      },
      { now: NOW },
    );

    await expect(
      readProjectedTrackWorkIds(db, {
        kind: "capture",
        limit: 2,
        now: () => NOW,
        scope: "all",
      }),
    ).resolves.toEqual(["finding", "catalogue"]);
  });

  it("merges re-verdict halves by their global verdict order", async () => {
    await upsertDueWork(
      db,
      {
        nextDueAt: NOW.toISOString(),
        sortKey: "02",
        sourceVersion: "v-finding",
        state: "ready",
        subjectId: "finding",
        subjectType: "track",
        workKind: "youtube-reverdict-findings",
      },
      { now: NOW },
    );
    await upsertDueWork(
      db,
      {
        nextDueAt: NOW.toISOString(),
        sortKey: "01",
        sourceVersion: "v-catalogue",
        state: "ready",
        subjectId: "catalogue",
        subjectType: "track",
        workKind: "youtube-reverdict-catalogue",
      },
      { now: NOW },
    );

    await expect(
      readProjectedTrackWorkIds(db, {
        kind: "youtube-reverdict",
        limit: 2,
        now: () => NOW,
        scope: "all",
      }),
    ).resolves.toEqual(["catalogue", "finding"]);
  });
});

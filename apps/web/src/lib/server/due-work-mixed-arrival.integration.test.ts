import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";

import { WorkerDatabaseConcurrencyGate } from "../database-concurrency";
import { getScaleManifest, type ScaleProfile } from "../../../scripts/db-performance/manifest";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listReadyDueWork,
  markDueWorkRepair,
  markDueWorkSourceRepairsStatement,
} from "./due-work";
import { createIntegrationDb } from "./integration-db";
import { advanceProjectionFor } from "./projection-operations";

const TICK_LOGICAL_MS = 300_000;
const WINDOW_LOGICAL_MS = 3_600_000;
const exactProfiles = process.env.FLUNCLE_EXACT_MIXED_ARRIVAL === "true";
const fixtureDirectories: string[] = [];

type ArrivalCase = {
  label: string;
  ordinary: number;
  physical: number;
  profile: ScaleProfile;
  rankIntervalMs: number;
  tracks: number;
};
type ArrivalTime = { logicalAtMs: number; wallDeadlineMs: number };
type Debt = {
  artistEdges: number;
  ordinary: number;
  physical: number;
  rankScanned: number;
  rankUnfinished: boolean;
  rows: { subjectId: string; workKind: string }[];
};

const exactCases: ArrivalCase[] = [
  {
    label: "1x data / base synthetic arrivals",
    ordinary: 3,
    physical: 3,
    profile: "1x",
    rankIntervalMs: 1_800_000,
    tracks: getScaleManifest("1x").counts.tracks,
  },
  {
    label: "2x data / base synthetic arrivals",
    ordinary: 3,
    physical: 3,
    profile: "2x",
    rankIntervalMs: 1_800_000,
    tracks: getScaleManifest("2x").counts.tracks,
  },
  {
    label: "2x data / doubled synthetic arrivals",
    ordinary: 6,
    physical: 6,
    profile: "2x",
    rankIntervalMs: 900_000,
    tracks: getScaleManifest("2x").counts.tracks,
  },
];
const cases = exactProfiles
  ? exactCases
  : exactCases.map((entry) => ({
      ...entry,
      label: `${entry.label} (compact correctness derivative)`,
      tracks: entry.profile === "1x" ? 240 : 480,
    }));

async function seedTracks(client: Client, count: number): Promise<void> {
  for (let start = 0; start < count; start += 200) {
    const ids = Array.from(
      { length: Math.min(200, count - start) },
      (_, offset) => `mixed-${String(start + offset).padStart(6, "0")}`,
    );
    await client.execute({
      args: ids.flatMap((id) => [
        id,
        `Track ${id}`,
        '["Mixed Artist"]',
        `spotify:track:${id}`,
        270_000,
        1,
      ]),
      sql: `insert into tracks
        (track_id, title, artists_json, spotify_uri, duration_ms, capture_priority)
        values ${ids.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
    });
  }
}

async function readDebt(client: Client): Promise<Debt> {
  const [repairs, rank] = await Promise.all([
    client.execute(`select work_kind, subject_id from due_work where state = 'repair'
      order by work_kind, subject_id`),
    client.execute(`select scanned_count, state from due_work_rebuilds
      where work_kind = 'catalogue-rank' and subject_type = 'track'`),
  ]);
  const rows = repairs.rows.map((row) => ({
    subjectId: typeof row.subject_id === "string" ? row.subject_id : "",
    workKind: typeof row.work_kind === "string" ? row.work_kind : "",
  }));
  const rankRow = rank.rows[0];
  return {
    artistEdges: rows.filter((row) => row.workKind === "artist-edges").length,
    ordinary: rows.filter(
      (row) =>
        row.workKind === DUE_WORK_SOURCE_REPAIR_KIND &&
        row.subjectId !== DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
    ).length,
    physical: rows.filter((row) => row.workKind !== DUE_WORK_SOURCE_REPAIR_KIND).length,
    rankScanned: Number(rankRow?.scanned_count ?? 0),
    rankUnfinished:
      (rankRow !== undefined && rankRow.state !== "complete") ||
      rows.some(
        (row) =>
          row.workKind === DUE_WORK_SOURCE_REPAIR_KIND &&
          row.subjectId === DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
      ),
    rows,
  };
}

async function withGate<T>(
  gate: WorkerDatabaseConcurrencyGate,
  access: "read" | "write",
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await gate.acquire(access);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

function readOldestAge(
  debt: Debt,
  sourceTimes: Map<string, ArrivalTime>,
  physicalTimes: Map<string, ArrivalTime>,
  rankTimes: ArrivalTime[],
  logicalNowMs: number,
): { logical: number; wall: number } {
  const pending = debt.rows.flatMap((row) => {
    const time =
      row.workKind === DUE_WORK_SOURCE_REPAIR_KIND
        ? sourceTimes.get(row.subjectId)
        : (physicalTimes.get(`${row.workKind}:${row.subjectId}`) ?? sourceTimes.get(row.subjectId));
    return time === undefined ? [] : [time];
  });
  if (debt.rankUnfinished) {
    pending.push(...rankTimes);
  }
  return pending.length === 0
    ? { logical: 0, wall: 0 }
    : {
        logical: Math.max(...pending.map((time) => logicalNowMs - time.logicalAtMs)),
        wall: Math.max(...pending.map((time) => performance.now() - time.wallDeadlineMs)),
      };
}

afterAll(async () => {
  await Promise.all(
    fixtureDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("real due-work maintenance under independent arrivals", () => {
  it.each(cases)(
    "$label",
    async (testCase) => {
      const directory = await mkdtemp(join(tmpdir(), `fluncle-mixed-${testCase.profile}-`));
      fixtureDirectories.push(directory);
      const db = await createIntegrationDb({ url: `file:${join(directory, "fixture.db")}` });
      const gate = new WorkerDatabaseConcurrencyGate();
      const wallTickMs = exactProfiles ? 5_000 : 5;
      const sourceTimes = new Map<string, ArrivalTime>();
      const physicalTimes = new Map<string, ArrivalTime>();
      const rankTimes: ArrivalTime[] = [];
      const serviceMs: number[] = [];
      const oldestLogicalMs: number[] = [];
      const oldestWallMs: number[] = [];
      const admissionDelayMs: number[] = [];
      const fairness: boolean[] = [];
      const debtEvolution: { ordinary: number; physical: number; rankUnfinished: boolean }[] = [];
      let producerComplete = false;
      let producerCompletedAt = 0;
      let ordinarySequence = 0;
      let physicalSequence = 0;
      let rankSequence = 0;
      let ordinaryAdmitted = 0;
      let physicalAdmitted = 0;
      let rankAdmitted = 0;
      let captureReadyObserved = 0;
      let edgeReadyObserved = 0;
      const timerController = new AbortController();
      let producer: Promise<void> | undefined;

      try {
        await seedTracks(db, testCase.tracks);
        expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n ?? 0)).toBe(
          testCase.tracks,
        );
        const schedule = Array.from(
          { length: WINDOW_LOGICAL_MS / TICK_LOGICAL_MS },
          (_, index) => index * TICK_LOGICAL_MS,
        );
        const startedAt = performance.now();
        let resolveFirstAdmission: (() => void) | undefined;
        const firstAdmission = new Promise<void>((resolve) => {
          resolveFirstAdmission = resolve;
        });
        producer = Promise.all(
          schedule.map(async (logicalAtMs) => {
            const wallDeadlineMs = startedAt + (logicalAtMs / TICK_LOGICAL_MS) * wallTickMs;
            await sleep(Math.max(0, wallDeadlineMs - performance.now()), undefined, {
              signal: timerController.signal,
            });
            const ordinaryIds = Array.from(
              { length: testCase.ordinary },
              () => `mixed-${String(ordinarySequence++).padStart(6, "0")}`,
            );
            await db.execute(
              markDueWorkSourceRepairsStatement(
                ordinaryIds.map((subjectId) => ({ subjectId, subjectType: "track" as const })),
                {
                  markerVersion: `mixed-ordinary-${logicalAtMs}`,
                  producer: "capture-verification",
                },
              ),
            );
            ordinaryIds.forEach((subjectId) =>
              sourceTimes.set(subjectId, { logicalAtMs, wallDeadlineMs }),
            );
            ordinaryAdmitted += ordinaryIds.length;
            for (let index = 0; index < testCase.physical; index += 1) {
              const subjectId = `mixed-${String(Math.floor(testCase.tracks / 2) + physicalSequence++).padStart(6, "0")}`;
              await markDueWorkRepair(db, {
                sourceVersion: `mixed-physical-${logicalAtMs}-${index}`,
                subjectId,
                subjectType: "track",
                workKind: "artist-edges",
              });
              physicalTimes.set(`artist-edges:${subjectId}`, { logicalAtMs, wallDeadlineMs });
              physicalAdmitted += 1;
            }
            if (logicalAtMs % testCase.rankIntervalMs === 0) {
              await db.execute(
                markDueWorkSourceRepairsStatement(
                  [{ subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" }],
                  { markerVersion: `mixed-rank-${rankSequence++}`, producer: "catalogue-rank" },
                ),
              );
              rankTimes.push({ logicalAtMs, wallDeadlineMs });
              rankAdmitted += 1;
            }
            admissionDelayMs.push(Math.max(0, performance.now() - wallDeadlineMs));
            if (logicalAtMs === 0) {
              resolveFirstAdmission?.();
            }
          }),
        )
          .then(async () => {
            const wallWindowDeadlineMs = startedAt + schedule.length * wallTickMs;
            await sleep(Math.max(0, wallWindowDeadlineMs - performance.now()), undefined, {
              signal: timerController.signal,
            });
          })
          .finally(() => {
            producerCompletedAt = performance.now();
            producerComplete = true;
          });

        const maximumActions = Math.ceil(testCase.tracks / 100) + 200;
        await Promise.race([firstAdmission, producer]);
        for (let actions = 0; actions < maximumActions;) {
          const before = await readDebt(db);
          if (before.rows.length === 0 && !before.rankUnfinished) {
            if (producerComplete) {
              break;
            }
            await sleep(25, undefined, { signal: timerController.signal });
            continue;
          }
          await Promise.all([
            withGate(gate, "write", async () => {
              const serviceStarted = performance.now();
              const result = await advanceProjectionFor(db, {
                action: "repair",
                includeStatus: false,
                limit: 500,
                target: "track_due_work",
              });
              serviceMs.push(performance.now() - serviceStarted);
              return result;
            }),
            withGate(gate, "read", () => listReadyDueWork(db, "capture-catalogue", { limit: 1 })),
            withGate(gate, "read", () => listReadyDueWork(db, "artist-edges", { limit: 1 })),
            withGate(gate, "read", () => db.execute("select 1 as ok")),
          ]);
          actions += 1;
          const after = await readDebt(db);
          if (before.ordinary > 0 && before.artistEdges > 0 && before.rankUnfinished) {
            const afterIdentities = new Set(
              after.rows.map((row) => `${row.workKind}:${row.subjectId}`),
            );
            const resolvedSourceIds = before.rows.filter(
              (row) =>
                row.workKind === DUE_WORK_SOURCE_REPAIR_KIND &&
                row.subjectId !== DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID &&
                !afterIdentities.has(`${row.workKind}:${row.subjectId}`),
            );
            const resolvedArtistEdgeIds = before.rows.filter(
              (row) =>
                row.workKind === "artist-edges" &&
                !afterIdentities.has(`${row.workKind}:${row.subjectId}`),
            );
            fairness.push(
              resolvedSourceIds.length > 0 &&
                resolvedArtistEdgeIds.length > 0 &&
                (after.rankScanned > before.rankScanned || !after.rankUnfinished),
            );
          }
          if (!after.rankUnfinished) {
            rankTimes.splice(0);
          }
          const ready = await db.execute(`select work_kind, count(*) as n from due_work
          where work_kind in ('capture-catalogue', 'artist-edges') and state = 'ready' group by work_kind`);
          for (const row of ready.rows) {
            if (row.work_kind === "capture-catalogue") {
              captureReadyObserved = Math.max(captureReadyObserved, Number(row.n));
            }
            if (row.work_kind === "artist-edges") {
              edgeReadyObserved = Math.max(edgeReadyObserved, Number(row.n));
            }
          }
          const logicalNowMs = Math.min(
            WINDOW_LOGICAL_MS,
            (performance.now() - startedAt) * (TICK_LOGICAL_MS / wallTickMs),
          );
          const age = readOldestAge(after, sourceTimes, physicalTimes, rankTimes, logicalNowMs);
          debtEvolution.push({
            ordinary: after.ordinary,
            physical: after.physical,
            rankUnfinished: after.rankUnfinished,
          });
          oldestLogicalMs.push(age.logical);
          oldestWallMs.push(age.wall);
        }
        await producer;

        const finalDebt = await readDebt(db);
        const [capture, edges] = await Promise.all([
          listReadyDueWork(db, "capture-catalogue", { limit: 500 }),
          listReadyDueWork(db, "artist-edges", { limit: 500 }),
        ]);
        expect({ ordinaryAdmitted, physicalAdmitted, rankAdmitted }).toEqual({
          ordinaryAdmitted: testCase.ordinary * 12,
          physicalAdmitted: testCase.physical * 12,
          rankAdmitted: WINDOW_LOGICAL_MS / testCase.rankIntervalMs,
        });
        expect(fairness.length).toBeGreaterThan(0);
        expect(fairness.every(Boolean)).toBe(true);
        expect(finalDebt.rows).toEqual([]);
        expect(finalDebt.rankUnfinished).toBe(false);
        expect(captureReadyObserved).toBeGreaterThan(0);
        expect(edgeReadyObserved).toBeGreaterThan(0);
        expect(capture.items.length).toBeGreaterThan(0);
        expect(edges.items.length).toBeGreaterThan(0);
        expect(gate.snapshot()).toMatchObject({
          aggregateInFlight: 0,
          aggregateObservedMaximum: 4,
        });
        expect(oldestLogicalMs).toHaveLength(serviceMs.length);
        expect(oldestWallMs).toHaveLength(serviceMs.length);
        const offeredWallSeconds = Math.max(0.001, (schedule.length * wallTickMs) / 1_000);
        const admittedWallSeconds = Math.max(0.001, (producerCompletedAt - startedAt) / 1_000);
        console.info(
          JSON.stringify({
            acceleration: TICK_LOGICAL_MS / wallTickMs,
            actualServiceMs: serviceMs,
            admissionDelayMs,
            admittedWallRatePerSecond: {
              ordinary: ordinaryAdmitted / admittedWallSeconds,
              physical: physicalAdmitted / admittedWallSeconds,
              rank: rankAdmitted / admittedWallSeconds,
            },
            arrivalClass: "synthetic-capacity",
            debtEvolution,
            exactProfileCardinality: exactProfiles,
            logicalOldestAgeMs: oldestLogicalMs,
            offeredWallRatePerSecond: {
              ordinary: ordinaryAdmitted / offeredWallSeconds,
              physical: physicalAdmitted / offeredWallSeconds,
              rank: rankAdmitted / offeredWallSeconds,
            },
            profile: testCase.profile,
            rankCohort:
              "unchanged-corpus markers prove resumable maintenance fairness; material revision replacement is covered elsewhere",
            readyCohorts: { artistEdges: edges.items.length, capture: capture.items.length },
            serviceLimits: { ordinary: 5, physical: 50, rankRows: 100 },
            tracks: testCase.tracks,
            wallOldestAgeMs: oldestWallMs,
          }),
        );
      } finally {
        timerController.abort();
        await producer?.catch(() => undefined);
        db.close();
      }
    },
    exactProfiles ? 20 * 60_000 : 60_000,
  );
});

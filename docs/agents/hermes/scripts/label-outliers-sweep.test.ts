import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMBEDDING_DIMENSIONS, type LabelOutlierRun, scoreCatalogue } from "./label-outliers";
import { writeScoringExport } from "./label-outliers-export";
import {
  type AlertedUnit,
  type CorpusFloor,
  discordMessage,
  MAX_RECORDED_OUTLIERS,
  readEmbedding,
  readReplicaInputs,
  type RecordPayload,
  runLabelOutliersSweep,
  type ScoreOutcome,
  scoreExportFile,
  type SweepDeps,
  toPayload,
} from "./label-outliers-sweep";

const scratch: string[] = [];

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "label-outliers-test-"));
  scratch.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const TEST_FLOOR: CorpusFloor = { minTracks: 1, minUsableFraction: 0.95 };

function blobToward(axis: number, jitter: number): Uint8Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  vector[axis] = 1;
  vector[(axis + 1) % 16] = jitter;

  return new Uint8Array(vector.buffer);
}

function seedReplica(database: Database): void {
  database.run(`create table tracks (
    track_id text primary key, label_id text, album_id text,
    is_catalogue integer not null default 1, has_embedding integer not null default 0)`);
  database.run(
    "create table track_embeddings (track_id text primary key, embedding_blob blob not null)",
  );
  database.run("create table track_artists (track_id text not null, artist_id text not null)");
  database.run("create table albums (id text primary key, discogs_styles text)");

  const insertTrack = database.prepare(
    "insert into tracks (track_id, label_id, album_id, is_catalogue, has_embedding) values (?, ?, ?, ?, 1)",
  );
  const insertEmbedding = database.prepare(
    "insert into track_embeddings (track_id, embedding_blob) values (?, ?)",
  );

  for (let album = 0; album < 10; album += 1) {
    for (let track = 0; track < 2; track += 1) {
      const trackId = `t${album}_${track}`;
      insertTrack.run(trackId, "lbl_dnb", `alb_${album}`, 1);
      insertEmbedding.run(trackId, blobToward(0, (album + track) / 50));
    }
  }

  for (const trackId of ["xmas_1", "xmas_2"]) {
    insertTrack.run(trackId, "lbl_dnb", "alb_xmas", 1);
    insertEmbedding.run(trackId, blobToward(7, 0.01));
  }

  insertTrack.run("finding_1", "lbl_dnb", "alb_finding", 0);
  insertEmbedding.run("finding_1", blobToward(7, 0.01));
  insertTrack.run("loose_1", null, null, 1);
  insertEmbedding.run("loose_1", blobToward(0, 0.02));
  database.run("insert into albums (id, discogs_styles) values ('alb_3', '[\"Jungle\"]')");
  database.run("insert into track_artists (track_id, artist_id) values ('xmas_1', 'art_bing')");
}

function replica(): Database {
  const database = new Database(":memory:", { strict: true });
  seedReplica(database);

  return database;
}

function replicaFile(): string {
  const path = join(scratchDir(), "source-replica.db");
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA journal_mode = WAL");
  seedReplica(database);
  database.close();

  return path;
}

describe("the replica read", () => {
  test("reads only embedded catalogue tracks, grouped per label, and flags the unlike album", () => {
    const database = replica();
    const inputs = readReplicaInputs(database);
    const groups = [...inputs.groups()];

    expect(new Map(groups.map((group) => [group.labelId, group.tracks.length]))).toEqual(
      new Map<string | null, number>([
        ["lbl_dnb", 22],
        [null, 1],
      ]),
    );
    expect(inputs.embeddedTracks).toBe(23);
    expect([...inputs.dnbTaggedAlbumIds]).toEqual(["alb_3"]);
    expect(inputs.artistsByTrack.get("xmas_1")).toEqual(["art_bing"]);

    const run = scoreCatalogue({ ...inputs, groups: inputs.groups() });

    expect(run.flagged.map((unit) => unit.unitId)).toEqual(["album:alb_xmas:lbl_dnb"]);
    database.close();
  });

  test("an embedding blob is read from its own bytes, never the slab behind it", () => {
    const slab = new Uint8Array(EMBEDDING_DIMENSIONS * 4 + 8);
    const view = slab.subarray(8);
    new DataView(view.buffer, view.byteOffset).setFloat32(0, 0.5, true);

    expect(readEmbedding(view)?.[0]).toBe(0.5);
    expect(readEmbedding(new Uint8Array(12))).toBeNull();
    expect(readEmbedding("not a blob")).toBeNull();
  });

  test("a vector with a non-finite or all-zero component set is unusable", () => {
    const nan = new Float32Array(EMBEDDING_DIMENSIONS);
    nan[0] = Number.NaN;
    const infinite = new Float32Array(EMBEDDING_DIMENSIONS);
    infinite[3] = Number.POSITIVE_INFINITY;

    expect(readEmbedding(new Uint8Array(nan.buffer))).toBeNull();
    expect(readEmbedding(new Uint8Array(infinite.buffer))).toBeNull();
    expect(readEmbedding(new Uint8Array(EMBEDDING_DIMENSIONS * 4))).toBeNull();
  });
});

async function exportOf(exportedAt: string): Promise<string> {
  const replica = replicaFile();
  const exportFile = join(scratchDir(), "label-outliers-inputs.db");
  await writeScoringExport(replica, exportFile, exportedAt);

  return exportFile;
}

const NOW = Date.parse("2026-09-28T05:30:00.000Z");

describe("the sweep reads only the device mirror's scoring export", () => {
  test("a fresh export is scored", async () => {
    const exportFile = await exportOf("2026-09-28T02:00:00.000Z");

    const outcome = await scoreExportFile(exportFile, { now: () => NOW });

    expect(outcome.kind).toBe("scored");
    if (outcome.kind === "scored") {
      expect(outcome.run.flagged.map((unit) => unit.unitId)).toEqual(["album:alb_xmas:lbl_dnb"]);
      expect(outcome.embeddedTracks).toBe(23);
      expect(outcome.replicaSyncedAt).toBe("2026-09-28T02:00:00.000Z");
    }
  });

  test("a missing export is reported as missing", async () => {
    const outcome = await scoreExportFile(join(scratchDir(), "absent.db"), { now: () => NOW });

    expect(outcome).toEqual({ kind: "missing" });
  });

  test("an export older than the sweep accepts is reported as stale", async () => {
    const exportFile = await exportOf("2026-09-26T05:00:00.000Z");

    const outcome = await scoreExportFile(exportFile, { now: () => NOW });

    expect(outcome).toEqual({ exportedAt: "2026-09-26T05:00:00.000Z", kind: "stale" });
  });

  test("a missing export fails the run loudly and writes nothing", async () => {
    const fake = deps({ score: async () => ({ kind: "missing" }) });
    const summary = await runLabelOutliersSweep(fake, TEST_FLOOR);

    expect(summary).toMatchObject({
      ok: false,
      payloadStarted: false,
      reason: "scoring_export_missing",
    });
    expect(fake.recorded).toEqual([]);
  });

  test("a stale export fails the run loudly and writes nothing", async () => {
    const fake = deps({
      score: async () => ({ exportedAt: "2026-09-26T05:00:00.000Z", kind: "stale" }),
    });
    const summary = await runLabelOutliersSweep(fake, TEST_FLOOR);

    expect(summary).toMatchObject({
      ok: false,
      payloadStarted: false,
      reason: "scoring_export_stale",
    });
    expect(fake.recorded).toEqual([]);
  });

  test("the sweep source never names the device mirror's lock or replica", () => {
    const source = readFileSync(join(import.meta.dir, "label-outliers-sweep.ts"), "utf8");

    expect(source).not.toContain("device-mirror.lock");
    expect(source).not.toContain("DEVICE_MIRROR_LOCK_DIR");
    expect(source).not.toContain("source-replica.db");
  });
});

function run(outliers: number, tracksScored = 40): LabelOutlierRun {
  return {
    flagged: Array.from({ length: outliers }, (_, index) => ({
      albumId: `alb_${index}`,
      artistSupport: 0,
      fingerprint: `fp${index}`,
      labelId: "lbl_1",
      reference: "label" as const,
      referenceMedian: 0.8712345,
      score: 0.4123456,
      singleTrackId: null,
      trackCount: 2,
      trackIds: [`t${index}`],
      unitId: `album:alb_${index}:lbl_1`,
      z: -6.123456,
    })),
    labelsScored: 3,
    tracksScored,
    unitsScored: 20,
  };
}

function scored(outliers: number, tracksScored = 40, embeddedTracks = 40): ScoreOutcome {
  return {
    embeddedTracks,
    kind: "scored",
    replicaSyncedAt: "2026-09-27T03:00:00.000Z",
    run: run(outliers, tracksScored),
  };
}

const U1: AlertedUnit = { fingerprint: "fp-1", unitId: "u1" };
const U2: AlertedUnit = { fingerprint: "fp-2", unitId: "u2" };

type FakeDeps = SweepDeps & {
  acknowledged: AlertedUnit[][];
  notified: string[];
  recorded: RecordPayload[];
};

function deps(overrides: Partial<SweepDeps> = {}): FakeDeps {
  const notified: string[] = [];
  const recorded: RecordPayload[] = [];
  const acknowledged: AlertedUnit[][] = [];

  return {
    acknowledge: async (units) => {
      acknowledged.push(units);
      return { kind: "completed", response: { acknowledged: units.length, ok: true } };
    },
    acknowledged,
    notified,
    notify: async (message) => {
      notified.push(message);
      return true;
    },
    record: async (payload) => {
      recorded.push(payload);
      return {
        kind: "completed",
        response: { flagged: payload.outliers.length, ok: true, pendingAlertUnits: [] },
      };
    },
    recorded,
    score: async () => scored(2),
    ...overrides,
  };
}

describe("the nightly sweep", () => {
  test("records the flagged set and stays quiet when nothing is pending", async () => {
    const fake = deps();
    const summary = await runLabelOutliersSweep(fake, TEST_FLOOR);

    expect(summary).toMatchObject({
      checked: 20,
      flagged: 2,
      notified: false,
      ok: true,
      payloadStarted: true,
      pendingAlerts: 0,
      produced: 2,
    });
    expect(fake.notified).toEqual([]);
    expect(fake.acknowledged).toEqual([]);
    expect(fake.recorded[0]?.outliers[0]).toMatchObject({
      referenceMedian: 0.8712,
      score: 0.4123,
      z: -6.1235,
    });
  });

  test("alerts on every pending unit and acknowledges them only after the post landed", async () => {
    const fake = deps({
      record: async () => ({
        kind: "completed",
        response: {
          flagged: 5,
          ok: true,
          pendingAlertUnits: [U1, U2],
          pendingAlerts: [
            { albumName: "Merry Christmas", labelName: "Penny Black", title: "White Christmas" },
          ],
        },
      }),
    });
    const summary = await runLabelOutliersSweep(fake, TEST_FLOOR);

    expect(summary).toMatchObject({ alertAcknowledged: true, notified: true, pendingAlerts: 2 });
    expect(fake.notified).toHaveLength(1);
    expect(fake.notified[0]).toContain("Merry Christmas on Penny Black");
    expect(fake.notified[0]).toContain("2 new to review");
    expect(fake.acknowledged).toEqual([[U1, U2]]);
  });

  test("a failed Discord post leaves the alert pending instead of acknowledging it", async () => {
    const fake = deps({
      notify: async () => false,
      record: async () => ({
        kind: "completed",
        response: { flagged: 1, ok: true, pendingAlertUnits: [U1], pendingAlerts: [] },
      }),
    });
    const summary = await runLabelOutliersSweep(fake, TEST_FLOOR);

    expect(summary).toMatchObject({ alertAcknowledged: false, notified: false, ok: true });
    expect(fake.acknowledged).toEqual([]);
  });

  test("a corpus below the absolute floor fails loudly and writes nothing", async () => {
    const fake = deps({ score: async () => scored(0, 900, 900) });
    const summary = await runLabelOutliersSweep(fake, { minTracks: 1000, minUsableFraction: 0.95 });

    expect(summary).toMatchObject({
      ok: false,
      payloadStarted: false,
      reason: "corpus_below_floor",
    });
    expect(fake.recorded).toEqual([]);
  });

  test("a replica whose vectors are mostly unusable fails loudly and writes nothing", async () => {
    const fake = deps({ score: async () => scored(0, 0, 50_000) });
    const summary = await runLabelOutliersSweep(fake);

    expect(summary).toMatchObject({ ok: false, reason: "corpus_below_floor" });
    expect(fake.recorded).toEqual([]);
  });

  test("a replica with a tenth of its vectors unusable fails even above the absolute floor", async () => {
    const fake = deps({ score: async () => scored(2, 45_000, 50_000) });
    const summary = await runLabelOutliersSweep(fake);

    expect(summary).toMatchObject({ ok: false, reason: "corpus_below_floor" });
    expect(fake.recorded).toEqual([]);
  });

  test("more flags than one run may record is a failure that writes nothing, never a truncated list", async () => {
    const fake = deps({ score: async () => scored(MAX_RECORDED_OUTLIERS + 1) });
    const summary = await runLabelOutliersSweep(fake, TEST_FLOOR);

    expect(summary).toMatchObject({
      ok: false,
      payloadStarted: false,
      reason: "too_many_outliers",
    });
    expect(fake.recorded).toEqual([]);
  });

  test("scoring that throws writes nothing", async () => {
    const fake = deps({
      score: async () => {
        throw new Error("corrupt replica");
      },
    });

    const outcome = await runLabelOutliersSweep(fake, TEST_FLOOR).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toBe("corrupt replica");
    expect(fake.recorded).toEqual([]);
  });

  test("an admission yield leaves the payload unstarted", async () => {
    const summary = await runLabelOutliersSweep(
      deps({ record: async () => ({ kind: "yielded", reason: "queue" }) }),
      TEST_FLOOR,
    );

    expect(summary).toMatchObject({ ok: true, payloadStarted: false, reason: "admission_queue" });
  });

  test("a record response without a count is a failure", async () => {
    const summary = await runLabelOutliersSweep(
      deps({ record: async () => ({ kind: "completed", response: { ok: true } }) }),
      TEST_FLOOR,
    );

    expect(summary).toMatchObject({ errors: 1, ok: false, payloadStarted: true });
  });
});

describe("the payload and the message", () => {
  test("the payload carries every flagged unit and states the total it was built from", () => {
    const payload = toPayload(run(2500), null);

    expect(payload.outliers).toHaveLength(2500);
    expect(payload).toMatchObject({
      labelsScored: 3,
      replicaSyncedAt: null,
      totalFlagged: 2500,
      tracksScored: 40,
      unitsScored: 20,
    });
  });

  test("the Discord summary names at most eight and links the board", () => {
    const named = Array.from({ length: 10 }, (_, index) => ({
      albumName: null,
      labelName: null,
      title: `Track ${index}`,
    }));
    const message = discordMessage(named, 60, 72);

    expect(message.split("\n")[0]).toBe("Label outliers: 60 new to review (72 on the board).");
    expect(message).toContain("• Track 7");
    expect(message).not.toContain("• Track 8");
    expect(message).toContain("…and 52 more");
    expect(message.endsWith("/admin/label-outliers")).toBe(true);
  });
});

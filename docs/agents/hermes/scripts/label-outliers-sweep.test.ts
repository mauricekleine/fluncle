import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMBEDDING_DIMENSIONS, type LabelOutlierRun, scoreCatalogue } from "./label-outliers";
import {
  acquireReplicaLock,
  discordMessage,
  readEmbedding,
  readReplicaInputs,
  type RecordPayload,
  runLabelOutliersSweep,
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

function blobToward(axis: number, jitter: number): Uint8Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  vector[axis] = 1;
  vector[(axis + 1) % 16] = jitter;

  return new Uint8Array(vector.buffer);
}

function replica(): Database {
  const database = new Database(":memory:", { strict: true });
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

  return database;
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
});

describe("the replica lock", () => {
  test("waits out a held lock and gives up at the deadline", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    let clock = Date.now();

    const lock = await acquireReplicaLock(lockDir, {
      now: () => clock,
      pollMs: 1000,
      sleep: async (ms) => {
        clock += ms;
      },
      waitMs: 5000,
    });

    expect(lock).toBeNull();
  });

  test("takes over a lock nobody has touched for longer than the stale window", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockDir, old, old);

    const lock = await acquireReplicaLock(lockDir, { waitMs: 0 });

    expect(lock).not.toBeNull();
    await lock?.release();
  });
});

function run(outliers: number): LabelOutlierRun {
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
    tracksScored: 40,
    unitsScored: 20,
  };
}

function deps(
  overrides: Partial<SweepDeps> = {},
): SweepDeps & { notified: string[]; recorded: RecordPayload[] } {
  const notified: string[] = [];
  const recorded: RecordPayload[] = [];

  return {
    lock: async () => ({ release: async () => {} }),
    notified,
    notify: async (message) => {
      notified.push(message);
      return true;
    },
    record: async (payload) => {
      recorded.push(payload);
      return {
        kind: "recorded",
        response: { flagged: payload.outliers.length, newlyFlagged: [], ok: true },
      };
    },
    recorded,
    score: async () => ({ replicaSyncedAt: "2026-09-27T03:00:00.000Z", run: run(2) }),
    ...overrides,
  };
}

describe("the nightly sweep", () => {
  test("records the flagged set and stays quiet when nothing new appeared", async () => {
    const fake = deps();
    const summary = await runLabelOutliersSweep(fake);

    expect(summary).toMatchObject({
      checked: 20,
      flagged: 2,
      newlyFlagged: 0,
      notified: false,
      ok: true,
      payloadStarted: true,
      produced: 2,
    });
    expect(fake.notified).toEqual([]);
    expect(fake.recorded[0]?.outliers[0]).toMatchObject({
      referenceMedian: 0.8712,
      score: 0.4123,
      z: -6.1235,
    });
  });

  test("posts one summary when new outliers land", async () => {
    const fake = deps({
      record: async () => ({
        kind: "recorded",
        response: {
          flagged: 5,
          newlyFlagged: [
            { albumName: "Merry Christmas", labelName: "Penny Black", title: "White Christmas" },
          ],
          ok: true,
        },
      }),
    });
    const summary = await runLabelOutliersSweep(fake);

    expect(summary.newlyFlagged).toBe(1);
    expect(summary.notified).toBe(true);
    expect(fake.notified).toHaveLength(1);
    expect(fake.notified[0]).toContain("Merry Christmas on Penny Black");
  });

  test("a busy replica skips the payload so the retry slot runs it", async () => {
    const summary = await runLabelOutliersSweep(deps({ lock: async () => null }));

    expect(summary).toMatchObject({ ok: true, payloadStarted: false, reason: "replica_busy" });
  });

  test("a missing replica is a failure the operator sees", async () => {
    const summary = await runLabelOutliersSweep(deps({ score: async () => null }));

    expect(summary).toMatchObject({ ok: false, payloadStarted: false, reason: "replica_missing" });
  });

  test("the replica lock is released even when scoring throws", async () => {
    let released = false;
    const fake = deps({
      lock: async () => ({
        release: async () => {
          released = true;
        },
      }),
      score: async () => {
        throw new Error("corrupt replica");
      },
    });

    const outcome = await runLabelOutliersSweep(fake).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toBe("corrupt replica");
    expect(released).toBe(true);
  });

  test("an admission yield leaves the payload unstarted", async () => {
    const summary = await runLabelOutliersSweep(
      deps({ record: async () => ({ kind: "yielded", reason: "queue" }) }),
    );

    expect(summary).toMatchObject({ ok: true, payloadStarted: false, reason: "admission_queue" });
  });

  test("a record response without a count is a failure", async () => {
    const summary = await runLabelOutliersSweep(
      deps({ record: async () => ({ kind: "recorded", response: { ok: true } }) }),
    );

    expect(summary).toMatchObject({ errors: 1, ok: false, payloadStarted: true });
  });
});

describe("the payload and the message", () => {
  test("the payload caps the recorded list and keeps the run counts", () => {
    const payload = toPayload(run(2500), null);

    expect(payload.outliers).toHaveLength(2000);
    expect(payload).toMatchObject({
      labelsScored: 3,
      replicaSyncedAt: null,
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

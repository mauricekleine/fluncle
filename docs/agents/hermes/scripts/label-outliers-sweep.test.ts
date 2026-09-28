import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMBEDDING_DIMENSIONS, type LabelOutlierRun, scoreCatalogue } from "./label-outliers";
import { type InputsPage, type PageFetch, parseInputsPage } from "./label-outliers-inputs";
import {
  type AlertedUnit,
  type CorpusFloor,
  discordMessage,
  MAX_RECORDED_OUTLIERS,
  readEmbedding,
  readScoringInputs,
  type RecordPayload,
  runLabelOutliersSweep,
  type ScoreOutcome,
  scoreFromPages,
  type SweepDeps,
  sweepDeps,
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

describe("the scoring-file read", () => {
  test("reads only embedded catalogue tracks, grouped per label, and flags the unlike album", () => {
    const database = replica();
    const inputs = readScoringInputs(database);
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

function workerPages(source: Database, limit: number): InputsPage[] {
  const pages: InputsPage[] = [];
  let after = "";

  while (true) {
    const rows = source
      .query<
        {
          album_id: string | null;
          embedding_blob: Uint8Array;
          label_id: string | null;
          track_id: string;
        },
        [string, number]
      >(
        `select e.track_id, t.label_id, t.album_id, e.embedding_blob
           from track_embeddings e cross join tracks t on t.track_id = e.track_id
          where t.is_catalogue = 1 and e.track_id > ? order by e.track_id limit ?`,
      )
      .all(after, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.track_id ?? after;
    const artists = source
      .query<{ artist_id: string; track_id: string }, [string, string]>(
        "select track_id, artist_id from track_artists where track_id > ? and track_id <= ?",
      )
      .all(after, last);
    const albums = source
      .query<{ discogs_styles: string; id: string }, [string, string]>(
        `select id, discogs_styles from albums where discogs_styles is not null and id in (
           select t.album_id from tracks t join track_embeddings e on e.track_id = t.track_id
            where t.is_catalogue = 1 and t.track_id > ? and t.track_id <= ?)`,
      )
      .all(after, last);

    pages.push({
      albums: albums.map((album) => ({ discogsStyles: album.discogs_styles, id: album.id })),
      nextCursor: rows.length > limit ? `c:${last}` : null,
      tracks: page.map((row) => ({
        albumId: row.album_id,
        artistIds: artists.filter((a) => a.track_id === row.track_id).map((a) => a.artist_id),
        embeddingBase64: Buffer.from(row.embedding_blob).toString("base64"),
        labelId: row.label_id,
        trackId: row.track_id,
      })),
    });

    if (rows.length <= limit) {
      return pages;
    }

    after = last;
  }
}

function servePages(pages: readonly InputsPage[], cursors: (string | null)[] = []): PageFetch {
  return async (cursor) => {
    cursors.push(cursor);
    const index =
      cursor === null ? 0 : pages.findIndex((_, i) => pages[i - 1]?.nextCursor === cursor);
    const page = pages[index];

    if (!page) {
      throw new Error(`no page after ${cursor}`);
    }

    return { bytes: JSON.stringify(page).length, page };
  };
}

const READ_AT = new Date("2026-09-28T05:30:00.000Z");

describe("the sweep scores from paged Worker reads", () => {
  test("scoring the paged inputs gives exactly the result of scoring the source directly", async () => {
    const source = replica();
    const direct = readScoringInputs(source);
    const expected = scoreCatalogue({ ...direct, groups: direct.groups() });
    const cursors: (string | null)[] = [];
    const file = join(scratchDir(), "scoring-inputs.db");

    const outcome = await scoreFromPages(file, servePages(workerPages(source, 4), cursors), {
      now: () => READ_AT,
    });

    expect(outcome.run).toEqual(expected);
    expect(outcome.run.flagged.map((unit) => unit.unitId)).toEqual(["album:alb_xmas:lbl_dnb"]);
    expect(outcome.embeddedTracks).toBe(23);
    expect(outcome.readAt).toBe("2026-09-28T05:30:00.000Z");
    expect(outcome.read).toMatchObject({ pages: 6, tracks: 23 });
    expect(outcome.read.bytes).toBeGreaterThan(23 * EMBEDDING_DIMENSIONS * 4);
    expect(cursors[0]).toBeNull();
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(existsSync(file)).toBe(false);
    source.close();
  });

  test("a failed page read mid-walk stops the read, scores nothing, and leaves no file", async () => {
    const serve = servePages(workerPages(replica(), 4));
    let calls = 0;
    const file = join(scratchDir(), "scoring-inputs.db");

    const failure = await scoreFromPages(file, async (cursor) => {
      calls += 1;

      if (calls === 3) {
        throw new Error("list_label_outlier_inputs failed (503)");
      }

      return serve(cursor);
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toContain("(503)");
    expect(calls).toBe(3);
    expect(existsSync(file)).toBe(false);
  });

  test("a cursor that stops advancing fails the read instead of looping", async () => {
    const [first] = workerPages(replica(), 4);
    if (!first) {
      throw new Error("the fixture yields at least one page");
    }
    const stuck: InputsPage = { ...first, nextCursor: "c:again" };

    const failure = await scoreFromPages(join(scratchDir(), "s.db"), async () => ({
      bytes: 1,
      page: stuck,
    })).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toContain("stopped advancing");
  });

  test("a walk longer than its page bound fails instead of reading forever", async () => {
    const failure = await scoreFromPages(
      join(scratchDir(), "s.db"),
      servePages(workerPages(replica(), 4)),
      { maxPages: 3 },
    ).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toContain("did not end within 3 pages");
  });

  test("a page that is not the op's shape is refused", () => {
    expect(() => parseInputsPage({ albums: [], ok: true, tracks: [{ trackId: "t" }] })).toThrow(
      "without artistIds",
    );
    expect(() => parseInputsPage({ ok: false })).toThrow("missing ok, tracks, or albums");
    expect(() =>
      parseInputsPage({
        albums: [],
        ok: true,
        tracks: [
          { albumId: null, artistIds: [], embeddingBase64: "", labelId: null, trackId: "t" },
        ],
      }),
    ).toThrow("no embeddingBase64");
    expect(parseInputsPage({ albums: [], nextCursor: null, ok: true, tracks: [] })).toEqual({
      albums: [],
      nextCursor: null,
      tracks: [],
    });
  });

  test("the input walk takes no admission slot, one page at a time; only the two writes are admitted", async () => {
    const pages = workerPages(replica(), 4);
    const serve = servePages(pages);
    const directory = scratchDir();
    const admitted: { owner: string; phase: string | undefined; yieldRetries: number }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let pageReads = 0;
    let recordedOutliers = -1;

    const summary = await runLabelOutliersSweep(
      sweepDeps({
        admit: async (input) => {
          const phase = input.command[input.command.indexOf("--admission-phase") + 1];
          admitted.push({ owner: input.owner, phase, yieldRetries: input.yieldRetries });
          const payloadFile = input.command[input.command.indexOf("--payload") + 1] ?? "";
          const posted = JSON.parse(readFileSync(payloadFile, "utf8")) as RecordPayload;

          if (phase === "record") {
            recordedOutliers = posted.outliers.length;
          }

          const stdout =
            phase === "record"
              ? {
                  flagged: posted.outliers.length,
                  ok: true,
                  pendingAlertUnits: [{ fingerprint: "fp-xmas", unitId: "u-xmas" }],
                  pendingAlerts: [{ albumName: "Xmas", labelName: "DnB", title: "Bells" }],
                }
              : { acknowledged: 1, ok: true };

          return { attempts: 1, kind: "completed", stdout: JSON.stringify(stdout) };
        },
        fetchInputsPage: async (cursor) => {
          pageReads += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(1);
          const { page } = await serve(cursor);
          inFlight -= 1;

          return JSON.stringify({ ...page, ok: true });
        },
        notify: async () => true,
        scoringFile: async () => join(directory, "scoring-inputs.db"),
      }),
      TEST_FLOOR,
    );

    expect(pageReads).toBe(pages.length);
    expect(maxInFlight).toBe(1);
    expect(admitted).toEqual([
      { owner: "fluncle-label-outliers", phase: "record", yieldRetries: 1 },
      { owner: "fluncle-label-outliers", phase: "acknowledge", yieldRetries: 1 },
    ]);
    expect(recordedOutliers).toBe(1);
    expect(summary).toMatchObject({
      alertAcknowledged: true,
      inputPages: pages.length,
      notified: true,
      ok: true,
      payloadStarted: true,
      pendingAlerts: 1,
    });
  });

  test("the sweep source never reaches the device mirror's state", () => {
    const source = readFileSync(join(import.meta.dir, "label-outliers-sweep.ts"), "utf8");

    expect(source).not.toContain("device-mirror");
    expect(source).not.toContain("DEVICE_MIRROR");
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
    read: { bytes: 5_600_000, durationMs: 2_000, pages: 1, tracks: embeddedTracks },
    readAt: "2026-09-27T03:00:00.000Z",
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
      inputBytes: 5_600_000,
      inputPages: 1,
      inputReadMs: 2_000,
      inputsReadAt: "2026-09-27T03:00:00.000Z",
      notified: false,
      ok: true,
      payloadStarted: true,
      pendingAlerts: 0,
      produced: 2,
    });
    expect(fake.notified).toEqual([]);
    expect(fake.acknowledged).toEqual([]);
    expect(fake.recorded[0]?.replicaSyncedAt).toBe("2026-09-27T03:00:00.000Z");
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

import { type Client } from "@libsql/client";
import { type RecordedLabelOutlier } from "@fluncle/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";
import {
  acknowledgeLabelOutlierAlerts,
  LABEL_OUTLIERS_LAST_RUN_KEY,
  LabelOutlierRunRejected,
  listLabelOutliers,
  recordLabelOutliers,
  setLabelOutliersDismissed,
} from "./label-outliers";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const STAMP = "2026-07-01T00:00:00.000Z";

async function seedCatalogue(): Promise<void> {
  await db.batch(
    [
      {
        args: ["lbl_penny", "Penny Black", "penny-black", STAMP, STAMP],
        sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
              values (?, ?, ?, 'enabled', ?, ?)`,
      },
      {
        args: ["alb_xmas", "Merry Christmas", "merry-christmas", STAMP, STAMP],
        sql: `insert into albums (id, name, slug, created_at, updated_at, discogs_styles)
              values (?, ?, ?, ?, ?, '["Holiday"]')`,
      },
      {
        args: ["art_bing", "Bing Crosby", "bing-crosby", STAMP, STAMP],
        sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      },
      ...[
        ["t_white", "White Christmas", "alb_xmas", "lbl_penny"],
        ["t_silent", "Silent Night", "alb_xmas", "lbl_penny"],
        ["t_single", "Lonely Single", null, "lbl_penny"],
      ].map(([trackId, title, albumId, labelId]) => ({
        args: [trackId ?? "", title ?? "", albumId ?? null, labelId ?? null],
        sql: `insert into tracks (track_id, title, artists_json, duration_ms, album_id, label_id)
              values (?, ?, '["Bing Crosby"]', 180000, ?, ?)`,
      })),
      {
        args: [],
        sql: `insert into track_artists (track_id, artist_id, position)
              values ('t_white', 'art_bing', 0), ('t_silent', 'art_bing', 0)`,
      },
    ],
    "write",
  );
}

function outlier(overrides: Partial<RecordedLabelOutlier> = {}): RecordedLabelOutlier {
  return {
    albumId: "alb_xmas",
    artistSupport: 0,
    fingerprint: "fp-1",
    labelId: "lbl_penny",
    reference: "label",
    referenceMedian: 0.87,
    score: 0.34,
    singleTrackId: null,
    trackCount: 2,
    unitId: "album:alb_xmas:lbl_penny",
    z: -15.2,
    ...overrides,
  };
}

const single = outlier({
  albumId: null,
  fingerprint: "fp-single",
  singleTrackId: "t_single",
  trackCount: 1,
  unitId: "track:t_single",
  z: -5.1,
});

function run(
  outliers: RecordedLabelOutlier[],
  overrides: { totalFlagged?: number; tracksScored?: number } = {},
) {
  return {
    labelsScored: 1,
    outliers,
    replicaSyncedAt: STAMP,
    totalFlagged: overrides.totalFlagged ?? outliers.length,
    tracksScored: overrides.tracksScored ?? 3,
    unitsScored: 2,
  };
}

async function rowCount(table: string): Promise<number> {
  const result = await db.execute(`select count(*) as n from ${table}`);

  return Number(result.rows[0]?.n ?? 0);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedCatalogue();
});

const ALBUM_UNIT = "album:alb_xmas:lbl_penny";

const ALBUM_ALERT = { fingerprint: "fp-1", unitId: ALBUM_UNIT };

async function seedEmbeddedCatalogue(count: number): Promise<void> {
  const blob = new Uint8Array(4096);
  await db.batch(
    Array.from({ length: count }, (_, index) => [
      {
        args: [`emb_${index}`],
        sql: `insert into tracks (track_id, title, artists_json, duration_ms, is_catalogue)
              values (?, 'Embedded', '[]', 180000, 1)`,
      },
      {
        args: [`emb_${index}`, blob],
        sql: "insert into track_embeddings (track_id, embedding_blob) values (?, ?)",
      },
    ]).flat(),
    "write",
  );
}

async function purgeEmbeddedCatalogue(count: number): Promise<void> {
  const ids = JSON.stringify(Array.from({ length: count }, (_, index) => `emb_${index}`));
  await db.execute({
    args: [ids],
    sql: "delete from track_embeddings where track_id in (select value from json_each(?))",
  });
  await db.execute({
    args: [ids],
    sql: "delete from tracks where track_id in (select value from json_each(?))",
  });
}

describe("recordLabelOutliers", () => {
  it("stores the flagged set and names every visible unit not yet announced", async () => {
    const result = await recordLabelOutliers(run([outlier(), single]), () => STAMP);

    expect(result).toMatchObject({
      flagged: 2,
      pendingAlertUnits: [ALBUM_ALERT, { fingerprint: "fp-single", unitId: "track:t_single" }],
      removed: 0,
    });
    expect(result.pendingAlerts).toEqual([
      {
        albumName: "Merry Christmas",
        labelName: "Penny Black",
        title: "Merry Christmas",
        unitId: ALBUM_UNIT,
      },
      {
        albumName: null,
        labelName: "Penny Black",
        title: "Lonely Single",
        unitId: "track:t_single",
      },
    ]);
    expect(await rowCount("label_outliers")).toBe(2);
  });

  it("an alert whose response was lost is still pending on the retry", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);

    const retry = await recordLabelOutliers(run([outlier()]), () => STAMP);

    expect(retry.pendingAlertUnits).toEqual([ALBUM_ALERT]);
  });

  it("an acknowledged alert is not announced again, and a repeat run drops what left the list", async () => {
    await recordLabelOutliers(run([outlier(), single]), () => STAMP);
    expect(
      await acknowledgeLabelOutlierAlerts(
        [ALBUM_ALERT, { fingerprint: "fp-single", unitId: "track:t_single" }],
        () => STAMP,
      ),
    ).toBe(2);

    const repeat = await recordLabelOutliers(run([outlier({ z: -15.21 })]), () => STAMP);

    expect(repeat).toMatchObject({
      flagged: 1,
      pendingAlertUnits: [],
      pendingAlerts: [],
      removed: 1,
    });
    expect(await rowCount("label_outliers")).toBe(1);
  });

  it("an announced unit whose tracks change is announced again", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    await acknowledgeLabelOutlierAlerts([ALBUM_ALERT], () => STAMP);

    const moved = await recordLabelOutliers(run([outlier({ z: -16 })]), () => STAMP);
    expect(moved.pendingAlertUnits).toEqual([]);

    const changed = await recordLabelOutliers(
      run([outlier({ fingerprint: "fp-2", trackCount: 3 })]),
      () => STAMP,
    );
    expect(changed.pendingAlertUnits).toEqual([{ fingerprint: "fp-2", unitId: ALBUM_UNIT }]);
  });

  it("an acknowledgement for a fingerprint that changed since the post does not silence the new version", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    await recordLabelOutliers(run([outlier({ fingerprint: "fp-2", trackCount: 3 })]), () => STAMP);

    expect(await acknowledgeLabelOutlierAlerts([ALBUM_ALERT], () => STAMP)).toBe(0);

    const next = await recordLabelOutliers(
      run([outlier({ fingerprint: "fp-2", trackCount: 3 })]),
      () => STAMP,
    );
    expect(next.pendingAlertUnits).toEqual([{ fingerprint: "fp-2", unitId: ALBUM_UNIT }]);
  });

  it("a dismissed outlier stays off the list and out of the alerts until its tracks change", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    expect(await setLabelOutliersDismissed([ALBUM_UNIT], true, () => STAMP)).toBe(1);

    const same = await recordLabelOutliers(run([outlier()]), () => STAMP);
    expect(same).toMatchObject({ flagged: 0, pendingAlertUnits: [] });

    const changed = await recordLabelOutliers(
      run([outlier({ fingerprint: "fp-2", trackCount: 3 })]),
      () => STAMP,
    );
    expect(changed).toMatchObject({
      flagged: 1,
      pendingAlertUnits: [{ fingerprint: "fp-2", unitId: ALBUM_UNIT }],
    });
  });

  it("a dismissal survives the outlier dropping off the list and coming back unchanged", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    await setLabelOutliersDismissed([ALBUM_UNIT], true, () => STAMP);
    await recordLabelOutliers(run([], { tracksScored: 3 }), () => STAMP);

    const back = await recordLabelOutliers(run([outlier()]), () => STAMP);

    expect(back).toMatchObject({ flagged: 0, pendingAlertUnits: [] });
  });

  it("a list shorter than the run's flagged total is refused and the stored list is untouched", async () => {
    await recordLabelOutliers(run([outlier(), single]), () => STAMP);

    const refused = await rejection(
      recordLabelOutliers(run([outlier()], { totalFlagged: 2 }), () => STAMP),
    );

    expect(refused).toBeInstanceOf(LabelOutlierRunRejected);
    expect(await rowCount("label_outliers")).toBe(2);
  });

  it("a run that scored no tracks is refused and the stored list is untouched", async () => {
    await recordLabelOutliers(run([outlier(), single]), () => STAMP);

    const refused = await rejection(recordLabelOutliers(run([], { tracksScored: 0 }), () => STAMP));

    expect(refused).toBeInstanceOf(LabelOutlierRunRejected);
    expect(await rowCount("label_outliers")).toBe(2);
  });

  it("a list that repeats a unit id is refused even when its length matches the total", async () => {
    await recordLabelOutliers(run([outlier(), single]), () => STAMP);

    const refused = await rejection(
      recordLabelOutliers(run([outlier(), outlier()], { totalFlagged: 2 }), () => STAMP),
    );

    expect(refused).toBeInstanceOf(LabelOutlierRunRejected);
    expect(await rowCount("label_outliers")).toBe(2);
  });

  it("a corpus far below the live embedded catalogue is refused and the stored list is untouched", async () => {
    await seedEmbeddedCatalogue(100);
    await recordLabelOutliers(run([outlier(), single], { tracksScored: 100 }), () => STAMP);

    const refused = await rejection(
      recordLabelOutliers(run([], { tracksScored: 40 }), () => STAMP),
    );

    expect(refused).toBeInstanceOf(LabelOutlierRunRejected);
    expect(await rowCount("label_outliers")).toBe(2);
  });

  it("a legitimate purge that shrinks the catalogue records on the next run", async () => {
    await seedEmbeddedCatalogue(100);
    await recordLabelOutliers(run([outlier(), single], { tracksScored: 100 }), () => STAMP);
    await purgeEmbeddedCatalogue(60);

    const after = await recordLabelOutliers(run([outlier()], { tracksScored: 40 }), () => STAMP);

    expect(after).toMatchObject({ flagged: 1, removed: 1 });
  });

  it("writes the run summary the board reads", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    const setting = await db.execute({
      args: [LABEL_OUTLIERS_LAST_RUN_KEY],
      sql: "select value from settings where key = ?",
    });

    const raw = setting.rows[0]?.value;

    expect(typeof raw).toBe("string");
    expect(JSON.parse(typeof raw === "string" ? raw : "null")).toEqual({
      flagged: 1,
      labelsScored: 1,
      ranAt: STAMP,
      replicaSyncedAt: STAMP,
      tracksScored: 3,
      unitsScored: 2,
    });
  });
});

describe("listLabelOutliers", () => {
  it("returns each outlier with its album, label, tracks, and artists, furthest first", async () => {
    await recordLabelOutliers(run([single, outlier()]), () => STAMP);

    const { items, lastRun } = await listLabelOutliers();

    expect(lastRun?.flagged).toBe(2);
    expect(items.map((item) => item.unitId)).toEqual([
      "album:alb_xmas:lbl_penny",
      "track:t_single",
    ]);
    expect(items[0]).toMatchObject({
      album: { id: "alb_xmas", name: "Merry Christmas", slug: "merry-christmas" },
      discogsStyles: ["Holiday"],
      dismissedAt: null,
      label: { id: "lbl_penny", name: "Penny Black", slug: "penny-black" },
      tracks: [
        {
          artists: [{ name: "Bing Crosby", slug: "bing-crosby" }],
          title: "Silent Night",
          trackId: "t_silent",
        },
        {
          artists: [{ name: "Bing Crosby", slug: "bing-crosby" }],
          title: "White Christmas",
          trackId: "t_white",
        },
      ],
    });
    expect(items[1]?.tracks.map((track) => track.trackId)).toEqual(["t_single"]);
  });

  it("marks a dismissal only while its fingerprint still matches", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    await setLabelOutliersDismissed([ALBUM_UNIT], true, () => STAMP);

    expect((await listLabelOutliers()).items[0]?.dismissedAt).toBe(STAMP);

    await recordLabelOutliers(run([outlier({ fingerprint: "fp-2" })]), () => STAMP);

    expect((await listLabelOutliers()).items[0]?.dismissedAt).toBeNull();
  });

  it("drops an outlier whose album was purged since the last run", async () => {
    await recordLabelOutliers(run([outlier(), single]), () => STAMP);
    await db.execute("delete from tracks where album_id = 'alb_xmas'");
    await db.execute("delete from albums where id = 'alb_xmas'");

    const { items } = await listLabelOutliers();

    expect(items.map((item) => item.unitId)).toEqual(["track:t_single"]);
  });

  it("puts a restored outlier back on the list", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    await setLabelOutliersDismissed([ALBUM_UNIT], true, () => STAMP);

    expect(await setLabelOutliersDismissed([ALBUM_UNIT], false)).toBe(1);
    expect((await listLabelOutliers()).items[0]?.dismissedAt).toBeNull();
  });
});

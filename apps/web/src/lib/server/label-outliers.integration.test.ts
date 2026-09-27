import { type Client } from "@libsql/client";
import { type RecordedLabelOutlier } from "@fluncle/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";
import {
  LABEL_OUTLIERS_LAST_RUN_KEY,
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

function run(outliers: RecordedLabelOutlier[]) {
  return { labelsScored: 1, outliers, replicaSyncedAt: STAMP, tracksScored: 3, unitsScored: 2 };
}

async function rowCount(table: string): Promise<number> {
  const result = await db.execute(`select count(*) as n from ${table}`);

  return Number(result.rows[0]?.n ?? 0);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedCatalogue();
});

describe("recordLabelOutliers", () => {
  it("stores the flagged set and names what is new", async () => {
    const result = await recordLabelOutliers(run([outlier(), single]), () => STAMP);

    expect(result).toMatchObject({ flagged: 2, newlyFlaggedCount: 2, removed: 0 });
    expect(result.newlyFlagged).toEqual([
      {
        albumName: "Merry Christmas",
        labelName: "Penny Black",
        title: "Merry Christmas",
        unitId: "album:alb_xmas:lbl_penny",
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

  it("a repeat run of the same set announces nothing new and drops what left the list", async () => {
    await recordLabelOutliers(run([outlier(), single]), () => STAMP);

    const repeat = await recordLabelOutliers(run([outlier({ z: -15.21 })]), () => STAMP);

    expect(repeat).toMatchObject({
      flagged: 1,
      newlyFlagged: [],
      newlyFlaggedCount: 0,
      removed: 1,
    });
    expect(await rowCount("label_outliers")).toBe(1);
  });

  it("a dismissed outlier stays off the list until its tracks change", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    expect(await setLabelOutliersDismissed(["album:alb_xmas:lbl_penny"], true, () => STAMP)).toBe(
      1,
    );

    const same = await recordLabelOutliers(run([outlier()]), () => STAMP);
    expect(same).toMatchObject({ flagged: 0, newlyFlaggedCount: 0 });

    const changed = await recordLabelOutliers(
      run([outlier({ fingerprint: "fp-2", trackCount: 3 })]),
      () => STAMP,
    );
    expect(changed).toMatchObject({ flagged: 1, newlyFlaggedCount: 1 });
  });

  it("a dismissal survives the outlier dropping off the list and coming back unchanged", async () => {
    await recordLabelOutliers(run([outlier()]), () => STAMP);
    await setLabelOutliersDismissed(["album:alb_xmas:lbl_penny"], true, () => STAMP);
    await recordLabelOutliers(run([]), () => STAMP);

    const back = await recordLabelOutliers(run([outlier()]), () => STAMP);

    expect(back).toMatchObject({ flagged: 0, newlyFlaggedCount: 0 });
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
    await setLabelOutliersDismissed(["album:alb_xmas:lbl_penny"], true, () => STAMP);

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
    await setLabelOutliersDismissed(["album:alb_xmas:lbl_penny"], true, () => STAMP);

    expect(await setLabelOutliersDismissed(["album:alb_xmas:lbl_penny"], false)).toBe(1);
    expect((await listLabelOutliers()).items[0]?.dismissedAt).toBeNull();
  });
});

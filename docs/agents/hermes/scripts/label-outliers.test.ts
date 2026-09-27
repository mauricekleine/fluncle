import { describe, expect, test } from "bun:test";

import {
  addInto,
  EMBEDDING_DIMENSIONS,
  isDrumAndBassTagged,
  type LabelGroup,
  type OutlierTrack,
  robustSpread,
  scoreCatalogue,
  unitFingerprint,
  unitIdFor,
} from "./label-outliers";

function seeded(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;

    return state / 4_294_967_296 - 0.5;
  };
}

function vectorToward(axis: number, random: () => number, noise = 0.25): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);

  for (let index = 0; index < 16; index += 1) {
    vector[index] = random() * noise;
  }

  vector[axis] = (vector[axis] ?? 0) + 1;

  return vector;
}

type Fixture = {
  albums: { albumId: string | null; axis: number; trackIds: string[] }[];
  labelId: string | null;
};

function build(fixtures: Fixture[], seed = 7) {
  const random = seeded(seed);
  const groups: LabelGroup[] = fixtures.map((fixture) => ({
    labelId: fixture.labelId,
    tracks: fixture.albums.flatMap((album) =>
      album.trackIds.map(
        (trackId): OutlierTrack => ({
          albumId: album.albumId,
          trackId,
          vector: vectorToward(album.axis, random),
        }),
      ),
    ),
  }));
  const globalSum = new Float64Array(EMBEDDING_DIMENSIONS);

  for (const group of groups) {
    for (const track of group.tracks) {
      const norm = Math.hypot(...track.vector);
      addInto(
        globalSum,
        track.vector.map((value) => value / norm),
      );
    }
  }

  return { globalSum, groups };
}

function dnbLabel(labelId: string, albums: number, prefix: string): Fixture {
  return {
    albums: Array.from({ length: albums }, (_, index) => ({
      albumId: `alb_${prefix}${index}`,
      axis: 0,
      trackIds: [`${prefix}${index}a`, `${prefix}${index}b`, `${prefix}${index}c`],
    })),
    labelId,
  };
}

describe("label outlier scoring", () => {
  test("an album that sounds unlike the rest of its label is flagged against that label", () => {
    const label = dnbLabel("lbl_a", 12, "a");
    label.albums.push({ albumId: "alb_christmas", axis: 5, trackIds: ["x1", "x2", "x3"] });
    const { globalSum, groups } = build([label, dnbLabel("lbl_b", 12, "b")]);

    const run = scoreCatalogue({
      artistsByTrack: new Map(),
      dnbTaggedAlbumIds: new Set(),
      globalSum,
      groups,
    });

    expect(run.flagged.map((unit) => unit.unitId)).toEqual(["album:alb_christmas:lbl_a"]);
    expect(run.flagged[0]?.reference).toBe("label");
    expect(run.flagged[0]?.z).toBeLessThan(-4);
    expect(run.unitsScored).toBe(25);
    expect(run.tracksScored).toBe(75);
    expect(run.labelsScored).toBe(2);
  });

  test("an outlier whose artist has typical tracks elsewhere in the catalogue stays off the list", () => {
    const label = dnbLabel("lbl_a", 12, "a");
    label.albums.push({ albumId: "alb_intro", axis: 5, trackIds: ["x1"] });
    const { globalSum, groups } = build([label, dnbLabel("lbl_b", 12, "b")]);
    const artistsByTrack = new Map<string, string[]>([
      ["x1", ["art_known"]],
      ["b0a", ["art_known"]],
      ["b1a", ["art_known"]],
      ["b2a", ["art_known"]],
    ]);

    const run = scoreCatalogue({
      artistsByTrack,
      dnbTaggedAlbumIds: new Set(),
      globalSum,
      groups,
    });

    expect(run.flagged).toEqual([]);
  });

  test("an artist known only from the flagged album gives it no support", () => {
    const label = dnbLabel("lbl_a", 12, "a");
    label.albums.push({ albumId: "alb_blues", axis: 5, trackIds: ["x1", "x2", "x3", "x4"] });
    const { globalSum, groups } = build([label, dnbLabel("lbl_b", 12, "b")]);
    const artistsByTrack = new Map<string, string[]>(
      ["x1", "x2", "x3", "x4"].map((trackId) => [trackId, ["art_blues"]]),
    );

    const run = scoreCatalogue({
      artistsByTrack,
      dnbTaggedAlbumIds: new Set(),
      globalSum,
      groups,
    });

    expect(run.flagged.map((unit) => unit.albumId)).toEqual(["alb_blues"]);
    expect(run.flagged[0]?.artistSupport).toBe(0);
  });

  test("an album Discogs files under drum and bass or jungle is scored but never flagged", () => {
    const label = dnbLabel("lbl_a", 12, "a");
    label.albums.push({ albumId: "alb_tagged", axis: 5, trackIds: ["x1", "x2"] });
    const { globalSum, groups } = build([label, dnbLabel("lbl_b", 12, "b")]);

    const run = scoreCatalogue({
      artistsByTrack: new Map(),
      dnbTaggedAlbumIds: new Set(["alb_tagged"]),
      globalSum,
      groups,
    });

    expect(run.flagged).toEqual([]);
    expect(run.unitsScored).toBe(25);
  });

  test("a label too small to have a spread of its own is judged against the whole catalogue", () => {
    const small: Fixture = {
      albums: [
        { albumId: "alb_s0", axis: 0, trackIds: ["s0a", "s0b"] },
        { albumId: "alb_off", axis: 9, trackIds: ["s1a", "s1b"] },
      ],
      labelId: "lbl_small",
    };
    const { globalSum, groups } = build([dnbLabel("lbl_a", 20, "a"), small]);

    const run = scoreCatalogue({
      artistsByTrack: new Map(),
      dnbTaggedAlbumIds: new Set(),
      globalSum,
      groups,
    });

    expect(run.flagged.map((unit) => [unit.albumId, unit.reference])).toEqual([
      ["alb_off", "catalogue"],
    ]);
  });

  test("a label-less single is a unit of its own and judged against the catalogue", () => {
    const loose: Fixture = {
      albums: [{ albumId: null, axis: 3, trackIds: ["single_1"] }],
      labelId: null,
    };
    const { globalSum, groups } = build([dnbLabel("lbl_a", 20, "a"), loose]);

    const run = scoreCatalogue({
      artistsByTrack: new Map(),
      dnbTaggedAlbumIds: new Set(),
      globalSum,
      groups,
    });

    expect(run.flagged.map((unit) => [unit.unitId, unit.singleTrackId, unit.reference])).toEqual([
      ["track:single_1", "single_1", "catalogue"],
    ]);
  });

  test("the flagged list is ordered from the furthest outlier inward", () => {
    const label = dnbLabel("lbl_a", 16, "a");
    label.albums.push({ albumId: "alb_far", axis: 5, trackIds: ["f1", "f2"] });
    label.albums.push({ albumId: "alb_farther", axis: 6, trackIds: ["g1", "g2", "g3"] });
    const { globalSum, groups } = build([label]);

    const run = scoreCatalogue({
      artistsByTrack: new Map(),
      dnbTaggedAlbumIds: new Set(),
      globalSum,
      groups,
    });

    const zs = run.flagged.map((unit) => unit.z);
    expect(zs).toEqual([...zs].sort((left, right) => left - right));
    expect(run.flagged).toHaveLength(2);
  });
});

describe("label outlier identity", () => {
  test("an album unit is keyed by album and label, a single by its track", () => {
    expect(unitIdFor("lbl_1", "alb_1", "t1")).toBe("album:alb_1:lbl_1");
    expect(unitIdFor(null, "alb_1", "t1")).toBe("album:alb_1:none");
    expect(unitIdFor("lbl_1", null, "t1")).toBe("track:t1");
  });

  test("the fingerprint ignores track order and moves when membership or label moves", () => {
    const base = unitFingerprint("lbl_1", ["t1", "t2"]);

    expect(unitFingerprint("lbl_1", ["t2", "t1"])).toBe(base);
    expect(unitFingerprint("lbl_1", ["t1", "t2", "t3"])).not.toBe(base);
    expect(unitFingerprint("lbl_2", ["t1", "t2"])).not.toBe(base);
  });

  test("the drum and bass tag reads only the Discogs drum and bass and jungle styles", () => {
    expect(isDrumAndBassTagged(JSON.stringify(["Drum n Bass", "Breakbeat"]))).toBe(true);
    expect(isDrumAndBassTagged(JSON.stringify(["Jungle"]))).toBe(true);
    expect(isDrumAndBassTagged(JSON.stringify(["House"]))).toBe(false);
    expect(isDrumAndBassTagged(null)).toBe(false);
    expect(isDrumAndBassTagged("not json")).toBe(false);
  });

  test("a tight label's spread never collapses below the sigma floor", () => {
    expect(robustSpread([0.9, 0.9, 0.9], { madScale: 1.4826, sigmaFloor: 0.02 })).toEqual({
      center: 0.9,
      sigma: 0.02,
    });
  });
});

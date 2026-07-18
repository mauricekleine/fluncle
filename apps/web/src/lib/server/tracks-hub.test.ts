// The `/tracks` hub read, proven against the REAL migrated schema on an in-memory libSQL engine
// (the fresh.test.ts / catalogue-groups.test.ts harness). What is impossible to see without a DB:
//
//   1. THE REGISTER SPLIT. A certified finding comes back lit (its Log ID coordinate); an
//      uncertified catalogue row comes back unlit (no coordinate, no cover). Structural, via the flag.
//   2. THE ORDER. Newest RELEASE first (never found date), track_id the stable tiebreak, undated
//      rows LAST (SQLite's native `desc` null placement).
//   3. KEYSET PAGINATION. Paging by cursor covers every row once, across the dated → null boundary.
//   4. THE FILTERS. The shared `compileFilters` vocabulary (bpm/key/year/label) + the galaxy
//      extension, which narrows the list to certified findings.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import {
  type TracksHubCursor,
  type TracksHubEntry,
  decodeTracksHubCursor,
  encodeTracksHubCursor,
  clampTracksHubLimit,
  listTracksHub,
  tracksHubCursorClause,
  TRACKS_HUB_MAX_LIMIT,
} from "./tracks-hub";

let db: Client;

async function seedTrack(options: {
  bpm?: number;
  key?: string;
  label?: string;
  releaseDate: null | string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(["Artist"]),
      options.releaseDate,
      `https://open.spotify.com/track/${options.trackId}`,
      options.bpm ?? null,
      options.key ?? null,
      options.label ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, spotify_url, duration_ms, bpm, key, label)
          values (?, ?, ?, ?, ?, 210000, ?, ?, ?)`,
  });
}

async function certify(options: {
  galaxyId?: string;
  logId: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [options.trackId, options.logId, options.galaxyId ?? null],
    sql: `insert into findings (track_id, log_id, added_at, galaxy_id)
          values (?, ?, '2020-01-01T00:00:00.000Z', ?)`,
  });
}

async function seedGalaxy(options: {
  id: string;
  name: null | string;
  slug: null | string;
}): Promise<void> {
  await db.execute({
    args: [options.id, `handle-${options.id}`, options.name, options.slug],
    sql: `insert into galaxies (id, handle, name, slug, centroid_json, created_at, updated_at)
          values (?, ?, ?, ?, '[]', '2020-01-01', '2020-01-01')`,
  });
}

/** The track ids of a page, in order. */
function ids(entries: TracksHubEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId,
  );
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("listTracksHub — the register split", () => {
  it("returns findings lit (with a coordinate) and catalogue rows unlit (no coordinate)", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "f1" });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "c1" });

    const { entries } = await listTracksHub({});

    const finding = entries.find((entry) => entry.kind === "finding");
    const catalogue = entries.find((entry) => entry.kind === "catalogue");

    expect(finding?.kind === "finding" && finding.finding.logId).toBe("200.7.1A");
    // The Unlit Rule: not one catalogue row carries a coordinate or a cover.
    expect(catalogue?.kind === "catalogue" && "logId" in catalogue.track).toBe(false);
    expect(catalogue?.kind === "catalogue" && catalogue.track.trackId).toBe("c1");
  });
});

describe("listTracksHub — the order", () => {
  it("is newest release first, track_id the tiebreak, undated rows last", async () => {
    await seedTrack({ releaseDate: "2020-05-01", trackId: "old" });
    await seedTrack({ releaseDate: "2023-05-01", trackId: "new" });
    await seedTrack({ releaseDate: "2023-05-01", trackId: "tie" });
    await seedTrack({ releaseDate: null, trackId: "undated" });

    const { entries } = await listTracksHub({});

    // 2023 rows first (track_id desc within the tie → "tie" before "new"), then 2020, then null last.
    expect(ids(entries)).toEqual(["tie", "new", "old", "undated"]);
  });
});

describe("listTracksHub — keyset pagination", () => {
  it("covers every row exactly once, across the dated → null boundary", async () => {
    for (let index = 0; index < 7; index += 1) {
      await seedTrack({ releaseDate: `2021-01-0${index + 1}`, trackId: `d${index}` });
    }
    await seedTrack({ releaseDate: null, trackId: "n0" });
    await seedTrack({ releaseDate: null, trackId: "n1" });

    const seen: string[] = [];
    let cursor: string | undefined;

    // Page in threes until the cursor runs out.
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await listTracksHub({ cursor, limit: 3 });
      seen.push(...ids(page.entries));
      cursor = page.nextCursor;

      if (!cursor) {
        break;
      }
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    // The two undated rows are the last two, after every dated row.
    expect(seen.slice(-2).sort()).toEqual(["n0", "n1"]);
  });
});

describe("listTracksHub — the filters", () => {
  it("filters by BPM range", async () => {
    await seedTrack({ bpm: 174, releaseDate: "2022-01-01", trackId: "dnb" });
    await seedTrack({ bpm: 128, releaseDate: "2022-01-01", trackId: "house" });

    const { entries } = await listTracksHub({ filters: { bpmMax: 180, bpmMin: 170 } });

    expect(ids(entries)).toEqual(["dnb"]);
  });

  it("filters by key, folding enharmonic spellings", async () => {
    await seedTrack({ key: "A# minor", releaseDate: "2022-01-01", trackId: "sharp" });
    await seedTrack({ key: "C major", releaseDate: "2022-01-01", trackId: "other" });

    // The stored key is the sharp spelling; the filter's flat spelling folds to it via keySpellings.
    const { entries } = await listTracksHub({ filters: { key: "Bb minor" } });

    expect(ids(entries)).toEqual(["sharp"]);
  });

  it("filters by release year range (a substring of release_date)", async () => {
    await seedTrack({ releaseDate: "2015-06-01", trackId: "y2015" });
    await seedTrack({ releaseDate: "2024-06-01", trackId: "y2024" });

    const { entries } = await listTracksHub({ filters: { yearMax: 2026, yearMin: 2020 } });

    expect(ids(entries)).toEqual(["y2024"]);
  });

  it("filters by label (the raw string, case-insensitively)", async () => {
    await seedTrack({ label: "Hospital Records", releaseDate: "2022-01-01", trackId: "hosp" });
    await seedTrack({ label: "Shogun Audio", releaseDate: "2022-01-01", trackId: "shogun" });

    const { entries } = await listTracksHub({ filters: { label: "hospital records" } });

    expect(ids(entries)).toEqual(["hosp"]);
  });

  it("filters by galaxy, narrowing the list to certified findings only", async () => {
    await seedGalaxy({ id: "gal_named", name: "Green Sector", slug: "green-sector" });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "in_galaxy" });
    await certify({ galaxyId: "gal_named", logId: "200.7.1A", trackId: "in_galaxy" });
    // A catalogue row with the same recency has NO galaxy, so a galaxy filter must exclude it.
    await seedTrack({ releaseDate: "2022-06-01", trackId: "catalogue_row" });

    const { entries } = await listTracksHub({ filters: { galaxy: "green-sector" } });

    expect(ids(entries)).toEqual(["in_galaxy"]);
    expect(entries.every((entry) => entry.kind === "finding")).toBe(true);
  });

  it("an unnamed galaxy resolves to nothing (the launch-gate guard in the clause)", async () => {
    await seedGalaxy({ id: "gal_unnamed", name: null, slug: null });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "assigned" });
    await certify({ galaxyId: "gal_unnamed", logId: "200.7.1A", trackId: "assigned" });

    const { entries } = await listTracksHub({ filters: { galaxy: "whatever" } });

    expect(entries).toEqual([]);
  });
});

describe("the cursor + limit helpers", () => {
  it("round-trips a dated cursor and an undated (null) cursor", () => {
    const dated: TracksHubCursor = { releaseDate: "2021-01-01", trackId: "t1" };
    const undated: TracksHubCursor = { releaseDate: null, trackId: "t2" };

    expect(decodeTracksHubCursor(encodeTracksHubCursor(dated))).toEqual(dated);
    expect(decodeTracksHubCursor(encodeTracksHubCursor(undated))).toEqual(undated);
  });

  it("degrades a junk / empty cursor to undefined (page from the top), never throwing", () => {
    expect(decodeTracksHubCursor(undefined)).toBeUndefined();
    expect(decodeTracksHubCursor("")).toBeUndefined();
    expect(decodeTracksHubCursor("not-base64-json")).toBeUndefined();
    expect(
      decodeTracksHubCursor(Buffer.from('{"trackId":42}').toString("base64url")),
    ).toBeUndefined();
  });

  it("clamps the limit into [1, TRACKS_HUB_MAX_LIMIT], defaulting on junk", () => {
    expect(clampTracksHubLimit(10)).toBe(10);
    expect(clampTracksHubLimit(9999)).toBe(TRACKS_HUB_MAX_LIMIT);
    expect(clampTracksHubLimit(0)).toBe(1);
    expect(clampTracksHubLimit(Number.NaN)).toBeGreaterThan(0);
  });

  it("the cursor clause branches on the null bucket", () => {
    // A dated cursor: the dated tail (smaller date, or equal + smaller id) AND the whole null tail.
    const dated = tracksHubCursorClause({ releaseDate: "2021-01-01", trackId: "t1" });
    expect(dated.sql).toContain("tracks.release_date is null");
    expect(dated.args).toEqual(["2021-01-01", "2021-01-01", "t1"]);

    // A null-bucket cursor: only null rows with a smaller id follow.
    const undated = tracksHubCursorClause({ releaseDate: null, trackId: "t2" });
    expect(undated.args).toEqual(["t2"]);
  });
});

// The `/tracks` hub read, proven against the REAL migrated schema on an in-memory libSQL engine
// (the fresh.test.ts / catalogue-groups.test.ts harness). What is impossible to see without a DB:
//
//   1. THE REGISTER SPLIT. A certified finding comes back lit (its Log ID coordinate); an
//      uncertified catalogue row comes back unlit (no coordinate). Structural, via the flag.
//   2. THE ORDER. Newest RELEASE first (never found date), track_id the stable tiebreak, undated
//      rows LAST (SQLite's native `desc` null placement).
//   3. NUMBERED PAGINATION. Every page is a `limit/offset` slice; a page past the end throws so the
//      route 404s (never clamps), and page 1 of an empty set is a legitimate empty page.
//   4. THE FILTERS. The shared `compileFilters` vocabulary (bpm/key/year/label) + the galaxy
//      extension, which narrows the list to certified findings — composing with the page slice.
//   5. THE LINKED ROW. Artist credits resolve to `/artist/<slug>` via `track_artists`; the imprint
//      resolves to `/label/<slug>` via `tracks.label_id`.
//   6. THE YEAR FAST LANE. Every present release year, newest first, mapped to the page it starts on.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { CatalogueHubPageOutOfRangeError } from "./labels";
import { createIntegrationDb } from "./integration-db";
import {
  type TracksHubEntry,
  TRACKS_HUB_PAGE_SIZE,
  countAllTracks,
  listTracksHubPage,
  listTracksHubYearLane,
  yearPages,
} from "./tracks-hub";

let db: Client;

async function seedTrack(options: {
  bpm?: number;
  key?: string;
  label?: string;
  labelId?: string;
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
      options.labelId ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, spotify_url, duration_ms, bpm, key, label, label_id)
          values (?, ?, ?, ?, ?, 210000, ?, ?, ?, ?)`,
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

async function seedArtist(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "2020-01-01", "2020-01-01"],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function linkArtist(trackId: string, artistId: string): Promise<void> {
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
}

async function seedLabel(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "2020-01-01", "2020-01-01"],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
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

describe("listTracksHubPage — the register split + the linked row", () => {
  it("returns findings lit (a coordinate) and catalogue rows unlit (no coordinate)", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "f1" });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "c1" });

    const { items } = await listTracksHubPage({}, 1);

    const finding = items.find((entry) => entry.kind === "finding");
    const catalogue = items.find((entry) => entry.kind === "catalogue");

    expect(finding?.kind === "finding" && finding.finding.logId).toBe("200.7.1A");
    // The Unlit Rule: a catalogue row carries no coordinate.
    expect(catalogue?.kind === "catalogue" && "logId" in catalogue.track).toBe(false);
    expect(catalogue?.kind === "catalogue" && catalogue.track.trackId).toBe("c1");
  });

  it("resolves an artist credit to its slug when the entity exists, plain otherwise", async () => {
    await seedArtist("art_1", "Artist", "artist-one");
    await seedTrack({ releaseDate: "2022-01-01", trackId: "linked" });
    await linkArtist("linked", "art_1");
    // No `track_artists` row → no entity → a plain-text credit.
    await seedTrack({ releaseDate: "2021-01-01", trackId: "orphan" });

    const { items } = await listTracksHubPage({}, 1);
    const linked = items.find((entry) => ids([entry])[0] === "linked");
    const orphan = items.find((entry) => ids([entry])[0] === "orphan");

    expect(linked?.artistLinks).toEqual([{ name: "Artist", slug: "artist-one" }]);
    expect(orphan?.artistLinks).toEqual([{ name: "Artist" }]);
  });

  it("carries the imprint slug on both registers when the label has a page", async () => {
    await seedLabel("lbl_1", "Hospital Records", "hospital-records");
    await seedTrack({
      label: "Hospital Records",
      labelId: "lbl_1",
      releaseDate: "2022-01-01",
      trackId: "f1",
    });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({
      label: "Hospital Records",
      labelId: "lbl_1",
      releaseDate: "2021-01-01",
      trackId: "c1",
    });

    const { items } = await listTracksHubPage({}, 1);
    const finding = items.find((entry) => entry.kind === "finding");
    const catalogue = items.find((entry) => entry.kind === "catalogue");

    expect(finding?.kind === "finding" && finding.finding.labelSlug).toBe("hospital-records");
    expect(catalogue?.kind === "catalogue" && catalogue.labelSlug).toBe("hospital-records");
    expect(catalogue?.kind === "catalogue" && catalogue.label).toBe("Hospital Records");
  });
});

describe("listTracksHubPage — the order", () => {
  it("is newest release first, track_id the tiebreak, undated rows last", async () => {
    await seedTrack({ releaseDate: "2020-05-01", trackId: "old" });
    await seedTrack({ releaseDate: "2023-05-01", trackId: "new" });
    await seedTrack({ releaseDate: "2023-05-01", trackId: "tie" });
    await seedTrack({ releaseDate: null, trackId: "undated" });

    const { items } = await listTracksHubPage({}, 1);

    // 2023 rows first (track_id desc within the tie → "tie" before "new"), then 2020, then null last.
    expect(ids(items)).toEqual(["tie", "new", "old", "undated"]);
  });
});

describe("listTracksHubPage — numbered pagination", () => {
  it("slices into 48-row pages with an honest total + page count", async () => {
    // 50 dated rows → page 1 is full (48), page 2 carries the remaining 2.
    for (let index = 0; index < 50; index += 1) {
      const day = String(index + 1).padStart(2, "0");
      await seedTrack({ releaseDate: `2021-01-${day}`, trackId: `t${day}` });
    }

    const page1 = await listTracksHubPage({}, 1);
    const page2 = await listTracksHubPage({}, 2);

    expect(page1.page).toBe(1);
    expect(page1.total).toBe(50);
    expect(page1.pageCount).toBe(2);
    expect(page1.items).toHaveLength(TRACKS_HUB_PAGE_SIZE);
    expect(page2.items).toHaveLength(2);

    // Every row appears once across the two pages.
    const seen = new Set([...ids(page1.items), ...ids(page2.items)]);
    expect(seen.size).toBe(50);
  });

  it("throws for a page past the end (the route 404s, never clamps)", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "only" });

    await expect(listTracksHubPage({}, 2)).rejects.toBeInstanceOf(CatalogueHubPageOutOfRangeError);
  });

  it("page 1 of an empty result is a legitimate empty page, never a throw", async () => {
    const page = await listTracksHubPage({ bpmMin: 500 }, 1);

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.pageCount).toBe(1);
  });
});

describe("listTracksHubPage — the filters compose with the page", () => {
  it("filters by BPM range", async () => {
    await seedTrack({ bpm: 174, releaseDate: "2022-01-01", trackId: "dnb" });
    await seedTrack({ bpm: 128, releaseDate: "2022-01-01", trackId: "house" });

    const { items, total } = await listTracksHubPage({ bpmMax: 180, bpmMin: 170 }, 1);

    expect(ids(items)).toEqual(["dnb"]);
    expect(total).toBe(1);
  });

  it("filters by key, folding enharmonic spellings", async () => {
    await seedTrack({ key: "A# minor", releaseDate: "2022-01-01", trackId: "sharp" });
    await seedTrack({ key: "C major", releaseDate: "2022-01-01", trackId: "other" });

    const { items } = await listTracksHubPage({ key: "Bb minor" }, 1);

    expect(ids(items)).toEqual(["sharp"]);
  });

  it("filters by release year range", async () => {
    await seedTrack({ releaseDate: "2015-06-01", trackId: "y2015" });
    await seedTrack({ releaseDate: "2024-06-01", trackId: "y2024" });

    const { items } = await listTracksHubPage({ yearMax: 2026, yearMin: 2020 }, 1);

    expect(ids(items)).toEqual(["y2024"]);
  });

  it("filters by label (the raw string, case-insensitively)", async () => {
    await seedTrack({ label: "Hospital Records", releaseDate: "2022-01-01", trackId: "hosp" });
    await seedTrack({ label: "Shogun Audio", releaseDate: "2022-01-01", trackId: "shogun" });

    const { items } = await listTracksHubPage({ label: "hospital records" }, 1);

    expect(ids(items)).toEqual(["hosp"]);
  });

  it("filters by galaxy, narrowing the list to certified findings only", async () => {
    await seedGalaxy({ id: "gal_named", name: "Green Sector", slug: "green-sector" });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "in_galaxy" });
    await certify({ galaxyId: "gal_named", logId: "200.7.1A", trackId: "in_galaxy" });
    await seedTrack({ releaseDate: "2022-06-01", trackId: "catalogue_row" });

    const { items } = await listTracksHubPage({ galaxy: "green-sector" }, 1);

    expect(ids(items)).toEqual(["in_galaxy"]);
    expect(items.every((entry) => entry.kind === "finding")).toBe(true);
  });

  it("an unnamed galaxy resolves to nothing (the launch-gate guard in the clause)", async () => {
    await seedGalaxy({ id: "gal_unnamed", name: null, slug: null });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "assigned" });
    await certify({ galaxyId: "gal_unnamed", logId: "200.7.1A", trackId: "assigned" });

    const { items } = await listTracksHubPage({ galaxy: "whatever" }, 1);

    expect(items).toEqual([]);
  });
});

describe("the year fast lane", () => {
  it("maps each present year to the page it starts on, newest first, undated excluded", async () => {
    await seedTrack({ releaseDate: "2024-05-01", trackId: "a" });
    await seedTrack({ releaseDate: "2024-01-01", trackId: "b" });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "c" });
    await seedTrack({ releaseDate: null, trackId: "undated" });

    const lane = await listTracksHubYearLane({});

    // Both years fit on page 1 (4 rows < 48); the undated row is not a year.
    expect(lane).toEqual([
      { page: 1, year: "2024" },
      { page: 1, year: "2022" },
    ]);
  });

  it("composes with an active non-year filter", async () => {
    await seedTrack({ bpm: 174, releaseDate: "2023-01-01", trackId: "dnb" });
    await seedTrack({ bpm: 128, releaseDate: "2024-01-01", trackId: "house" });

    const lane = await listTracksHubYearLane({ bpmMin: 170 });

    expect(lane).toEqual([{ page: 1, year: "2023" }]);
  });

  it("yearPages folds counts to pages by the page size (pure)", () => {
    expect(
      yearPages(
        [
          { n: 50, year: "2024" },
          { n: 10, year: "2023" },
          { n: 5, year: "2022" },
        ],
        48,
      ),
    ).toEqual([
      { page: 1, year: "2024" }, // rank 0
      { page: 2, year: "2023" }, // rank 50 → floor(50/48)+1
      { page: 2, year: "2022" }, // rank 60 → floor(60/48)+1
    ]);
  });
});

describe("countAllTracks", () => {
  it("counts every held track, findings + catalogue", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "f1" });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "c1" });
    await seedTrack({ releaseDate: null, trackId: "c2" });

    expect(await countAllTracks()).toBe(3);
  });
});

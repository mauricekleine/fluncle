// THE GROUPED QUIETER ROWS — the reads the /artist/<slug> and /label/<slug> pages are built on
// once the crawl has filled them, proven against the REAL migrated schema on an in-memory libSQL
// engine (the graph-entities.test.ts harness). Two halves:
//
//   1. The PURE helpers (sort order, the pager window) — no database, so the two rules that are
//      easy to get wrong and impossible to see are pinned directly: an undated group sorts LAST
//      (never first, which is where SQLite's NULL-is-smallest would put it), and the nameless
//      bucket sorts after everything.
//   2. The DB-backed grouped reads — the record grouping on the artist page, the artist→record
//      grouping on the label page, the per-group cap, and the two catalogue-rail guarantees:
//      a crawl-only artist with no entity still appears (grouped by their raw name, no link),
//      and nothing here ever carries a coordinate.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillArtistLinks } from "../../../scripts/backfill-artist-links";
import { getArtistBySlug } from "./artists";
import {
  CataloguePageOutOfRangeError,
  flattenArtistGroups,
  flattenRecords,
  GRAPH_GROUP_TRACK_LIMIT,
  listArtistCatalogue,
  listLabelCatalogue,
  pageNumbers,
  parseCatalogueSort,
} from "./catalogue-groups";
import { createIntegrationDb } from "./integration-db";

describe("parseCatalogueSort", () => {
  it("keeps a known sort and folds anything else to the A–Z default", () => {
    expect(parseCatalogueSort("recent")).toBe("recent");
    expect(parseCatalogueSort("name")).toBe("name");
    expect(parseCatalogueSort("nonsense")).toBe("name");
    expect(parseCatalogueSort(undefined)).toBe("name");
  });
});

describe("pageNumbers", () => {
  it("returns a window around the current page, clamped to the ends", () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(pageNumbers(20, 20)).toEqual([16, 17, 18, 19, 20]);
  });

  it("never runs past a short pager", () => {
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(2, 2)).toEqual([1, 2]);
  });
});

// ── The DB-backed grouped reads ─────────────────────────────────────────────────────────

let db: Client;

/** A crawled (uncertified) track: a `tracks` row with no `findings` row. */
async function seedCatalogueTrack(options: {
  album: null | string;
  artists: string[];
  labelId: string;
  releaseDate: null | string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(options.artists),
      options.album,
      options.labelId,
      options.releaseDate,
      `https://open.spotify.com/track/${options.trackId}`,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, album, label_id, release_date, spotify_url,
             duration_ms)
          values (?, ?, ?, ?, ?, ?, ?, 0)`,
  });
}

async function seedArtist(id: string, name: string, slug: string): Promise<void> {
  const now = "2026-07-01T00:00:00.000Z";

  await db.execute({
    args: [id, name, slug, now, now],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  await db.execute({
    args: ["lbl_1", "Hospital Records", "hospital-records", "enabled", "x", "x"],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
});

describe("listArtistCatalogue (the artist page's records)", () => {
  beforeEach(async () => {
    await seedArtist("art_nutone", "Nu:Tone", "nu-tone");
    // Two records, plus a track with no album (the nameless bucket).
    await seedCatalogueTrack({
      album: "Words Gone Forever",
      artists: ["Nu:Tone"],
      labelId: "lbl_1",
      releaseDate: "2018-01-01",
      trackId: "t_a1",
    });
    await seedCatalogueTrack({
      album: "Words Gone Forever",
      artists: ["Nu:Tone"],
      labelId: "lbl_1",
      releaseDate: "2018-01-01",
      trackId: "t_a2",
    });
    await seedCatalogueTrack({
      album: "The Elements",
      artists: ["Nu:Tone"],
      labelId: "lbl_1",
      releaseDate: "2022-01-01",
      trackId: "t_b1",
    });
    await seedCatalogueTrack({
      album: null,
      artists: ["Nu:Tone"],
      labelId: "lbl_1",
      releaseDate: null,
      trackId: "t_loose",
    });
    await backfillArtistLinks(db);
  });

  it("groups the tracks into records, nameless bucket last, and counts in SQL", async () => {
    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "name", 1);

    expect(page.totalGroups).toBe(3);
    expect(page.totalTracks).toBe(4);
    // A–Z by record, with the nameless record (undefined name) forced to the end.
    expect(page.groups.map((group) => group.name)).toEqual([
      "The Elements",
      "Words Gone Forever",
      undefined,
    ]);
    // The two-track record carries both, in the same group.
    const words = page.groups.find((group) => group.name === "Words Gone Forever");

    expect(words?.tracks.map((track) => track.trackId).sort()).toEqual(["t_a1", "t_a2"]);
  });

  it("orders records by newest release under 'recent', and every row is coordinate-less", async () => {
    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "recent", 1);

    // 2022 record before the 2018 one, the undated (nameless) record last.
    expect(page.groups.map((group) => group.name)).toEqual([
      "The Elements",
      "Words Gone Forever",
      undefined,
    ]);
    // THE RAIL: not one quieter row carries a coordinate, so none can pose as a finding.
    expect(flattenRecords(page.groups).every((track) => !("logId" in track))).toBe(true);
  });
});

describe("listLabelCatalogue (the label page's artists, then records)", () => {
  it("groups by artist and keeps a crawl-only artist (no entity, no link)", async () => {
    // Certified nobody: no `artists` row for either name, so the label page must fall back to the
    // raw credited name and simply carry no `/artist/<slug>` link — never DROP the tracks.
    await seedCatalogueTrack({
      album: "Platinum Breakz",
      artists: ["Doc Scott"],
      labelId: "lbl_1",
      releaseDate: "1996-01-01",
      trackId: "t_1",
    });
    await seedCatalogueTrack({
      album: "Platinum Breakz",
      artists: ["Doc Scott"],
      labelId: "lbl_1",
      releaseDate: "1996-01-01",
      trackId: "t_2",
    });
    await seedCatalogueTrack({
      album: "Timeless",
      artists: ["Goldie"],
      labelId: "lbl_1",
      releaseDate: "1995-01-01",
      trackId: "t_3",
    });
    // Goldie HAS an entity — its group must carry the link; Doc Scott must not.
    await seedArtist("art_goldie", "Goldie", "goldie");
    await backfillArtistLinks(db);

    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(page.totalGroups).toBe(2);
    expect(page.totalTracks).toBe(3);

    const docScott = page.groups.find((group) => group.name === "Doc Scott");
    const goldie = page.groups.find((group) => group.name === "Goldie");

    expect(docScott?.slug).toBeUndefined();
    expect(docScott?.recordCount).toBe(1);
    expect(docScott?.records[0]?.tracks).toHaveLength(2);
    expect(goldie?.slug).toBe("goldie");
    // The whole flattened page is coordinate-less (the rail again).
    expect(flattenArtistGroups(page.groups).every((track) => !("logId" in track))).toBe(true);
  });

  it("caps each artist group at GRAPH_GROUP_TRACK_LIMIT and flags the overflow", async () => {
    const over = GRAPH_GROUP_TRACK_LIMIT + 5;

    for (let i = 0; i < over; i++) {
      await seedCatalogueTrack({
        album: `Record ${String(i).padStart(2, "0")}`,
        artists: ["London Elektricity"],
        labelId: "lbl_1",
        releaseDate: "2010-01-01",
        trackId: `t_${i}`,
      });
    }

    const page = await listLabelCatalogue("lbl_1", "name", 1);
    const group = page.groups[0];

    // The group knows its TRUE record count (counted in SQL over the whole group)…
    expect(group?.recordCount).toBe(over);
    // …but renders at most the cap, and says there is more.
    expect(flattenRecords(group?.records ?? [])).toHaveLength(GRAPH_GROUP_TRACK_LIMIT);
    expect(group?.truncated).toBe(true);
  });

  it("throws for a page past the end so the route can 404 it", async () => {
    await seedCatalogueTrack({
      album: "One",
      artists: ["Solo"],
      labelId: "lbl_1",
      releaseDate: null,
      trackId: "t_1",
    });

    await expect(listLabelCatalogue("lbl_1", "name", 5)).rejects.toBeInstanceOf(
      CataloguePageOutOfRangeError,
    );
  });

  it("returns an empty page (no throw) for page 1 of a label with no quieter rows", async () => {
    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(page).toMatchObject({ groups: [], totalGroups: 0, totalTracks: 0 });
  });
});

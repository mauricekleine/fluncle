import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillArtistLinks } from "../../../scripts/backfill-artist-links";
import { ARTIST_CATALOGUE_SORT_DEFAULT } from "../../routes/artist.$slug";
import { getArtistBySlug } from "./artists";
import {
  CataloguePageOutOfRangeError,
  flattenArtistGroups,
  flattenRecords,
  GRAPH_GROUP_PAGE_SIZE,
  GRAPH_GROUP_ROW_CEILING,
  GRAPH_GROUP_TRACK_LIMIT,
  listArtistCatalogue,
  listArtistUpcoming,
  listLabelCatalogue,
  listLabelUpcoming,
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

let db: Client;

async function seedCatalogueTrack(options: {
  album: null | string;
  artists: string[];
  dismissedAt?: string;
  duplicateOfTrackId?: string;
  isrc?: string;
  labelId: string;
  releaseDate: null | string;
  spotifyUrl?: null | string;
  title?: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      options.title ?? `Title ${options.trackId}`,
      JSON.stringify(options.artists),
      options.album,
      options.labelId,
      options.releaseDate,
      options.spotifyUrl === undefined
        ? `https://open.spotify.com/track/${options.trackId}`
        : options.spotifyUrl,
      options.isrc ?? null,
      options.duplicateOfTrackId ?? null,
      options.dismissedAt ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, album, label_id, release_date, spotify_url,
             isrc, duplicate_of_track_id, dismissed_at, duration_ms)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  });
}

async function seedArtist(id: string, name: string, slug: string): Promise<void> {
  const now = "2026-07-01T00:00:00.000Z";

  await db.execute({
    args: [id, name, slug, now, now],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function seedCertifiedFinding(
  trackId: string,
  artistId: string,
  artistName: string,
): Promise<void> {
  await db.execute({
    args: [trackId, `Certified ${trackId}`, JSON.stringify([artistName])],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms) values (?, ?, ?, 0)`,
  });
  await db.execute({
    args: [trackId, `100.1.1A-${trackId}`],
    sql: `insert into findings (track_id, log_id, added_at) values (?, ?, '2020-01-01T00:00:00.000Z')`,
  });
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
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

describe("upcoming entity tracks", () => {
  it("keeps a future finding credited only in artists_json on its artist page", async () => {
    await seedArtist("art_future", "Future Artist", "future-artist");
    await seedCertifiedFinding("future-no-edge", "art_future", "Future Artist");
    await db.execute({
      args: ["future-no-edge"],
      sql: `delete from track_artists where track_id = ?`,
    });
    await db.execute({
      args: ["2026-11-01", "future-no-edge"],
      sql: `update tracks set release_date = ? where track_id = ?`,
    });

    const page = await listArtistUpcoming("art_future", "2026-10-01");
    expect(page.findings.map((finding) => finding.trackId)).toEqual(["future-no-edge"]);
  });

  it("pages every future row without dropping the tail", async () => {
    await seedArtist("art_future", "Future Artist", "future-artist");
    const rows = Array.from(
      { length: GRAPH_GROUP_ROW_CEILING + 1 },
      (_, index) => `future-${String(index).padStart(3, "0")}`,
    );
    await db.batch(
      rows.flatMap((trackId) => [
        {
          args: [trackId, trackId, '["Future Artist"]', "2026-11-01", "lbl_1"],
          sql: `insert into tracks(track_id,title,artists_json,release_date,label_id,duration_ms) values (?,?,?,?,?,0)`,
        },
        {
          args: [trackId, "art_future"],
          sql: `insert into track_artists(track_id,artist_id,position) values (?,?,1)`,
        },
      ]),
      "write",
    );

    for (const list of [
      listArtistUpcoming("art_future", "2026-10-01", 1),
      listLabelUpcoming("lbl_1", "2026-10-01", 1),
    ]) {
      const first = await list;
      expect(first.tracks).toHaveLength(GRAPH_GROUP_ROW_CEILING);
      expect(first.pageCount).toBe(2);
    }
    const artistTail = await listArtistUpcoming("art_future", "2026-10-01", 2);
    const labelTail = await listLabelUpcoming("lbl_1", "2026-10-01", 2);
    expect(artistTail.tracks.map((track) => track.trackId)).toEqual([rows.at(-1)]);
    expect(labelTail.tracks.map((track) => track.trackId)).toEqual([rows.at(-1)]);
  });

  it("pages the tracks before it reads any album or finding", async () => {
    await seedArtist("art_future", "Future Artist", "future-artist");

    const statements: string[] = [];
    const recorder: Pick<Client, "execute"> = {
      execute: async (statement: InStatement) => {
        statements.push(typeof statement === "string" ? statement : statement.sql);
        return db.execute(statement);
      },
    };

    holder.db = recorder as Client;
    await listArtistUpcoming("art_future", "2026-10-01");
    await listLabelUpcoming("lbl_1", "2026-10-01");
    holder.db = db;

    const pageStatements = statements.filter((sql) => sql.includes("upcoming_page"));

    expect(pageStatements).toHaveLength(2);

    for (const sql of pageStatements) {
      const plan = (
        await db.execute({ args: [], sql: `explain query plan ${sql.replaceAll("?", "null")}` })
      ).rows as unknown as { detail: string; id: number; parent: number }[];
      const pageRoot = plan.find((row) =>
        /(?:CO-ROUTINE|MATERIALIZE) upcoming_page/.test(row.detail),
      );
      const inPage = new Set<number>(pageRoot ? [pageRoot.id] : []);

      for (const row of plan) {
        if (inPage.has(row.parent)) {
          inPage.add(row.id);
        }
      }

      const page = plan
        .filter((row) => inPage.has(row.id))
        .map((row) => row.detail)
        .join("\n");
      const outside = plan
        .filter((row) => !inPage.has(row.id))
        .map((row) => row.detail)
        .join("\n");

      expect(pageRoot, sql).toBeDefined();

      expect(page).not.toMatch(/\b(?:al|albums|findings)\b/);

      expect(outside).toMatch(/SEARCH al USING INTEGER PRIMARY KEY|SEARCH al USING INDEX/);
      expect(outside).toMatch(/SEARCH findings USING/);
    }
  });

  it("carries the same cover, readout and preview flag as every other track row", async () => {
    await seedArtist("art_future", "Future Artist", "future-artist");
    await db.batch(
      [
        {
          args: ["future-rich", "Rich", '["Future Artist"]', "2026-11-01", "lbl_1"],
          sql: `insert into tracks(track_id,title,artists_json,release_date,label_id,duration_ms,
                  bpm,key,isrc,album_image_url)
                values (?,?,?,?,?,241000,174,'8A','GBTEST0000001','https://i.scdn.co/image/rich')`,
        },
        {
          args: ["future-rich", "art_future"],
          sql: `insert into track_artists(track_id,artist_id,position) values (?,?,1)`,
        },
      ],
      "write",
    );

    for (const page of [
      await listArtistUpcoming("art_future", "2026-10-01"),
      await listLabelUpcoming("lbl_1", "2026-10-01"),
    ]) {
      expect(page.tracks[0]).toMatchObject({
        albumImageUrl: expect.stringContaining("rich"),
        bpm: 174,
        durationMs: 241000,
        key: "8A",
        previewable: true,
        releaseDate: "2026-11-01",
        trackId: "future-rich",
      });
    }
  });

  it("separates full and partial future dates from both released catalogues", async () => {
    await seedArtist("art_future", "Future Artist", "future-artist");
    for (const [trackId, releaseDate] of [
      ["today", "2026-10-01"],
      ["month", "2026-10"],
      ["future-day", "2026-10-02"],
      ["future-month", "2026-11"],
    ] as const) {
      await seedCatalogueTrack({
        album: "Next Record",
        artists: ["Future Artist"],
        labelId: "lbl_1",
        releaseDate,
        trackId,
      });
    }
    await backfillArtistLinks(db);
    await seedCertifiedFinding("future-certified", "art_future", "Future Artist");
    await db.execute({
      args: ["2026-10-03", "lbl_1", "future-certified"],
      sql: `update tracks set release_date = ?, label_id = ? where track_id = ?`,
    });

    const artistUpcoming = await listArtistUpcoming("art_future", "2026-10-01");
    const labelUpcoming = await listLabelUpcoming("lbl_1", "2026-10-01");
    expect(artistUpcoming.tracks.map((track) => track.trackId)).toEqual([
      "future-day",
      "future-month",
    ]);
    expect(labelUpcoming.tracks.map((track) => track.trackId)).toEqual([
      "future-day",
      "future-month",
    ]);
    expect(artistUpcoming.findings.map((finding) => finding.trackId)).toEqual(["future-certified"]);
    expect(labelUpcoming.findings.map((finding) => finding.trackId)).toEqual(["future-certified"]);
    expect(
      flattenRecords((await listArtistCatalogue("art_future", "recent", 1, "2026-10-01")).groups)
        .map((track) => track.trackId)
        .sort(),
    ).toEqual(["month", "today"]);
    expect(
      flattenArtistGroups((await listLabelCatalogue("lbl_1", "recent", 1, "2026-10-01")).groups)
        .map((track) => track.trackId)
        .sort(),
    ).toEqual(["month", "today"]);
  });
});

describe("listArtistCatalogue (the artist page's records)", () => {
  beforeEach(async () => {
    await seedArtist("art_nutone", "Nu:Tone", "nu-tone");

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
    await db.execute({
      args: ["t_a1"],
      sql: `update tracks set album_image_url = 'https://i.scdn.co/image/cover',
             duration_ms = 205000, bpm = 173, key = 'D minor',
             preview_url = 'https://example.com/preview.mp3' where track_id = ?`,
    });
    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "name", 1);

    expect(page.totalGroups).toBe(3);
    expect(page.totalTracks).toBe(4);

    expect(page.groups.map((group) => group.name)).toEqual([
      "The Elements",
      "Words Gone Forever",
      undefined,
    ]);

    const words = page.groups.find((group) => group.name === "Words Gone Forever");

    expect(words?.tracks.map((track) => track.trackId).sort()).toEqual(["t_a1", "t_a2"]);
    expect(words?.tracks.find((track) => track.trackId === "t_a1")).toMatchObject({
      albumImageUrl: expect.any(String),
      bpm: 173,
      durationMs: 205000,
      key: "D minor",
      previewable: true,
      releaseDate: "2018-01-01",
    });
  });

  it("orders records by newest release under 'recent', and every row is coordinate-less", async () => {
    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "recent", 1);

    expect(page.groups.map((group) => group.name)).toEqual([
      "The Elements",
      "Words Gone Forever",
      undefined,
    ]);

    expect(flattenRecords(page.groups).every((track) => !("logId" in track))).toBe(true);
  });

  it("defaults the artist page to latest release first (no sort param → release-date-desc)", async () => {
    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, ARTIST_CATALOGUE_SORT_DEFAULT, 1);

    expect(page.groups.map((group) => group.name)).toEqual([
      "The Elements",
      "Words Gone Forever",
      undefined,
    ]);
  });

  it("links a record heading to its album ENTITY even when the album has no finding", async () => {
    await db.execute({
      args: ["alb_wgf", "Words Gone Forever", "words-gone-forever", "x", "x"],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["alb_wgf", "t_a1", "t_a2"],
      sql: `update tracks set album_id = ? where track_id in (?, ?)`,
    });

    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "name", 1);
    const words = page.groups.find((group) => group.name === "Words Gone Forever");

    const nameless = page.groups.find((group) => group.name === undefined);

    expect(words?.slug).toBe("words-gone-forever");
    expect(nameless?.slug).toBeUndefined();
  });
});

describe("listLabelCatalogue (the label page's artists, then records)", () => {
  it("links any artist ENTITY's heading (findings or not) — only a nameless credit renders plain", async () => {
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
      album: "Musique Concrète",
      artists: ["Calibre"],
      labelId: "lbl_1",
      releaseDate: "2001-01-01",
      trackId: "t_c1",
    });
    await seedCatalogueTrack({
      album: "Timeless",
      artists: ["Goldie"],
      labelId: "lbl_1",
      releaseDate: "1995-01-01",
      trackId: "t_3",
    });
    await seedArtist("art_calibre", "Calibre", "calibre");
    await seedArtist("art_goldie", "Goldie", "goldie");

    await seedCertifiedFinding("t_goldie_finding", "art_goldie", "Goldie");
    await backfillArtistLinks(db);
    await db.execute({
      args: ["t_c1"],
      sql: `update tracks set album_image_url = 'https://i.scdn.co/image/cover',
             duration_ms = 220000, bpm = 171, key = 'A minor', isrc = 'GBTEST2600002'
             where track_id = ?`,
    });

    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(page.totalGroups).toBe(3);
    expect(page.totalTracks).toBe(4);

    const docScott = page.groups.find((group) => group.name === "Doc Scott");
    const calibre = page.groups.find((group) => group.name === "Calibre");
    const goldie = page.groups.find((group) => group.name === "Goldie");

    expect(docScott?.slug).toBeUndefined();
    expect(docScott?.recordCount).toBe(1);
    expect(docScott?.records[0]?.tracks).toHaveLength(2);

    expect(calibre?.slug).toBe("calibre");
    expect(calibre?.records[0]?.tracks).toHaveLength(1);
    expect(calibre?.records[0]?.tracks[0]).toMatchObject({
      albumImageUrl: expect.any(String),
      bpm: 171,
      durationMs: 220000,
      key: "A minor",
      previewable: true,
      releaseDate: "2001-01-01",
    });

    expect(goldie?.slug).toBe("goldie");

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

    expect(group?.recordCount).toBe(over);

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

describe("the duplicate defence (a recording renders once)", () => {
  beforeEach(async () => {
    await seedArtist("art_serum", "Serum", "serum");

    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      spotifyUrl: "https://open.spotify.com/track/anchored",
      title: "20 Man Down",
      trackId: "t_anchored",
    });
    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      spotifyUrl: null,
      title: "20 Man Down",
      trackId: "t_bare",
    });

    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      duplicateOfTrackId: "t_anchored",
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      title: "Selecta",
      trackId: "t_stamped",
    });

    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      dismissedAt: "2026-07-01T00:00:00.000Z",
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      title: "On the Block",
      trackId: "t_dismissed",
    });

    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      title: "Baddadan",
      trackId: "t_orig",
    });
    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      title: "Baddadan (Kanine Remix)",
      trackId: "t_remix",
    });
    await backfillArtistLinks(db);
  });

  it("folds the label page to one row per recording, votes the anchored twin, counts the deduped set", async () => {
    const page = await listLabelCatalogue("lbl_1", "name", 1);
    const rendered = flattenArtistGroups(page.groups).map((track) => track.trackId);

    expect(rendered.sort()).toEqual(["t_anchored", "t_orig", "t_remix"]);

    expect(page.totalTracks).toBe(3);
  });

  it("folds the artist page the same way and keeps its count honest", async () => {
    const artist = await getArtistBySlug("serum");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "name", 1);
    const rendered = flattenRecords(page.groups).map((track) => track.trackId);

    expect(rendered.sort()).toEqual(["t_anchored", "t_orig", "t_remix"]);
    expect(page.totalTracks).toBe(3);
  });

  it("folds a '(Original Version)' reissue onto its base title (RC3 end to end)", async () => {
    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      spotifyUrl: null,
      title: "20 Man Down (Original Version)",
      trackId: "t_original_version",
    });
    await backfillArtistLinks(db);

    const page = await listLabelCatalogue("lbl_1", "name", 1);
    const rendered = flattenArtistGroups(page.groups).map((track) => track.trackId);

    expect(rendered).not.toContain("t_original_version");
    expect(rendered.sort()).toEqual(["t_anchored", "t_orig", "t_remix"]);
    expect(page.totalTracks).toBe(3);
  });
});

describe("one statement, one walk", () => {
  function countStatements(): { calls: string[] } {
    const calls: string[] = [];
    const original = db.execute.bind(db);

    vi.spyOn(db, "execute").mockImplementation(((stmt: InStatement) => {
      calls.push(typeof stmt === "string" ? stmt : stmt.sql);

      return original(stmt);
    }) as typeof db.execute);

    return { calls };
  }

  it("reads an artist's whole catalogue page in a single round trip", async () => {
    await seedArtist("art_hybrid", "Hybrid Minds", "hybrid-minds");
    await seedCatalogueTrack({
      album: "Elements",
      artists: ["Hybrid Minds"],
      labelId: "lbl_1",
      releaseDate: "2016-01-01",
      trackId: "t_h1",
    });
    await backfillArtistLinks(db);

    const artist = await getArtistBySlug("hybrid-minds");

    if (!artist) {
      throw new Error("artist missing");
    }

    const spy = countStatements();
    const page = await listArtistCatalogue(artist.id, "name", 1);

    expect(spy.calls).toHaveLength(1);
    expect(page.groups).toHaveLength(1);
    expect(page.totalTracks).toBe(1);
  });

  it("reads a label's whole catalogue page in a single round trip", async () => {
    await seedCatalogueTrack({
      album: "Elements",
      artists: ["Hybrid Minds"],
      labelId: "lbl_1",
      releaseDate: "2016-01-01",
      trackId: "t_h1",
    });

    const spy = countStatements();
    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(spy.calls).toHaveLength(1);
    expect(page.groups).toHaveLength(1);
    expect(page.totalTracks).toBe(1);
  });
});

describe("the pager, now cut by dense_rank", () => {
  const RECORDS = GRAPH_GROUP_PAGE_SIZE + 5;

  beforeEach(async () => {
    await seedArtist("art_calibre", "Calibre", "calibre");

    for (let i = 0; i < RECORDS; i++) {
      await seedCatalogueTrack({
        album: `Record ${String(i).padStart(2, "0")}`,
        artists: ["Calibre"],
        labelId: "lbl_1",

        releaseDate: `20${String(10 + i).padStart(2, "0")}-01-01`,
        trackId: `t_${i}`,
      });
    }

    await backfillArtistLinks(db);
  });

  it("partitions an artist's records across pages with no gap and no repeat", async () => {
    const artist = await getArtistBySlug("calibre");

    if (!artist) {
      throw new Error("artist missing");
    }

    const first = await listArtistCatalogue(artist.id, "name", 1);
    const second = await listArtistCatalogue(artist.id, "name", 2);

    expect(first.totalGroups).toBe(RECORDS);
    expect(first.pageCount).toBe(2);
    expect(first.groups).toHaveLength(GRAPH_GROUP_PAGE_SIZE);
    expect(second.groups).toHaveLength(RECORDS - GRAPH_GROUP_PAGE_SIZE);

    const names = [...first.groups, ...second.groups].map((group) => group.name ?? "");

    expect(new Set(names).size).toBe(RECORDS);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    expect(first.totalTracks).toBe(RECORDS);
  });

  it("keeps the pages disjoint under 'recent' too, newest record first", async () => {
    const artist = await getArtistBySlug("calibre");

    if (!artist) {
      throw new Error("artist missing");
    }

    const first = await listArtistCatalogue(artist.id, "recent", 1);
    const second = await listArtistCatalogue(artist.id, "recent", 2);
    const names = [...first.groups, ...second.groups].map((group) => group.name ?? "");

    expect(new Set(names).size).toBe(RECORDS);

    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)));
  });

  it("holds the page's hard row ceiling when every group is over its own cap", async () => {
    for (let record = 0; record < RECORDS; record++) {
      for (let track = 1; track <= GRAPH_GROUP_TRACK_LIMIT + 3; track++) {
        await seedCatalogueTrack({
          album: `Record ${String(record).padStart(2, "0")}`,
          artists: ["Calibre"],
          labelId: "lbl_1",
          releaseDate: "2015-01-01",
          trackId: `t_${record}_${track}`,
        });
      }
    }

    await backfillArtistLinks(db);

    const artist = await getArtistBySlug("calibre");

    if (!artist) {
      throw new Error("artist missing");
    }

    const page = await listArtistCatalogue(artist.id, "name", 1);

    expect(page.groups).toHaveLength(GRAPH_GROUP_PAGE_SIZE);
    expect(flattenRecords(page.groups)).toHaveLength(GRAPH_GROUP_ROW_CEILING);

    for (const group of page.groups) {
      expect(group.tracks.length).toBeLessThanOrEqual(GRAPH_GROUP_TRACK_LIMIT);
    }
  });
});

describe("the label's two SQL counts, over the whole group", () => {
  it("counts a two-artist track ONCE in the total, while both artists still carry it", async () => {
    const solo = GRAPH_GROUP_PAGE_SIZE + 2;

    for (let i = 0; i < solo; i++) {
      await seedCatalogueTrack({
        album: `Record ${String(i).padStart(2, "0")}`,
        artists: [`Artist ${String(i).padStart(2, "0")}`],
        labelId: "lbl_1",
        releaseDate: "2020-01-01",
        trackId: `t_solo_${i}`,
      });
    }

    await seedCatalogueTrack({
      album: "Split",
      artists: ["Artist 00", "Artist 01"],
      labelId: "lbl_1",
      releaseDate: "2021-01-01",
      trackId: "t_pair",
    });

    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(page.totalGroups).toBe(solo);

    expect(page.totalTracks).toBe(solo + 1);
    expect(page.groups).toHaveLength(GRAPH_GROUP_PAGE_SIZE);

    const first = page.groups.find((group) => group.name === "Artist 00");
    const second = page.groups.find((group) => group.name === "Artist 01");

    expect(flattenRecords(first?.records ?? []).map((track) => track.trackId)).toContain("t_pair");
    expect(flattenRecords(second?.records ?? []).map((track) => track.trackId)).toContain("t_pair");
  });

  it("renders a credit ONCE when two artist entities share its name", async () => {
    await seedArtist("art_serum_a", "Serum", "serum");
    await seedArtist("art_serum_b", "Serum", "serum-2");
    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      trackId: "t_one",
    });

    const page = await listLabelCatalogue("lbl_1", "name", 1);
    const group = page.groups[0];

    expect(page.totalGroups).toBe(1);
    expect(page.totalTracks).toBe(1);
    expect(group?.recordCount).toBe(1);
    expect(group?.truncated).toBe(false);
    expect(flattenRecords(group?.records ?? []).map((track) => track.trackId)).toEqual(["t_one"]);

    expect(group?.slug).toBe("serum");
  });

  it("counts a truncated group's records over the WHOLE group, not the rendered slice", async () => {
    for (const album of ["Alpha", "Beta"]) {
      for (let i = 0; i < GRAPH_GROUP_TRACK_LIMIT; i++) {
        await seedCatalogueTrack({
          album,
          artists: ["Total Science"],
          labelId: "lbl_1",
          releaseDate: "2012-01-01",
          trackId: `t_${album}_${i}`,
        });
      }
    }

    const page = await listLabelCatalogue("lbl_1", "name", 1);
    const group = page.groups[0];

    expect(group?.recordCount).toBe(2);
    expect(group?.truncated).toBe(true);
    expect(flattenRecords(group?.records ?? [])).toHaveLength(GRAPH_GROUP_TRACK_LIMIT);

    expect(group?.records.map((record) => record.name)).toEqual(["Alpha"]);

    expect(page.totalTracks).toBe(GRAPH_GROUP_TRACK_LIMIT * 2);
  });
});

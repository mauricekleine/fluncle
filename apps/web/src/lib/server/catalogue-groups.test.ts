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

/**
 * A crawled (uncertified) track: a `tracks` row with no `findings` row. `title` defaults to a
 * unique `Title <id>`; pass an explicit one (with matching `artists`) to seed a TWIN — two rows
 * the crawler left unstamped that share one recording identity. The stamping columns
 * (`duplicateOfTrackId` / `dismissedAt`) and the anchors (`spotifyUrl` / `isrc`) are optional.
 */
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

/**
 * Certify an artist: a `findings` row (a real coordinate) crediting them, linked through
 * `track_artists`. A catalogue heading now links to ANY artist ENTITY (findings or not), so this
 * helper's job is to prove certified + findings-free entities both link; only an artist with no
 * `artists` row at all renders as plain text.
 */
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

  it("defaults the artist page to latest release first (no sort param → release-date-desc)", async () => {
    const artist = await getArtistBySlug("nu-tone");

    if (!artist) {
      throw new Error("artist missing");
    }

    // Drive the read with the SAME sort a param-free /artist/<slug> resolves to — the artist
    // route's default. So this pins the on-first-load ordering, not merely the "recent" branch:
    // the newest dated record leads, the older one follows, the undated (nameless) bucket sorts
    // last and never vanishes.
    const page = await listArtistCatalogue(artist.id, ARTIST_CATALOGUE_SORT_DEFAULT, 1);

    expect(page.groups.map((group) => group.name)).toEqual([
      "The Elements", // 2022 — newest release, first
      "Words Gone Forever", // 2018
      undefined, // the undated nameless bucket, forced last
    ]);
  });

  it("links a record heading to its album ENTITY even when the album has no finding", async () => {
    // Mint a findings-free album entity (as the crawler does inline) and stamp `album_id` on the
    // two "Words Gone Forever" catalogue rows. The record now has a public `/album/<slug>` page, so
    // its heading carries the slug — the album twin of the certified/findings-free artist link.
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
    // The nameless bucket (t_loose) still carries no album entity, so it stays plain.
    const nameless = page.groups.find((group) => group.name === undefined);

    expect(words?.slug).toBe("words-gone-forever");
    expect(nameless?.slug).toBeUndefined();
  });
});

describe("listLabelCatalogue (the label page's artists, then records)", () => {
  it("links any artist ENTITY's heading (findings or not) — only a nameless credit renders plain", async () => {
    // Three artists, three link outcomes, none of them DROPPED:
    //   · Doc Scott — no `artists` row at all → grouped by raw name, no link.
    //   · Calibre   — has an entity (the crawler minted it off a crawl anchor) but NO certified
    //                 finding → LINKS now: a findings-free artist has a public catalogue page, so
    //                 the heading points at `/artist/calibre`, exactly as the album heading does.
    //   · Goldie    — has an entity AND a certified finding → its heading carries the link.
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
    // Goldie earns a certified finding (elsewhere) — that, not the mere row, is what lights the link.
    await seedCertifiedFinding("t_goldie_finding", "art_goldie", "Goldie");
    await backfillArtistLinks(db);

    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(page.totalGroups).toBe(3);
    expect(page.totalTracks).toBe(4);

    const docScott = page.groups.find((group) => group.name === "Doc Scott");
    const calibre = page.groups.find((group) => group.name === "Calibre");
    const goldie = page.groups.find((group) => group.name === "Goldie");

    expect(docScott?.slug).toBeUndefined();
    expect(docScott?.recordCount).toBe(1);
    expect(docScott?.records[0]?.tracks).toHaveLength(2);
    // The findings-free entity is grouped, its track kept, AND linked (it has a public page now).
    expect(calibre?.slug).toBe("calibre");
    expect(calibre?.records[0]?.tracks).toHaveLength(1);
    // The certified entity carries the link too.
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

describe("the duplicate defence (a recording renders once)", () => {
  // One artist, one record, seeded with the four cases the graph pages have to survive:
  //   · an unstamped TWIN (two rows, one identity) the crawler never marked — folds to one;
  //   · a STAMPED duplicate (`duplicate_of_track_id`) — vetoed in SQL;
  //   · a DISMISSED row (`dismissed_at`) — vetoed in SQL;
  //   · a genuinely distinct recording (a remix, distinct descriptor) — kept apart.
  beforeEach(async () => {
    await seedArtist("art_serum", "Serum", "serum");
    // The twin: same title + artist, so one recording identity. Only one carries the Spotify
    // anchor, so the fold must keep THAT row and drop the bare one.
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
    // Stamped a duplicate by the operator → out of the SQL read entirely.
    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      duplicateOfTrackId: "t_anchored",
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      title: "Selecta",
      trackId: "t_stamped",
    });
    // Dismissed → out of the SQL read too.
    await seedCatalogueTrack({
      album: "Rudeboy",
      artists: ["Serum"],
      dismissedAt: "2026-07-01T00:00:00.000Z",
      labelId: "lbl_1",
      releaseDate: "2019-01-01",
      title: "On the Block",
      trackId: "t_dismissed",
    });
    // A remix is a DIFFERENT recording (distinct descriptor + here a real gap) — never folded.
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

    // The twin folds to the Spotify-anchored row; the bare twin, the stamped duplicate and the
    // dismissed row are all gone; the two genuine recordings survive.
    expect(rendered.sort()).toEqual(["t_anchored", "t_orig", "t_remix"]);
    // Total reflects what renders — never the four vetoed/folded rows.
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
    // Same identity as the anchored "20 Man Down", tagged as the original version — collapses onto it.
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

// ── The single-statement shape (P5) ─────────────────────────────────────────────────────
//
// Both grouped reads used to arrive in WAVES — the artist page in two statements, the label page
// in three — and every wave is a round trip from the Worker to Turso in Ireland, each repeating
// the SAME indexed walk of the entity's rows. They are now ONE statement each, with the page of
// groups cut by `dense_rank()` instead of `limit`/`offset` and the group aggregates carried by
// windows. That rewrite is invisible from the outside, which is exactly why it needs pinning:
// the round-trip count is the guarantee, and the pager + the two SQL counts are what could
// silently drift now that they ride on windows rather than a `group by`.

describe("one statement, one walk", () => {
  /** Counts the statements a read issues, so a re-introduced wave fails here. */
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
  // One group per record, more of them than fit on a page, so the pager has to carry the rest.
  const RECORDS = GRAPH_GROUP_PAGE_SIZE + 5;

  beforeEach(async () => {
    await seedArtist("art_calibre", "Calibre", "calibre");

    for (let i = 0; i < RECORDS; i++) {
      await seedCatalogueTrack({
        album: `Record ${String(i).padStart(2, "0")}`,
        artists: ["Calibre"],
        labelId: "lbl_1",
        // Dates ascend with the name, so "recent" is the exact reverse of "name" — a pager that
        // silently ignored the sort would still look right under one of them.
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

    // Every record appears exactly once, and the two pages read as one A–Z run.
    expect(new Set(names).size).toBe(RECORDS);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // The track total is the WHOLE artist's, not the page's — the thin-content gate reads it.
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
    // Newest release leads, and the run descends across the page boundary.
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)));
  });

  it("holds the page's hard row ceiling when every group is over its own cap", async () => {
    // Every record on the page carries more tracks than one group may contribute, so the ceiling
    // is the only thing standing between a crawled artist and a dump.
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
    // The total is counted over TRACKS; the groups are counted over CREDITS. One statement now
    // carries both, so the two must not bleed into each other. Seeded past the page size so the
    // total is genuinely the SQL count of the whole label rather than the rendered row count.
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

    // One more track, credited to two of those same artists — one track, two credits.
    await seedCatalogueTrack({
      album: "Split",
      artists: ["Artist 00", "Artist 01"],
      labelId: "lbl_1",
      releaseDate: "2021-01-01",
      trackId: "t_pair",
    });

    const page = await listLabelCatalogue("lbl_1", "name", 1);

    expect(page.totalGroups).toBe(solo);
    // solo + 1 TRACKS (solo + 2 credits) — the total counts the tracks.
    expect(page.totalTracks).toBe(solo + 1);
    expect(page.groups).toHaveLength(GRAPH_GROUP_PAGE_SIZE);

    // …and the shared track is still in BOTH artists' groups, credited twice, dropped nowhere.
    const first = page.groups.find((group) => group.name === "Artist 00");
    const second = page.groups.find((group) => group.name === "Artist 01");

    expect(flattenRecords(first?.records ?? []).map((track) => track.trackId)).toContain("t_pair");
    expect(flattenRecords(second?.records ?? []).map((track) => track.trackId)).toContain("t_pair");
  });

  it("renders a credit ONCE when two artist entities share its name", async () => {
    // The crawler mints an artist per stable Spotify id, so two entities can carry one name. The
    // slug lookup must not multiply the credit's TRACK rows by however many of them there are —
    // the group would render every track twice and count them twice.
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
    // The heading still links — to the first slug, exactly as the old `min(a.slug)` chose.
    expect(group?.slug).toBe("serum");
  });

  it("counts a truncated group's records over the WHOLE group, not the rendered slice", async () => {
    // Two records, both far past the per-group cap. The cap drops rows from the SECOND record
    // entirely, so a record count taken over what rendered would say one — it must say two.
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
    // Only the first record fits under the cap, so that is all the page renders.
    expect(group?.records.map((record) => record.name)).toEqual(["Alpha"]);
    // The label's total still counts every track it carries.
    expect(page.totalTracks).toBe(GRAPH_GROUP_TRACK_LIMIT * 2);
  });
});

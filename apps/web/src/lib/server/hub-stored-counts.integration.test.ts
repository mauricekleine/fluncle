// THE READ SWAP, PROVEN — every entity-hub consumer reads the MAINTAINED counters
// (`renderable_track_count` / `certified_finding_count` on labels/albums/artists, keystone 2)
// instead of grouping `tracks` / `track_artists` / `findings` on each request.
//
// Behaviour is proven, not SQL text, and the fixture is what makes it a proof: each case seeds a
// world where the COLUMNS and the EDGES disagree, and asserts the reads follow the columns.
//
//   - COUNTERS, NO EDGES: an entity whose counters clear the floor with ZERO linked tracks is
//     listed. A read that still grouped the join could not possibly return it — an inner join to
//     `tracks` has nothing to group — so this is the structural pin that the join is gone.
//   - EDGES, NO COUNTERS: an entity with three real linked tracks and counters at the DDL default
//     of 0 is NOT listed. A read that still grouped the join would list it.
//
// That second case is also the honest statement of the tradeoff the swap accepts: the stored pair is
// the gate's source of truth, so a drifted counter shows. Keeping it true is the write side's job
// (lib/server/hub-counts.ts) with the deploy backfill + the reconciliation sweep behind it.
//
// The SITEMAP ROW readers are the one deliberate half-conversion and are pinned separately below:
// their GATE is the stored column, but they keep the `tracks ⋈ findings` join for the two per-row
// columns a `<url>` needs (`lastmod`, the cover), so they still require a linked track to emit a row
// — exactly as they did before.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import {
  countIndexableAlbums,
  getAlbumDetail,
  listAlbumsApiPage,
  listAlbumsBrowsePage,
  listAlbumsHubPage,
  listAlbumsMissingBio,
  listAlbumSitemapRows,
} from "./albums";
import {
  countIndexableArtists,
  getArtistListItemBySlug,
  listArtistsApiPage,
  listArtistsBrowsePage,
  listArtistsHubPage,
  listArtistsMissingBio,
  listArtistSitemapRows,
} from "./artists";
import { createIntegrationDb } from "./integration-db";
import {
  countIndexableLabels,
  getLabelDetail,
  listLabelsApiPage,
  listLabelsBrowsePage,
  listLabelsHubPage,
  listLabelsMissingBio,
  listLabelSitemapRows,
} from "./labels";
import { searchArchive } from "./search";

/** Every floor in play is 3 renderable tracks (LABEL/ALBUM/ARTIST_INDEX_MIN_*). */
const FLOOR = 3;

let db: Client;

/** An entity row with its counters stated OUTRIGHT — the state the delta writers would have left. */
async function seedEntity(
  table: "albums" | "artists" | "labels",
  options: { certified?: number; id: string; name: string; renderable?: number; slug: string },
): Promise<void> {
  await db.execute({
    args: [
      options.id,
      options.name,
      options.slug,
      options.renderable ?? 0,
      options.certified ?? 0,
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ],
    // `table` is one of three literals from the call sites, never input.
    sql: `insert into ${table}
            (id, name, slug, renderable_track_count, certified_finding_count, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
}

/** A CATALOGUE track (no `findings` row) pointed at every entity kind — a real, countable edge. */
async function seedLinkedTrack(options: {
  albumId: string;
  artistId: string;
  labelId: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [options.trackId, `Title ${options.trackId}`, options.albumId, options.labelId],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, album_id, label_id)
          values (?, ?, '["Artist"]', 270000, ?, ?)`,
  });
  await db.execute({
    args: [options.trackId, options.artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  translateQuery.mockReset();
  translateQuery.mockResolvedValue(null);

  // COUNTERS, NO EDGES — three entities whose stored counters clear the floor while `tracks` and
  // `track_artists` hold nothing at all for them.
  await seedEntity("labels", {
    certified: 1,
    id: "L_stored",
    name: "Stored Imprint",
    renderable: FLOOR,
    slug: "stored-imprint",
  });
  await seedEntity("albums", {
    certified: 1,
    id: "A_stored",
    name: "Stored Record",
    renderable: FLOOR,
    slug: "stored-record",
  });
  await seedEntity("artists", {
    certified: 1,
    id: "R_stored",
    name: "Stored Artist",
    renderable: FLOOR,
    slug: "stored-artist",
  });

  // EDGES, NO COUNTERS — three entities with FLOOR real linked catalogue tracks and counters at 0.
  await seedEntity("labels", {
    id: "L_edges",
    name: "Uncounted Imprint",
    slug: "uncounted-imprint",
  });
  await seedEntity("albums", { id: "A_edges", name: "Uncounted Record", slug: "uncounted-record" });
  await seedEntity("artists", {
    id: "R_edges",
    name: "Uncounted Artist",
    slug: "uncounted-artist",
  });

  for (let index = 0; index < FLOOR; index += 1) {
    await seedLinkedTrack({
      albumId: "A_edges",
      artistId: "R_edges",
      labelId: "L_edges",
      trackId: `edge-${index}`,
    });
  }
});

describe("the hub `?page=N` index reads the stored counters", () => {
  it("LABELS: lists the counted-but-edgeless label and omits the edged-but-uncounted one", async () => {
    const page = await listLabelsHubPage(1);

    expect(page.items.map((item) => item.slug)).toEqual(["stored-imprint"]);
    expect(page.total).toBe(1);
    // The tile's two displayed values ARE the two columns.
    expect(page.items[0]).toMatchObject({ certified: true, trackCount: FLOOR });
  });

  it("ALBUMS: same, on the album table's own pair", async () => {
    const page = await listAlbumsHubPage(1);

    expect(page.items.map((item) => item.slug)).toEqual(["stored-record"]);
    expect(page.items[0]).toMatchObject({ certified: true, trackCount: FLOOR });
  });

  it("ARTISTS: same, with no `track_artists` walk left to reach the edged artist", async () => {
    const page = await listArtistsHubPage(1);

    expect(page.items.map((item) => item.slug)).toEqual(["stored-artist"]);
    expect(page.items[0]).toMatchObject({ certified: true, trackCount: FLOOR });
  });

  it("carries the A–Z lane off the same gated set", async () => {
    const page = await listLabelsHubPage(1);

    expect(page.letters).toEqual([{ letter: "s", page: 1 }]);
  });

  it("narrows by the name filter without widening the gate", async () => {
    // The uncounted label matches the needle by name and is still out — the `or` inside the gate
    // cannot escape the filter's `and`.
    expect((await listLabelsHubPage(1, "imprint")).items.map((item) => item.slug)).toEqual([
      "stored-imprint",
    ]);
    expect((await listLabelsHubPage(1, "uncounted")).total).toBe(0);
  });
});

describe("the MCP browse + the API list ops read the same two columns", () => {
  it("browses exactly the hub's set, all three kinds", async () => {
    expect((await listLabelsBrowsePage(1)).items).toEqual([
      { certified: true, name: "Stored Imprint", slug: "stored-imprint", trackCount: FLOOR },
    ]);
    expect((await listAlbumsBrowsePage(1)).items.map((item) => item.slug)).toEqual([
      "stored-record",
    ]);
    expect((await listArtistsBrowsePage(1)).items.map((item) => item.slug)).toEqual([
      "stored-artist",
    ]);
  });

  it("stamps `findingCount` off `certified_finding_count`", async () => {
    expect(await listLabelsApiPage(1)).toMatchObject({
      items: [{ certified: true, findingCount: 1, slug: "stored-imprint", trackCount: FLOOR }],
      total: 1,
    });
    expect((await listAlbumsApiPage(1)).items[0]).toMatchObject({ findingCount: 1 });
    expect((await listArtistsApiPage(1)).items[0]).toMatchObject({ findingCount: 1 });
  });

  it("GET stays wider than the list and reports both columns verbatim", async () => {
    // The edged-but-uncounted entity has no place in the index, yet its page resolves — and its
    // counts read 0/0, because the columns say so.
    expect(await getLabelDetail("uncounted-imprint")).toMatchObject({
      certified: false,
      findingCount: 0,
      trackCount: 0,
    });
    expect(await getAlbumDetail("stored-record")).toMatchObject({
      certified: true,
      findingCount: 1,
      trackCount: FLOOR,
    });
    expect(await getArtistListItemBySlug("stored-artist")).toMatchObject({
      certified: true,
      findingCount: 1,
      trackCount: FLOOR,
    });
  });
});

describe("search's entity gate reads the stored counters", () => {
  it("offers the counted-but-edgeless label and declines the edged-but-uncounted one", async () => {
    const stored = await searchArchive({ q: "Stored Imprint" });

    expect(stored.entities).toEqual([
      { kind: "label", name: "Stored Imprint", slug: "stored-imprint" },
    ]);

    // Below the gate: the name resolves nothing to jump to, so search falls back to the filter it
    // always was — never a dead link.
    expect((await searchArchive({ q: "Uncounted Imprint" })).entities).toEqual([]);
  });

  it("gates albums the same way", async () => {
    expect((await searchArchive({ q: "Stored Record" })).entities).toEqual([
      { kind: "album", name: "Stored Record", slug: "stored-record" },
    ]);
    expect((await searchArchive({ q: "Uncounted Record" })).entities).toEqual([]);
  });
});

describe("the bio worklists read the stored counters", () => {
  it("queues the counted entity of each kind and never the uncounted one", async () => {
    expect((await listLabelsMissingBio(50)).map((item) => item.slug)).toEqual(["stored-imprint"]);
    expect((await listAlbumsMissingBio(50)).map((item) => item.slug)).toEqual(["stored-record"]);
    expect((await listArtistsMissingBio(50)).map((item) => item.slug)).toEqual(["stored-artist"]);
  });

  it("admits a CERTIFIED entity that is below the renderable floor (the disjunction's first arm)", async () => {
    await seedEntity("labels", {
      certified: 1,
      id: "L_thin",
      name: "Thin Certified",
      renderable: 1,
      slug: "thin-certified",
    });

    expect((await listLabelsMissingBio(50)).map((item) => item.slug)).toEqual([
      "stored-imprint",
      "thin-certified",
    ]);
  });
});

describe("the indexable count reads the stored renderable column alone", () => {
  it("counts the counted entity of each kind, not the edged one", async () => {
    expect(await countIndexableLabels()).toBe(1);
    expect(await countIndexableAlbums()).toBe(1);
    expect(await countIndexableArtists()).toBe(1);
  });

  it("applies `renderable >= floor` ALONE — a sub-floor CERTIFIED entity is NOT indexable", async () => {
    // The browsable index admits it (the gate's first arm); the sitemap's narrower floor does not.
    await seedEntity("labels", {
      certified: 1,
      id: "L_thin",
      name: "Thin Certified",
      renderable: 1,
      slug: "thin-certified",
    });

    expect((await listLabelsHubPage(1)).total).toBe(2);
    expect(await countIndexableLabels()).toBe(1);
  });
});

describe("the sitemap row readers gate on the column and keep the join for lastmod", () => {
  beforeEach(async () => {
    // Give the EDGED entities their honest counters, so they clear the floor on both halves and the
    // join has rows to fold. The counted-but-edgeless entities keep their zero edges.
    for (const table of ["albums", "artists", "labels"] as const) {
      await db.execute(`update ${table} set renderable_track_count = ${FLOOR}`);
    }
  });

  it("emits a row for the entity whose column clears the floor AND whose edges exist", async () => {
    // Both halves now read `renderable = 3`, and only the edged entity has tracks to join — so the
    // gate admits both while the join yields exactly one row per kind.
    expect((await listLabelSitemapRows(FLOOR)).map((row) => row.slug)).toEqual([
      "uncounted-imprint",
    ]);
    expect((await listAlbumSitemapRows(FLOOR)).map((row) => row.slug)).toEqual([
      "uncounted-record",
    ]);
    expect((await listArtistSitemapRows(FLOOR)).map((row) => row.slug)).toEqual([
      "uncounted-artist",
    ]);
  });

  it("drops the entity again the moment its stored column falls under the floor", async () => {
    for (const table of ["albums", "artists", "labels"] as const) {
      await db.execute(`update ${table} set renderable_track_count = ${FLOOR - 1}`);
    }

    expect(await listLabelSitemapRows(FLOOR)).toEqual([]);
    expect(await listAlbumSitemapRows(FLOOR)).toEqual([]);
    expect(await listArtistSitemapRows(FLOOR)).toEqual([]);
  });

  it("carries no lastmod for a findings-free entity (catalogue rows have no found date)", async () => {
    expect((await listLabelSitemapRows(FLOOR))[0]?.lastmod).toBeUndefined();
  });
});

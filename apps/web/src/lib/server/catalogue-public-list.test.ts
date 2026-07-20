// The public catalogue LIST/GET API reads — `list_albums`/`get_album`, `list_labels`/`get_label`,
// and the catalogue-scoped `list_artists`/`get_artist` — proven against the REAL migrated schema on
// an in-memory libSQL engine (the labels.test.ts harness). The load-bearing guarantees:
//
//   1. SAME INDEX AS THE WEB HUB: the API list is built on the shared `listHubPage` gate
//      (`HUB_INCLUSION_HAVING` — a certified entity is always in, an uncertified one only above the
//      renderable floor), so it serves EXACTLY the set the `/albums` //labels //artists web pages
//      and the MCP browse do. A behavioural set-equality test pins that for all three readers: the
//      API list's (slug, certified) set + total equals the web hub's, by construction.
//   2. GET IS WIDER THAN THE LIST: a below-floor entity the list omits still RESOLVES from get (it
//      renders on its `/entity/<slug>` page, just noindex).
//   3. HONEST COUNTS: `trackCount` is the renderable count (findings + findings-free tracks) the hub
//      gate uses; `findingCount` is the certified-finding count; `certified` is `findingCount > 0`.
//   4. A slug that names no entity resolves to `undefined` (the handler turns that into a 404).

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { getAlbumDetail, listAlbumsApiPage, listAlbumsHubPage } from "./albums";
import { getArtistListItemBySlug, listArtistsApiPage, listArtistsHubPage } from "./artists";
import { createIntegrationDb } from "./integration-db";
import { getLabelDetail, listLabelsApiPage, listLabelsHubPage } from "./labels";

let db: Client;

async function seedLabel(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "x", "x"],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function seedAlbum(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "x", "x"],
    sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function seedArtist(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "x", "x"],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

/** A track pointed at an album + label + credited to an artist, optionally certified (a finding). */
async function seedTrack(options: {
  albumId: string;
  artistId: string;
  labelId: string;
  logId?: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      '["Artist"]',
      options.albumId,
      options.labelId,
    ],
    sql: `insert into tracks (track_id, title, artists_json, album_id, label_id, duration_ms)
          values (?, ?, ?, ?, ?, 0)`,
  });
  await db.execute({
    args: [options.trackId, options.artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });

  if (options.logId) {
    await db.execute({
      args: [options.trackId, options.logId],
      sql: `insert into findings (track_id, log_id, added_at) values (?, ?, '2020-01-01T00:00:00.000Z')`,
    });
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  // ONE coherent world drives all three entity kinds (slugs chosen so A–Z is unambiguous):
  //   - a CERTIFIED entity (1 finding): always in the list.
  //   - a DEEP catalogue entity (3 crawled tracks, no finding): renderable 3 ≥ floor → in the list.
  //   - a THIN catalogue entity (1 crawled track): renderable 1 < floor → OUT of the list, but get
  //     still resolves it.
  await seedLabel("L_aurora", "Aurora Rec", "aurora-rec");
  await seedLabel("L_zephyr", "Zephyr Trax", "zephyr-trax");
  await seedLabel("L_tiny", "Tiny Imprint", "tiny-imprint");
  await seedAlbum("A_alpha", "Alpha LP", "alpha-lp");
  await seedAlbum("A_zeta", "Zeta EP", "zeta-ep");
  await seedAlbum("A_solo", "Solo Single", "solo-single");
  await seedArtist("R_ada", "Ada", "ada");
  await seedArtist("R_zed", "Zed", "zed");
  await seedArtist("R_uno", "Uno", "uno");

  // t1 certifies the "aurora / alpha / ada" triple.
  await seedTrack({
    albumId: "A_alpha",
    artistId: "R_ada",
    labelId: "L_aurora",
    logId: "100.1.1A",
    trackId: "t1",
  });
  // t2..t4 give the "zephyr / zeta / zed" triple a renderable 3 (deep catalogue, uncertified).
  for (const trackId of ["t2", "t3", "t4"]) {
    await seedTrack({ albumId: "A_zeta", artistId: "R_zed", labelId: "L_zephyr", trackId });
  }
  // t5 is the thin "tiny / solo / uno" triple (renderable 1 — below floor).
  await seedTrack({ albumId: "A_solo", artistId: "R_uno", labelId: "L_tiny", trackId: "t5" });
});

/** The (slug, certified) fingerprint of a page — what set-equality compares. */
function fingerprint(items: { certified: boolean; slug: string }[]): string[] {
  return items.map((item) => `${item.slug}:${item.certified}`).sort();
}

describe("listLabelsApiPage / getLabelDetail", () => {
  it("serves the unified index — certified + deep catalogue in, thin out — with honest counts", async () => {
    const { items, total } = await listLabelsApiPage(1);

    expect(total).toBe(2);
    expect(items.map((label) => label.slug)).toEqual(["aurora-rec", "zephyr-trax"]);
    expect(items.find((label) => label.slug === "aurora-rec")).toMatchObject({
      certified: true,
      findingCount: 1,
      trackCount: 1,
    });
    expect(items.find((label) => label.slug === "zephyr-trax")).toMatchObject({
      certified: false,
      findingCount: 0,
      trackCount: 3,
    });
  });

  it("matches the web hub's (slug, certified) set + total exactly (same gate)", async () => {
    const api = await listLabelsApiPage(1);
    const hub = await listLabelsHubPage(1);

    expect(fingerprint(api.items)).toEqual(fingerprint(hub.items));
    expect(api.total).toBe(hub.total);
  });

  it("get resolves ANY label with a page — a below-floor label the list omits — and 404s an unknown slug", async () => {
    expect(await getLabelDetail("tiny-imprint")).toMatchObject({
      certified: false,
      findingCount: 0,
      name: "Tiny Imprint",
      trackCount: 1,
    });
    expect(await getLabelDetail("aurora-rec")).toMatchObject({ certified: true, findingCount: 1 });
    expect(await getLabelDetail("nope")).toBeUndefined();
  });
});

describe("listAlbumsApiPage / getAlbumDetail", () => {
  it("serves the unified index with honest counts", async () => {
    const { items, total } = await listAlbumsApiPage(1);

    expect(total).toBe(2);
    expect(items.map((album) => album.slug)).toEqual(["alpha-lp", "zeta-ep"]);
    expect(items.find((album) => album.slug === "alpha-lp")).toMatchObject({
      certified: true,
      findingCount: 1,
      trackCount: 1,
    });
    expect(items.find((album) => album.slug === "zeta-ep")).toMatchObject({
      certified: false,
      findingCount: 0,
      trackCount: 3,
    });
  });

  it("matches the web hub's (slug, certified) set + total exactly (same gate)", async () => {
    const api = await listAlbumsApiPage(1);
    const hub = await listAlbumsHubPage(1);

    expect(fingerprint(api.items)).toEqual(fingerprint(hub.items));
    expect(api.total).toBe(hub.total);
  });

  it("get resolves a below-floor album and 404s an unknown slug", async () => {
    expect(await getAlbumDetail("solo-single")).toMatchObject({
      certified: false,
      name: "Solo Single",
      trackCount: 1,
    });
    expect(await getAlbumDetail("nope")).toBeUndefined();
  });
});

describe("listArtistsApiPage / getArtistListItemBySlug", () => {
  it("serves the unified index — a findings-free deep artist alongside a certified one", async () => {
    const { items, total } = await listArtistsApiPage(1);

    expect(total).toBe(2);
    expect(items.map((artist) => artist.slug)).toEqual(["ada", "zed"]);
    expect(items.find((artist) => artist.slug === "ada")).toMatchObject({
      certified: true,
      findingCount: 1,
      trackCount: 1,
    });
    expect(items.find((artist) => artist.slug === "zed")).toMatchObject({
      certified: false,
      findingCount: 0,
      trackCount: 3,
    });
  });

  it("matches the web hub's (slug, certified) set + total exactly (same gate)", async () => {
    const api = await listArtistsApiPage(1);
    const hub = await listArtistsHubPage(1);

    expect(fingerprint(api.items)).toEqual(fingerprint(hub.items));
    expect(api.total).toBe(hub.total);
  });

  it("get resolves a below-floor (thin) artist the list omits, and 404s an unknown slug", async () => {
    const uno = await getArtistListItemBySlug("uno");

    expect(uno).toMatchObject({ certified: false, findingCount: 0, name: "Uno", trackCount: 1 });
    expect(await getArtistListItemBySlug("nope")).toBeUndefined();
  });
});

// The hub NAME FILTER (`?q=` on /artists //albums //labels) — applied SQL-side inside the ONE gated
// CTE, so the shared `HUB_INCLUSION_HAVING` gate is untouched: a name match is a NARROWING of the
// same floor-clearing set, never a widening of it. Proven against the real schema, same seeded world.
describe("listHubPage — the name filter (?q=)", () => {
  it("narrows the labels hub to a substring match, case-insensitively", async () => {
    const aurora = await listLabelsHubPage(1, "aurora");
    expect(aurora.items.map((label) => label.slug)).toEqual(["aurora-rec"]);
    expect(aurora.total).toBe(1);

    // A substring anywhere in the name matches (not just a prefix), and the match ignores case.
    expect((await listLabelsHubPage(1, "trax")).items.map((l) => l.slug)).toEqual(["zephyr-trax"]);
    expect((await listLabelsHubPage(1, "AURORA")).items.map((l) => l.slug)).toEqual(["aurora-rec"]);
  });

  it("stays gate-consistent: a name match on a below-floor (thin) entity is still excluded", async () => {
    // "Tiny Imprint" matches by name but its page is below the renderable floor — the gate keeps it
    // out with OR without the filter, so the filtered result is empty (never a widening).
    expect((await listLabelsHubPage(1, "tiny")).total).toBe(0);
    expect((await listArtistsHubPage(1, "uno")).total).toBe(0);
  });

  it("keeps the filtered set a SUBSET of the unfiltered gated set (never a new row)", async () => {
    const unfiltered = new Set((await listLabelsHubPage(1)).items.map((label) => label.slug));

    // A single-letter filter that matches every in-set label still yields only rows the bare hub has.
    for (const label of (await listLabelsHubPage(1, "r")).items) {
      expect(unfiltered.has(label.slug)).toBe(true);
    }
  });

  it("drops the A–Z lane while filtering (the letter arm is skipped — a name search is not a browse)", async () => {
    // The unfiltered hub carries a populated lane; the filtered one carries none (withLetters is off,
    // so the letter arm never runs and the lane comes back empty — the route hides it either way).
    expect((await listLabelsHubPage(1)).letters?.length).toBeGreaterThan(0);
    expect((await listLabelsHubPage(1, "aurora")).letters).toEqual([]);
    expect((await listArtistsHubPage(1, "ada")).letters).toEqual([]);
  });

  it("filters the artists + albums hubs the same way", async () => {
    expect((await listArtistsHubPage(1, "ada")).items.map((a) => a.slug)).toEqual(["ada"]);
    expect((await listAlbumsHubPage(1, "alpha")).items.map((a) => a.slug)).toEqual(["alpha-lp"]);
  });
});

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { getAlbumDetail, listAlbumsApiPage, listAlbumsHubPage } from "./albums";
import { getArtistListItemBySlug, listArtistsApiPage, listArtistsHubPage } from "./artists";
import { createIntegrationDb, syncHubCounts } from "./integration-db";
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

    await db.execute({
      args: [options.trackId],
      sql: `update tracks set is_catalogue = 0 where track_id = ?`,
    });
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  await seedLabel("L_aurora", "Aurora Rec", "aurora-rec");
  await seedLabel("L_zephyr", "Zephyr Trax", "zephyr-trax");
  await seedLabel("L_tiny", "Tiny Imprint", "tiny-imprint");
  await seedAlbum("A_alpha", "Alpha LP", "alpha-lp");
  await seedAlbum("A_zeta", "Zeta EP", "zeta-ep");
  await seedAlbum("A_solo", "Solo Single", "solo-single");
  await seedArtist("R_ada", "Ada", "ada");
  await seedArtist("R_zed", "Zed", "zed");
  await seedArtist("R_uno", "Uno", "uno");

  await seedTrack({
    albumId: "A_alpha",
    artistId: "R_ada",
    labelId: "L_aurora",
    logId: "100.1.1A",
    trackId: "t1",
  });

  for (const trackId of ["t2", "t3", "t4"]) {
    await seedTrack({ albumId: "A_zeta", artistId: "R_zed", labelId: "L_zephyr", trackId });
  }

  await seedTrack({ albumId: "A_solo", artistId: "R_uno", labelId: "L_tiny", trackId: "t5" });

  await syncHubCounts(db);
});

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

describe("listHubPage — the name filter (?q=)", () => {
  it("narrows the labels hub to a substring match, case-insensitively", async () => {
    const aurora = await listLabelsHubPage(1, "aurora");
    expect(aurora.items.map((label) => label.slug)).toEqual(["aurora-rec"]);
    expect(aurora.total).toBe(1);

    expect((await listLabelsHubPage(1, "trax")).items.map((l) => l.slug)).toEqual(["zephyr-trax"]);
    expect((await listLabelsHubPage(1, "AURORA")).items.map((l) => l.slug)).toEqual(["aurora-rec"]);
  });

  it("stays gate-consistent: a name match on a below-floor (thin) entity is still excluded", async () => {
    expect((await listLabelsHubPage(1, "tiny")).total).toBe(0);
    expect((await listArtistsHubPage(1, "uno")).total).toBe(0);
  });

  it("keeps the filtered set a SUBSET of the unfiltered gated set (never a new row)", async () => {
    const unfiltered = new Set((await listLabelsHubPage(1)).items.map((label) => label.slug));

    for (const label of (await listLabelsHubPage(1, "r")).items) {
      expect(unfiltered.has(label.slug)).toBe(true);
    }
  });

  it("drops the A–Z lane while filtering (the letter arm is skipped — a name search is not a browse)", async () => {
    expect((await listLabelsHubPage(1)).letters?.length).toBeGreaterThan(0);
    expect((await listLabelsHubPage(1, "aurora")).letters).toEqual([]);
    expect((await listArtistsHubPage(1, "ada")).letters).toEqual([]);
  });

  it("filters the artists + albums hubs the same way", async () => {
    expect((await listArtistsHubPage(1, "ada")).items.map((a) => a.slug)).toEqual(["ada"]);
    expect((await listAlbumsHubPage(1, "alpha")).items.map((a) => a.slug)).toEqual(["alpha-lp"]);
  });
});

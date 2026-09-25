import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillAlbums } from "../../../scripts/backfill-album-graph";
import { backfillLabels } from "../../../scripts/backfill-labels";
import {
  ALBUM_INDEX_MIN_TRACKS,
  albumSlug,
  ensureAlbum,
  getAlbumBySlug,
  linkTrackToAlbum,
  listAlbumsHubPage,
  listAlbumsMissingBio,
  listAlbumSitemapRows,
} from "./albums";
import { listArtistsHubPage, listArtistsMissingBio, upsertTrackArtists } from "./artists";
import { flattenArtistGroups, listLabelCatalogue } from "./catalogue-groups";
import { readClientProperty } from "./db";
import { createIntegrationDb, syncHubCounts } from "./integration-db";
import { getGraphPreview } from "./graph-preview";
import {
  getLabelBySlug,
  getLabelForAlbum,
  linkTrackToLabel,
  listLabelsHubPage,
  listLabelsMissingBio,
} from "./labels";
import { getFindingsByAlbum, getFindingsByLabel, listCatalogueTracksByAlbum } from "./tracks";

let db: Client;

async function seedTrack(options: {
  album: null | string;
  dismissedAt?: string;
  duplicateOfTrackId?: string;
  isrc?: string;
  label: null | string;
  logId?: string;
  spotifyUrl?: null | string;
  title: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      options.title,
      '["Artist"]',
      options.album,
      options.label,
      options.spotifyUrl === undefined ? "https://open.spotify.com/track/x" : options.spotifyUrl,
      options.isrc ?? null,
      options.duplicateOfTrackId ?? null,
      options.dismissedAt ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, duration_ms, album, label,
             spotify_url, isrc, duplicate_of_track_id, dismissed_at)
          values (?, ?, ?, 'uri', 0, ?, ?, ?, ?, ?, ?)`,
  });

  if (options.logId) {
    await db.execute({
      args: [options.trackId, options.logId, "2026-07-01T00:00:00.000Z"],
      sql: `insert into findings
              (track_id, log_id, added_at, added_to_spotify, posted_to_telegram)
            values (?, ?, ?, 0, 0)`,
    });

    await db.execute({
      args: [options.trackId],
      sql: `update tracks set is_catalogue = 0 where track_id = ?`,
    });
  }
}

async function reconcile(): Promise<void> {
  await backfillLabels(db);
  await backfillAlbums(db);
  await syncHubCounts(db);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("albumSlug (the identity + the join key)", () => {
  it("folds spelling variants of the same record onto one slug", () => {
    expect(albumSlug("Wormhole")).toBe("wormhole");
    expect(albumSlug("  Wormhole ")).toBe("wormhole");
    expect(albumSlug("Chapter One.")).toBe("chapter-one");
  });

  it("mints nothing from a blank or all-punctuation album name", () => {
    expect(albumSlug("")).toBeUndefined();
    expect(albumSlug("   ")).toBeUndefined();
    expect(albumSlug("...")).toBeUndefined();
    expect(albumSlug(null)).toBeUndefined();
    expect(albumSlug(undefined)).toBeUndefined();
  });
});

describe("ensureAlbum (the publish path's upsert)", () => {
  it("mints a row and returns its id, idempotently", async () => {
    const first = await ensureAlbum("Wormhole");
    const second = await ensureAlbum("Wormhole");

    expect(first).toBeDefined();
    expect(second).toBe(first);

    const rows = await db.execute(`select count(*) as n from albums`);

    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("keeps the first spelling as the display name when a variant folds in later", async () => {
    await ensureAlbum("Wormhole");
    await ensureAlbum("  wormhole  ");

    const album = await getAlbumBySlug("wormhole");

    expect(album?.name).toBe("Wormhole");
  });

  it("mints nothing from a blank album", async () => {
    expect(await ensureAlbum(null)).toBeUndefined();
    expect(await ensureAlbum("  ")).toBeUndefined();

    const rows = await db.execute(`select count(*) as n from albums`);

    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});

describe("ensureAlbum — the release-group MBID fold (the catalogue inline path)", () => {
  const RG_MBID = "b1d19fbd-0840-3b90-ba0c-64832ba9838d";

  it("folds two pressings of ONE release group onto a single album row", async () => {
    const first = await ensureAlbum("Wormhole", RG_MBID);

    const second = await ensureAlbum("Wormhole (Remastered)", RG_MBID);

    expect(second).toBe(first);

    const rows = await db.execute(`select count(*) as n from albums`);
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("stores the mbid on a freshly minted row", async () => {
    await ensureAlbum("Wormhole", RG_MBID);

    const row = await db.execute(`select release_group_mbid from albums where slug = 'wormhole'`);
    expect(row.rows[0]?.release_group_mbid).toBe(RG_MBID);
  });

  it("ADOPTS the mbid onto a finding-minted album that had none, then folds on it", async () => {
    const bySlug = await ensureAlbum("Wormhole");

    const byMbid = await ensureAlbum("Wormhole", RG_MBID);
    expect(byMbid).toBe(bySlug);

    const row = await db.execute(`select release_group_mbid from albums where slug = 'wormhole'`);
    expect(row.rows[0]?.release_group_mbid).toBe(RG_MBID);

    const third = await ensureAlbum("Wormhole (Deluxe)", RG_MBID);
    expect(third).toBe(bySlug);

    const count = await db.execute(`select count(*) as n from albums`);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it("FALLBACK: with no mbid, folds by slug and leaves the fold key NULL", async () => {
    const first = await ensureAlbum("Wormhole", null);
    const second = await ensureAlbum("Wormhole");
    expect(second).toBe(first);

    const row = await db.execute(`select release_group_mbid from albums where slug = 'wormhole'`);
    expect(row.rows[0]?.release_group_mbid).toBeNull();
  });
});

describe("linkTrackToAlbum (the pointer the pages read by)", () => {
  it("stamps tracks.album_id at the minted album", async () => {
    await seedTrack({
      album: "Wormhole",
      label: null,
      logId: "001.1.1A",
      title: "Tune",
      trackId: "t1",
    });
    await linkTrackToAlbum("t1", "Wormhole");

    const album = await getAlbumBySlug("wormhole");
    const row = await db.execute(`select album_id from tracks where track_id = 't1'`);

    expect(row.rows[0]?.album_id).toBe(album?.id);
  });
});

describe("the reconcile (scripts/backfill-album-graph.ts + backfill-labels.ts)", () => {
  it("mints an entity only for an album/label a CERTIFIED finding carries", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Certified",
      trackId: "t1",
    });

    await seedTrack({
      album: "Some Other Record",
      label: "Some Other Imprint",
      title: "Uncertified",
      trackId: "t2",
    });

    await reconcile();

    expect(await getAlbumBySlug("wormhole")).toBeDefined();
    expect(await getAlbumBySlug("some-other-record")).toBeUndefined();
    expect(await getLabelBySlug("hospital-records")).toBeDefined();
    expect(await getLabelBySlug("some-other-imprint")).toBeUndefined();
  });

  it("links an UNCERTIFIED track to an entity that already exists (the quieter rows)", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Certified",
      trackId: "t1",
    });

    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      title: "Deep cut",
      trackId: "t2",
    });
    await reconcile();

    const album = await getAlbumBySlug("wormhole");
    const label = await getLabelBySlug("hospital-records");
    const linked = await db.execute(`select album_id, label_id from tracks where track_id = 't2'`);

    expect(linked.rows[0]?.album_id).toBe(album?.id);
    expect(linked.rows[0]?.label_id).toBe(label?.id);
  });

  it("is idempotent — a second run mints nothing and links nothing", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Certified",
      trackId: "t1",
    });

    await reconcile();
    const second = await backfillAlbums(db);
    const secondLabels = await backfillLabels(db);

    expect(second).toEqual({ linked: 0, minted: 0 });
    expect(secondLabels.minted).toBe(0);
    expect(secondLabels.linked).toBe(0);
  });
});

describe("the deploy-time bulk stamps credit the maintained hub counters", () => {
  async function counts(
    table: "albums" | "labels",
    slug: string,
  ): Promise<{ certified: number; renderable: number }> {
    const result = await db.execute({
      args: [slug],
      sql: `select renderable_track_count as renderable, certified_finding_count as certified
            from ${table} where slug = ?`,
    });
    const row = result.rows[0];

    return { certified: Number(row?.certified ?? -1), renderable: Number(row?.renderable ?? -1) };
  }

  type BatchCall = { mode: unknown; statements: { args?: unknown; sql?: string }[] };

  function recording(calls: BatchCall[]): Client {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (
            statements: Parameters<Client["batch"]>[0],
            mode?: Parameters<Client["batch"]>[1],
          ) => {
            calls.push({ mode, statements: [...statements] as BatchCall["statements"] });

            return target.batch(statements, mode);
          };
        }

        return readClientProperty(target, prop);
      },
    });
  }

  it("LABELS: credits the stamped set — every linked track, and the certified subset", async () => {
    await seedTrack({
      album: null,
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "hc-lbl-1",
    });
    await seedTrack({ album: null, label: "Hospital Records", title: "Deep", trackId: "hc-lbl-2" });
    await seedTrack({ album: null, label: "Hospital Records", title: "Cut", trackId: "hc-lbl-3" });

    await seedTrack({
      album: null,
      label: "Metalheadz",
      logId: "001.1.2A",
      title: "Other",
      trackId: "hc-lbl-4",
    });

    await backfillLabels(db);

    expect(await counts("labels", "hospital-records")).toEqual({ certified: 1, renderable: 3 });
    expect(await counts("labels", "metalheadz")).toEqual({ certified: 1, renderable: 1 });
  });

  it("ALBUMS: credits the stamped set — every linked track, and the certified subset", async () => {
    await seedTrack({
      album: "Wormhole",
      label: null,
      logId: "001.1.1A",
      title: "Cert",
      trackId: "hc-alb-1",
    });
    await seedTrack({ album: "Wormhole", label: null, title: "Deep", trackId: "hc-alb-2" });
    await seedTrack({ album: "Wormhole", label: null, title: "Cut", trackId: "hc-alb-3" });

    await backfillAlbums(db);

    expect(await counts("albums", "wormhole")).toEqual({ certified: 1, renderable: 3 });
  });

  it("credits ONCE when two spellings trim to the same string — the zero-row census skips", async () => {
    await seedTrack({
      album: null,
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "hc-trim-1",
    });
    await seedTrack({
      album: null,
      label: "  Hospital Records  ",
      title: "Deep",
      trackId: "hc-trim-2",
    });

    await backfillLabels(db);

    expect(await counts("labels", "hospital-records")).toEqual({ certified: 1, renderable: 2 });
  });

  it("does not re-credit on a second deploy — the steady state moves nothing", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "hc-idem-1",
    });
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      title: "Deep",
      trackId: "hc-idem-2",
    });

    await backfillLabels(db);
    await backfillAlbums(db);

    await backfillLabels(db);
    await backfillAlbums(db);

    expect(await counts("labels", "hospital-records")).toEqual({ certified: 1, renderable: 2 });
    expect(await counts("albums", "wormhole")).toEqual({ certified: 1, renderable: 2 });
  });

  it("rides ONE write batch — the stamp and the credit can never half-apply", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "hc-atomic-1",
    });

    const labelCalls: BatchCall[] = [];
    const albumCalls: BatchCall[] = [];

    await backfillLabels(recording(labelCalls));
    await backfillAlbums(recording(albumCalls));

    for (const [calls, table, foreignKey] of [
      [labelCalls, "labels", "label_id"],
      [albumCalls, "albums", "album_id"],
    ] as const) {
      const linkCalls = calls.filter((call) =>
        call.statements.some((statement) =>
          statement.sql?.includes(`update tracks set ${foreignKey} = ?`),
        ),
      );
      expect(linkCalls).toHaveLength(1);

      const call = linkCalls[0];
      const targetsArtistQualification = foreignKey === "label_id";

      expect(call?.mode).toBe("write");
      expect(call?.statements).toHaveLength(targetsArtistQualification ? 5 : 3);

      expect(call?.statements[0]?.sql).toContain("insert into due_work");
      expect(
        call?.statements.some(
          (statement) => statement.sql?.includes("projection_repairs") === true,
        ),
      ).toBe(targetsArtistQualification);
      expect(call?.statements.at(-2)?.sql).toContain(`update tracks set ${foreignKey} = ?`);
      expect(call?.statements.at(-1)?.sql).toContain(`update ${table}`);
      expect(call?.statements.at(-1)?.sql).toContain("renderable_track_count");
      expect(call?.statements.at(-1)?.sql).toContain("certified_finding_count");

      expect(call?.statements.at(-1)?.args).toEqual([1, 1, expect.any(String)]);
    }
  });
});

describe("the finding reads vs the anti-join (the safety property)", () => {
  beforeEach(async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Certified",
      trackId: "t1",
    });
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      title: "Deep cut",
      trackId: "t2",
    });
    await db.execute({
      args: ["t2"],
      sql: `update tracks set album_image_url = 'https://i.scdn.co/image/cover',
             duration_ms = 201000, bpm = 172, key = 'C minor', isrc = 'GBTEST2600003',
             release_date = '2026-04-02' where track_id = ?`,
    });
    await reconcile();
  });

  it("returns ONLY certified tracks from the finding reads", async () => {
    const album = await getAlbumBySlug("wormhole");
    const label = await getLabelBySlug("hospital-records");

    if (!album || !label) {
      throw new Error("entities missing");
    }

    const byAlbum = await getFindingsByAlbum(album.id);
    const byLabel = await getFindingsByLabel(label.id);

    expect(byAlbum.map((finding) => finding.trackId)).toEqual(["t1"]);
    expect(byLabel.map((finding) => finding.trackId)).toEqual(["t1"]);
    expect(byAlbum[0]?.logId).toBe("001.1.1A");
  });

  it("returns ONLY uncertified tracks from the anti-join, and gives them no coordinate", async () => {
    const album = await getAlbumBySlug("wormhole");
    const label = await getLabelBySlug("hospital-records");

    if (!album || !label) {
      throw new Error("entities missing");
    }

    const albumCatalogue = await listCatalogueTracksByAlbum(album.id);
    const labelCatalogue = await listLabelCatalogue(label.id, "name", 1);
    const labelTracks = flattenArtistGroups(labelCatalogue.groups);

    expect(albumCatalogue.tracks.map((track) => track.trackId)).toEqual(["t2"]);
    expect(labelTracks.map((track) => track.trackId)).toEqual(["t2"]);

    expect(albumCatalogue.total).toBe(1);
    expect(labelCatalogue.totalTracks).toBe(1);

    expect(albumCatalogue.tracks[0]).not.toHaveProperty("logId");
    expect(albumCatalogue.tracks[0]?.spotifyUrl).toContain("open.spotify.com");
    expect(albumCatalogue.tracks[0]).toMatchObject({
      albumImageUrl: expect.any(String),
      bpm: 172,
      durationMs: 201000,
      key: "C minor",
      previewable: true,
      releaseDate: "2026-04-02",
    });
    expect(labelTracks[0]).not.toHaveProperty("logId");
  });

  it("carries a certified entity into the unified index, lit, with the renderable track count", async () => {
    const albums = await listAlbumsHubPage(1);
    const labels = await listLabelsHubPage(1);

    expect(albums.items[0]).toMatchObject({
      certified: true,
      name: "Wormhole",
      slug: "wormhole",
      trackCount: 2,
    });
    expect(labels.items[0]).toMatchObject({
      certified: true,
      name: "Hospital Records",
      trackCount: 2,
    });
    expect(albums.total).toBe(1);
    expect(labels.total).toBe(1);
  });

  it("resolves the album → label edge that closes the graph", async () => {
    const album = await getAlbumBySlug("wormhole");

    if (!album) {
      throw new Error("album missing");
    }

    expect(await getLabelForAlbum(album.id)).toMatchObject({
      name: "Hospital Records",
      slug: "hospital-records",
    });
  });
});

describe("the album page renders a recording once (the duplicate defence)", () => {
  beforeEach(async () => {
    await seedTrack({
      album: "Rudeboy",
      label: "Hospital Records",
      spotifyUrl: "https://open.spotify.com/track/anchored",
      title: "20 Man Down",
      trackId: "t_anchored",
    });
    await seedTrack({
      album: "Rudeboy",
      label: "Hospital Records",
      spotifyUrl: null,
      title: "20 Man Down",
      trackId: "t_bare",
    });

    await seedTrack({
      album: "Rudeboy",
      duplicateOfTrackId: "t_anchored",
      label: "Hospital Records",
      title: "Selecta",
      trackId: "t_stamped",
    });
    await seedTrack({
      album: "Rudeboy",
      dismissedAt: "2026-07-01T00:00:00.000Z",
      label: "Hospital Records",
      title: "On the Block",
      trackId: "t_dismissed",
    });

    await seedTrack({
      album: "Rudeboy",
      label: "Hospital Records",
      title: "Baddadan",
      trackId: "t_orig",
    });
    await seedTrack({
      album: "Rudeboy",
      label: "Hospital Records",
      title: "Baddadan (Kanine Remix)",
      trackId: "t_remix",
    });

    for (const trackId of [
      "t_anchored",
      "t_bare",
      "t_stamped",
      "t_dismissed",
      "t_orig",
      "t_remix",
    ]) {
      await linkTrackToAlbum(trackId, "Rudeboy");
    }
  });

  it("folds the twin, vetoes the stamped/dismissed rows, and counts only what renders", async () => {
    const album = await getAlbumBySlug("rudeboy");

    if (!album) {
      throw new Error("album missing");
    }

    const catalogue = await listCatalogueTracksByAlbum(album.id);
    const rendered = catalogue.tracks.map((track) => track.trackId);

    expect(rendered.sort()).toEqual(["t_anchored", "t_orig", "t_remix"]);

    expect(catalogue.total).toBe(3);
  });
});

describe("the graph hover-card preview carries the entity's bio", () => {
  it("includes a label's bio when one is authored, and omits it cleanly when not", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "Certified",
      trackId: "t1",
    });
    await reconcile();

    const withoutBio = await getGraphPreview("label", "hospital-records");
    expect(withoutBio.bio).toBeUndefined();

    expect(withoutBio.line).toBeUndefined();

    await db.execute({
      args: ["London's liquid drum and bass home since 1996.", "hospital-records"],
      sql: `update labels set bio = ? where slug = ?`,
    });

    const withBio = await getGraphPreview("label", "hospital-records");
    expect(withBio.bio).toBe("London's liquid drum and bass home since 1996.");
  });
});

describe("the album sitemap is catalogue-aware: a findings-free album with enough tracks is IN", () => {
  it("sitemaps a crawl-minted, findings-free album past the floor, alongside a certified one", async () => {
    await seedTrack({
      album: "Wormhole",
      label: null,
      logId: "001.1.1A",
      title: "A",
      trackId: "t1",
    });
    await seedTrack({ album: "Wormhole", label: null, title: "B", trackId: "t2" });
    await seedTrack({ album: "Wormhole", label: null, title: "C", trackId: "t3" });

    const catalogueAlbumId = await ensureAlbum("Dark Matter", "rg-dark-matter");
    await seedTrack({ album: "Dark Matter", label: null, title: "D", trackId: "t4" });
    await seedTrack({ album: "Dark Matter", label: null, title: "E", trackId: "t5" });
    await seedTrack({ album: "Dark Matter", label: null, title: "F", trackId: "t6" });
    await db.execute({
      args: [catalogueAlbumId ?? "", "t4", "t5", "t6"],
      sql: `update tracks set album_id = ? where track_id in (?, ?, ?)`,
    });

    await reconcile();

    const sitemap = await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS);
    expect(sitemap.map((row) => row.slug).sort()).toEqual(["dark-matter", "wormhole"]);
  });

  it("keeps a THIN findings-free album (1-2 tracks) OUT of the sitemap, though its page renders", async () => {
    const thinAlbumId = await ensureAlbum("Faint Signal", "rg-faint-signal");
    await seedTrack({ album: "Faint Signal", label: null, title: "One", trackId: "t7" });
    await db.execute({
      args: [thinAlbumId ?? "", "t7"],
      sql: `update tracks set album_id = ? where track_id = ?`,
    });

    await reconcile();

    expect(await getAlbumBySlug("faint-signal")).toBeDefined();

    const sitemap = await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS);
    expect(sitemap.map((row) => row.slug)).not.toContain("faint-signal");
  });
});

describe("the unified album index: certified + floor-clearing catalogue, one A–Z list", () => {
  it("lists a certified album (lit) and a floor-clearing catalogue album (unlit), alphabetically", async () => {
    await seedTrack({
      album: "Wormhole",
      label: null,
      logId: "001.1.1A",
      title: "A",
      trackId: "t1",
    });

    const deepId = await ensureAlbum("Deep Space", "rg-deep-space");
    for (const trackId of ["d1", "d2", "d3"]) {
      await seedTrack({ album: "Deep Space", label: null, title: trackId, trackId });
    }
    await db.execute({
      args: [deepId ?? "", "d1", "d2", "d3"],
      sql: `update tracks set album_id = ? where track_id in (?, ?, ?)`,
    });

    const faintId = await ensureAlbum("Faint", "rg-faint");
    await seedTrack({ album: "Faint", label: null, title: "one", trackId: "f1" });
    await db.execute({
      args: [faintId ?? "", "f1"],
      sql: `update tracks set album_id = ? where track_id = ?`,
    });

    await reconcile();

    const page = await listAlbumsHubPage(1);

    expect(page.items.map((album) => album.slug)).toEqual(["deep-space", "wormhole"]);
    expect(page.total).toBe(2);

    expect(page.items.map((album) => ({ certified: album.certified, slug: album.slug }))).toEqual([
      { certified: false, slug: "deep-space" },
      { certified: true, slug: "wormhole" },
    ]);

    expect(page.items.find((album) => album.slug === "deep-space")?.trackCount).toBe(3);
  });
});

describe("the unified hub ?page=N index", () => {
  async function seedCatalogueLabel(label: string, count: number): Promise<void> {
    for (let track = 0; track < count; track++) {
      const trackId = `${label}-${track}`;

      await seedTrack({ album: null, label, title: `T-${trackId}`, trackId });
      await linkTrackToLabel(trackId, label);
    }
  }

  it("LABELS: pages the findings-free set at the 48-tile window, disjoint, with an honest total", async () => {
    for (let label = 0; label < 49; label++) {
      await seedCatalogueLabel(`Imprint ${String(label).padStart(2, "0")}`, 3);
    }

    const one = await listLabelsHubPage(1);
    expect(one.items).toHaveLength(48);
    expect(one.page).toBe(1);
    expect(one.total).toBe(49);
    expect(one.pageCount).toBe(2);
    expect(one.items[0]?.slug).toBe("imprint-00");
    expect(one.items[0]?.trackCount).toBe(3);

    const two = await listLabelsHubPage(2);
    expect(two.items).toHaveLength(1);
    expect(two.page).toBe(2);
    expect(two.total).toBe(49);
    expect(two.pageCount).toBe(2);
    expect(two.items[0]?.slug).toBe("imprint-48");

    const onePage = new Set(one.items.map((entry) => entry.slug));
    expect(two.items.some((entry) => onePage.has(entry.slug))).toBe(false);

    expect(await listLabelsHubPage(3)).toMatchObject({
      items: [],
      page: 3,
      pageCount: 2,
      total: 49,
    });
  });

  it("LABELS: page 1 of an empty hub is a real empty page, not a throw", async () => {
    const page = await listLabelsHubPage(1);

    expect(page).toEqual({ items: [], letters: [], page: 1, pageCount: 1, total: 0 });
  });

  it("LABELS: the A–Z lane maps each present letter to its first page, folding digits into '#'", async () => {
    await seedCatalogueLabel("Alpha Imprint", 3);
    await seedCatalogueLabel("Bravo Imprint", 3);
    await seedCatalogueLabel("9 Imprint", 3);

    await seedCatalogueLabel("Thin Imprint", 2);

    const letters = (await listLabelsHubPage(1)).letters ?? [];

    expect(letters).toEqual(
      expect.arrayContaining([
        { letter: "#", page: 1 },
        { letter: "a", page: 1 },
        { letter: "b", page: 1 },
      ]),
    );
    expect(letters.map((entry) => entry.letter)).not.toContain("t");
  });

  it("ARTISTS: pages, and 404s past the end", async () => {
    for (const trackId of ["da-1", "da-2", "da-3"]) {
      await seedTrack({ album: null, label: null, title: trackId, trackId });
      await upsertTrackArtists(trackId, ["Deep Artist"], [], { fillImages: false });
    }

    const page = await listArtistsHubPage(1);
    expect(page.items.map((entry) => entry.name)).toEqual(["Deep Artist"]);
    expect(page.total).toBe(1);
    expect(page.pageCount).toBe(1);

    expect(page.letters).toEqual([{ letter: "d", page: 1 }]);

    const past = await listArtistsHubPage(2);
    expect(past).toMatchObject({ items: [], page: 2, pageCount: 1, total: 1 });
  });

  it("ALBUMS: pages, and 404s past the end", async () => {
    for (const trackId of ["dr-1", "dr-2", "dr-3"]) {
      await seedTrack({ album: "Deep Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Deep Record");
    }

    for (const trackId of ["tr-1", "tr-2"]) {
      await seedTrack({ album: "Thin Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Thin Record");
    }

    const page = await listAlbumsHubPage(1);
    expect(page.items.map((entry) => entry.slug)).toEqual(["deep-record"]);
    expect(page.total).toBe(1);
    expect(page.pageCount).toBe(1);

    expect(await listAlbumsHubPage(2)).toMatchObject({ items: [], page: 2, total: 1 });
  });

  it("LABELS: a findings-bearing label is LIT and a findings-free floor-clearing one is UNLIT, both in one list", async () => {
    await seedTrack({
      album: null,
      label: "Certified Imprint",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "cert-1",
    });
    await linkTrackToLabel("cert-1", "Certified Imprint");
    for (const trackId of ["cert-2", "cert-3"]) {
      await seedTrack({ album: null, label: "Certified Imprint", title: trackId, trackId });
      await linkTrackToLabel(trackId, "Certified Imprint");
    }

    await seedCatalogueLabel("Deep Catalogue", 3);

    const page = await listLabelsHubPage(1);

    expect(page.items.map((entry) => ({ certified: entry.certified, slug: entry.slug }))).toEqual([
      { certified: true, slug: "certified-imprint" },
      { certified: false, slug: "deep-catalogue" },
    ]);
    expect(page.total).toBe(2);

    expect(page.items.find((entry) => entry.slug === "certified-imprint")?.trackCount).toBe(3);
  });
});

describe("the hub tiles: the owned cover master + the 48-tile window", () => {
  async function setTrackCover(trackId: string, url: string): Promise<void> {
    await db.execute({
      args: [url, trackId],
      sql: `update tracks set album_image_url = ? where track_id = ?`,
    });
  }

  async function resolveAlbumMaster(slug: string, key: string): Promise<void> {
    await db.execute({
      args: [key, "2026-07-20T00:00:00.000Z", slug],
      sql: `update albums
              set image_key = ?, image_state = 'resolved', image_updated_at = ?
            where slug = ?`,
    });
  }

  it("serves an album's OWNED master through the Cloudflare Images ladder, never the raw provider URL", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "A",
      trackId: "t1",
    });
    await setTrackCover("t1", "https://coverartarchive.org/release/abc/front");
    await reconcile();
    await resolveAlbumMaster("wormhole", "albums/wormhole.jpg");

    const [album] = (await listAlbumsHubPage(1)).items;

    expect(album?.coverImageUrl).toBe(
      "https://found.fluncle.com/cdn-cgi/image/width=640,format=auto/https://found.fluncle.com/albums/wormhole.jpg?v=1784505600000",
    );

    const [label] = (await listLabelsHubPage(1)).items;

    expect(label?.coverImageUrl).toBe(album?.coverImageUrl);
  });

  it("falls back to the raw provider cover while the master is unresolved", async () => {
    await seedTrack({
      album: "Wormhole",
      label: "Hospital Records",
      logId: "001.1.1A",
      title: "A",
      trackId: "t1",
    });
    await setTrackCover("t1", "https://coverartarchive.org/release/abc/front");
    await reconcile();

    const [album] = (await listAlbumsHubPage(1)).items;
    const [label] = (await listLabelsHubPage(1)).items;

    expect(album?.coverImageUrl).toBe("https://coverartarchive.org/release/abc/front");
    expect(label?.coverImageUrl).toBe("https://coverartarchive.org/release/abc/front");
  });

  it("carries the owned master onto the findings-free tiles too", async () => {
    for (const trackId of ["dr-1", "dr-2", "dr-3"]) {
      await seedTrack({ album: "Deep Record", label: null, title: trackId, trackId });
      await setTrackCover(trackId, "https://i.scdn.co/image/ab67616d00001e02deadbeefdeadbeefdead");
      await linkTrackToAlbum(trackId, "Deep Record");
    }
    await resolveAlbumMaster("deep-record", "albums/deep-record.jpg");

    const page = await listAlbumsHubPage(1);

    expect(page.items[0]?.coverImageUrl).toContain("/cdn-cgi/image/width=640,format=auto/");
    expect(page.items[0]?.coverImageUrl).toContain("albums/deep-record.jpg");
  });

  it("windows the unified index at 48, with an honest total on every page", async () => {
    for (let album = 0; album < 50; album++) {
      const name = `Record ${String(album).padStart(2, "0")}`;
      const trackId = `rec-${album}`;

      await seedTrack({ album: name, label: null, logId: `001.1.${album}A`, title: name, trackId });
      await linkTrackToAlbum(trackId, name);
    }

    const one = await listAlbumsHubPage(1);
    const two = await listAlbumsHubPage(2);

    expect(one.items).toHaveLength(48);
    expect(one.total).toBe(50);
    expect(one.pageCount).toBe(2);
    expect(one.items[0]?.name).toBe("Record 00");

    expect(two.items.map((entry) => entry.name)).toEqual(["Record 48", "Record 49"]);

    expect(two.total).toBe(50);
    expect((await listAlbumsHubPage(3)).total).toBe(50);

    const onPageOne = new Set(one.items.map((entry) => entry.slug));
    expect(two.items.some((entry) => onPageOne.has(entry.slug))).toBe(false);
  });
});

describe("the bio worklist is catalogue-aware (indexable findings-free entities join the queue)", () => {
  it("ARTISTS: queues certified-thin + findings-free-indexable, not the thin or the already-bio'd", async () => {
    await seedTrack({
      album: null,
      label: null,
      logId: "001.1.1A",
      title: "Cert",
      trackId: "bq-art-cert-1",
    });
    await upsertTrackArtists("bq-art-cert-1", ["Certified Artist"], [], { fillImages: false });

    for (const trackId of ["bq-art-deep-1", "bq-art-deep-2", "bq-art-deep-3"]) {
      await seedTrack({ album: null, label: null, title: trackId, trackId });
      await upsertTrackArtists(trackId, ["Deep Artist"], [], { fillImages: false });
    }

    for (const trackId of ["bq-art-thin-1", "bq-art-thin-2"]) {
      await seedTrack({ album: null, label: null, title: trackId, trackId });
      await upsertTrackArtists(trackId, ["Thin Artist"], [], { fillImages: false });
    }

    const queued = await listArtistsMissingBio(100);
    expect(queued.map((entry) => entry.name).sort()).toEqual(["Certified Artist", "Deep Artist"]);

    const deep = queued.find((entry) => entry.name === "Deep Artist");
    expect(deep).toBeDefined();
    await db.execute({
      args: ["A plain factual dossier paragraph about the artist.", deep?.slug ?? ""],
      sql: `update artists set bio = ? where slug = ?`,
    });

    const after = await listArtistsMissingBio(100);
    expect(after.map((entry) => entry.name)).not.toContain("Deep Artist");
  });

  it("LABELS: queues certified-thin + findings-free-indexable, not the thin or the already-bio'd", async () => {
    await seedTrack({
      album: null,
      label: "Certified Imprint",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "bq-lbl-cert-1",
    });
    await linkTrackToLabel("bq-lbl-cert-1", "Certified Imprint");

    for (const trackId of ["bq-lbl-deep-1", "bq-lbl-deep-2", "bq-lbl-deep-3"]) {
      await seedTrack({ album: null, label: "Deep Catalogue", title: trackId, trackId });
      await linkTrackToLabel(trackId, "Deep Catalogue");
    }

    for (const trackId of ["bq-lbl-thin-1", "bq-lbl-thin-2"]) {
      await seedTrack({ album: null, label: "Thin Imprint", title: trackId, trackId });
      await linkTrackToLabel(trackId, "Thin Imprint");
    }

    const queued = await listLabelsMissingBio(100);
    expect(queued.map((entry) => entry.name).sort()).toEqual([
      "Certified Imprint",
      "Deep Catalogue",
    ]);

    const deep = queued.find((entry) => entry.name === "Deep Catalogue");
    expect(deep).toBeDefined();
    await db.execute({
      args: ["A plain factual dossier paragraph about the imprint.", deep?.slug ?? ""],
      sql: `update labels set bio = ? where slug = ?`,
    });

    const after = await listLabelsMissingBio(100);
    expect(after.map((entry) => entry.name)).not.toContain("Deep Catalogue");
  });

  it("ALBUMS: queues certified-thin + findings-free-indexable, not the thin or the already-bio'd", async () => {
    await seedTrack({
      album: "Certified Record",
      label: null,
      logId: "001.1.1A",
      title: "Cert",
      trackId: "bq-alb-cert-1",
    });
    await linkTrackToAlbum("bq-alb-cert-1", "Certified Record");

    for (const trackId of ["bq-alb-deep-1", "bq-alb-deep-2", "bq-alb-deep-3"]) {
      await seedTrack({ album: "Deep Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Deep Record");
    }

    for (const trackId of ["bq-alb-thin-1", "bq-alb-thin-2"]) {
      await seedTrack({ album: "Thin Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Thin Record");
    }

    const queued = await listAlbumsMissingBio(100);
    expect(queued.map((entry) => entry.name).sort()).toEqual(["Certified Record", "Deep Record"]);

    const deep = queued.find((entry) => entry.name === "Deep Record");
    expect(deep).toBeDefined();
    await db.execute({
      args: ["A plain factual dossier paragraph about the record.", deep?.slug ?? ""],
      sql: `update albums set bio = ? where slug = ?`,
    });

    const after = await listAlbumsMissingBio(100);
    expect(after.map((entry) => entry.name)).not.toContain("Deep Record");
  });
});

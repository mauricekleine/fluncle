// The GRAPH surfaces — the album entity, the two entity pointers on `tracks`, and the reads
// the public /label/<slug> + /album/<slug> pages are built on. Proven against the REAL
// migrated schema on an in-memory libSQL engine (the labels.test.ts harness), so the real
// SQL runs against the real DDL.
//
// The load-bearing guarantee under test is the one the catalogue tier rests on: A CATALOGUE
// TRACK CAN NEVER LEAK INTO A FINDING SURFACE. `getFindingsBy*` drives through the
// `findings` inner join and must return ONLY certified tracks; `listCatalogueTracksBy*` is
// the exact complement and must return ONLY uncertified ones. There are tests that assert
// precisely that, with both kinds of track sitting on the same album and the same label.
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
  listAlbumSitemapRows,
  listAlbumsWithFindingCounts,
} from "./albums";
import { flattenArtistGroups, listLabelCatalogue } from "./catalogue-groups";
import { createIntegrationDb } from "./integration-db";
import { getGraphPreview } from "./graph-preview";
import { getLabelBySlug, getLabelForAlbum, listLabelsWithFindingCounts } from "./labels";
import { getFindingsByAlbum, getFindingsByLabel, listCatalogueTracksByAlbum } from "./tracks";

let db: Client;

/** A track in the universal music object. `logId` present ⇒ it is also a CERTIFIED finding. */
async function seedTrack(options: {
  album: null | string;
  label: null | string;
  logId?: string;
  title: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [options.trackId, options.title, '["Artist"]', options.album, options.label],
    sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, album, label)
          values (?, ?, ?, 'uri', 'https://open.spotify.com/track/x', 0, ?, ?)`,
  });

  if (options.logId) {
    await db.execute({
      args: [options.trackId, options.logId, "2026-07-01T00:00:00.000Z"],
      sql: `insert into findings
              (track_id, log_id, added_at, added_to_spotify, posted_to_telegram)
            values (?, ?, ?, 0, 0)`,
    });
  }
}

/** Run the reconciles: the labels deploy backfill, then the one-off album-graph catch-up. */
async function reconcile(): Promise<void> {
  await backfillLabels(db);
  await backfillAlbums(db);
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
    // A different pressing title (a DIFFERENT slug) in the SAME release group reuses the row —
    // the whole point of folding on the mbid instead of the slug.
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
    // A finding minted the album first, by slug, with no mbid (the publish path passes none).
    const bySlug = await ensureAlbum("Wormhole");
    // The crawler reaches the same record: mbid miss → slug hit → adopt the mbid onto the row.
    const byMbid = await ensureAlbum("Wormhole", RG_MBID);
    expect(byMbid).toBe(bySlug);

    const row = await db.execute(`select release_group_mbid from albums where slug = 'wormhole'`);
    expect(row.rows[0]?.release_group_mbid).toBe(RG_MBID);

    // A later pressing with a DIFFERENT slug now folds on the adopted mbid — no second row.
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
    // A catalogue track on a record Fluncle has never certified anything on: it must mint
    // NO entity of its own, or the /albums index would balloon to catalogue size.
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
    // Same record, same imprint, never certified — this is exactly the row the catalogue
    // crawler will land, and it must attach to the entity the finding already minted.
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
    // The total is counted in SQL, not by handing the rows to the isolate to length-check.
    expect(albumCatalogue.total).toBe(1);
    expect(labelCatalogue.totalTracks).toBe(1);
    // The type carries no logId at all — the row has nowhere on fluncle.com to link to, so
    // it links OUT. This is what keeps it structurally unable to pose as a finding.
    expect(albumCatalogue.tracks[0]).not.toHaveProperty("logId");
    expect(albumCatalogue.tracks[0]?.spotifyUrl).toContain("open.spotify.com");
    expect(labelTracks[0]).not.toHaveProperty("logId");
  });

  it("counts findings and the quieter rows separately on the index reads", async () => {
    const [album] = await listAlbumsWithFindingCounts();
    const [label] = await listLabelsWithFindingCounts();

    // The finding count is what the page SHOWS; the catalogue count exists only so the
    // sitemap can apply the same renderable-track gate the page applies.
    expect(album).toMatchObject({ catalogueCount: 1, findingCount: 1, name: "Wormhole" });
    expect(label).toMatchObject({ catalogueCount: 1, findingCount: 1, name: "Hospital Records" });
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

    // No bio yet ⇒ the preview carries none (the card renders no bio row, no gap).
    const withoutBio = await getGraphPreview("label", "hospital-records");
    expect(withoutBio.bio).toBeUndefined();
    // The signature line still rides — the preview is otherwise unchanged.
    expect(withoutBio.line).toBeDefined();

    // Author a bio (the entity-bio engine's write) …
    await db.execute({
      args: ["London's liquid drum and bass home since 1996.", "hospital-records"],
      sql: `update labels set bio = ? where slug = ?`,
    });

    // … and it flows straight onto the preview, the same paragraph the page prints.
    const withBio = await getGraphPreview("label", "hospital-records");
    expect(withBio.bio).toBe("London's liquid drum and bass home since 1996.");
  });
});

describe("the album sitemap is catalogue-aware: a findings-free album with enough tracks is IN", () => {
  it("sitemaps a crawl-minted, findings-free album past the floor, alongside a certified one", async () => {
    // A CERTIFIED album with 3 renderable tracks (>= ALBUM_INDEX_MIN_TRACKS): one finding + two
    // quieter rows. Publicly reachable and in the sitemap.
    await seedTrack({
      album: "Wormhole",
      label: null,
      logId: "001.1.1A",
      title: "A",
      trackId: "t1",
    });
    await seedTrack({ album: "Wormhole", label: null, title: "B", trackId: "t2" });
    await seedTrack({ album: "Wormhole", label: null, title: "C", trackId: "t3" });

    // A CATALOGUE-ONLY album, minted INLINE like the crawler does (an `albums` row folded on a
    // release group + `album_id` stamped) — three tracks, never a finding. It has a public page now
    // (a tracklist), clears the renderable-track floor, and so belongs in the sitemap too.
    const catalogueAlbumId = await ensureAlbum("Dark Matter", "rg-dark-matter");
    await seedTrack({ album: "Dark Matter", label: null, title: "D", trackId: "t4" });
    await seedTrack({ album: "Dark Matter", label: null, title: "E", trackId: "t5" });
    await seedTrack({ album: "Dark Matter", label: null, title: "F", trackId: "t6" });
    await db.execute({
      args: [catalogueAlbumId ?? "", "t4", "t5", "t6"],
      sql: `update tracks set album_id = ? where track_id in (?, ?, ?)`,
    });

    await reconcile();

    // Both clear the renderable-track floor, and both are publicly reachable now.
    const sitemap = await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS);
    expect(sitemap.map((row) => row.slug).sort()).toEqual(["dark-matter", "wormhole"]);
  });

  it("keeps a THIN findings-free album (1-2 tracks) OUT of the sitemap, though its page renders", async () => {
    // A crawl-minted album with a single catalogue track: below ALBUM_INDEX_MIN_TRACKS, so it is a
    // thin page — it still serves 200 (the resolver renders it, noindex) but stays out of the
    // sitemap. Thin is still thin, findings or not.
    const thinAlbumId = await ensureAlbum("Faint Signal", "rg-faint-signal");
    await seedTrack({ album: "Faint Signal", label: null, title: "One", trackId: "t7" });
    await db.execute({
      args: [thinAlbumId ?? "", "t7"],
      sql: `update tracks set album_id = ? where track_id = ?`,
    });

    await reconcile();

    // The row exists (a real internal entity) …
    expect(await getAlbumBySlug("faint-signal")).toBeDefined();
    // … but the single-track album is below the floor, so the sitemap omits it.
    const sitemap = await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS);
    expect(sitemap.map((row) => row.slug)).not.toContain("faint-signal");
  });
});

describe("the album index is bounded by the ARCHIVE, not the catalogue", () => {
  it("never lists an album Fluncle has no finding on", async () => {
    await seedTrack({
      album: "Wormhole",
      label: null,
      logId: "001.1.1A",
      title: "A",
      trackId: "t1",
    });
    await seedTrack({ album: "Never Found", label: null, title: "B", trackId: "t2" });
    await reconcile();

    expect((await listAlbumsWithFindingCounts()).map((album) => album.slug)).toEqual(["wormhole"]);
  });
});

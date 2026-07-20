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
  listAlbumsCataloguePage,
  listAlbumsMissingBio,
  listAlbumSitemapRows,
  listAlbumsWithFindingCounts,
} from "./albums";
import { listArtistsCataloguePage, listArtistsMissingBio, upsertTrackArtists } from "./artists";
import { flattenArtistGroups, listLabelCatalogue } from "./catalogue-groups";
import { createIntegrationDb } from "./integration-db";
import { getGraphPreview } from "./graph-preview";
import {
  getLabelBySlug,
  getLabelForAlbum,
  linkTrackToLabel,
  listLabelsCataloguePage,
  listLabelsMissingBio,
  listLabelsWithFindingCounts,
} from "./labels";
import { getFindingsByAlbum, getFindingsByLabel, listCatalogueTracksByAlbum } from "./tracks";

let db: Client;

/**
 * A track in the universal music object. `logId` present ⇒ it is also a CERTIFIED finding. The
 * stamping columns (`duplicateOfTrackId` / `dismissedAt`) and the anchors (`spotifyUrl` / `isrc`)
 * are optional — pass a shared `title` (artists are fixed to `["Artist"]`) to seed an unstamped
 * TWIN, two rows sharing one recording identity.
 */
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

  it("counts only the FINDINGS on the editorial index reads", async () => {
    const albums = await listAlbumsWithFindingCounts(1);
    const labels = await listLabelsWithFindingCounts(1);

    // The finding count is what the page SHOWS, and it is now the only count these reads carry:
    // the quieter rows are the sitemap's business (listAlbumSitemapRows / listLabelSitemapRows),
    // so the hub no longer pays a catalogue-scale correlated count per editorial row.
    expect(albums.items[0]).toEqual({
      coverImageUrl: undefined,
      findingCount: 1,
      name: "Wormhole",
      slug: "wormhole",
    });
    expect(labels.items[0]).toMatchObject({ findingCount: 1, name: "Hospital Records" });
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
    // The twin: same title + artist ⇒ one recording identity, reissued under a second barcode.
    // Only one row carries the Spotify anchor, so the fold must keep THAT one.
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
    // Operator-stamped duplicate + a dismissed row — both vetoed in SQL, out of the slice AND
    // the total.
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
    // Two genuinely distinct recordings (a remix is a distinct descriptor) survive.
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
    // Mint the (findings-free) album entity inline and stamp `album_id` on every row, exactly as
    // the crawler does — the album page reads by that pointer. `reconcile()` would not, because it
    // only mints entities a CERTIFIED finding carries, and none of these rows is certified.
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

    // One row per recording: the anchored twin kept, the bare twin folded away, the stamped and
    // dismissed rows vetoed, the two genuine recordings kept.
    expect(rendered.sort()).toEqual(["t_anchored", "t_orig", "t_remix"]);
    // The thin-content total reflects the deduped, un-vetoed set — never the six seeded rows.
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

    // No bio yet ⇒ the preview carries none (the card renders no bio row, no gap).
    const withoutBio = await getGraphPreview("label", "hospital-records");
    expect(withoutBio.bio).toBeUndefined();
    // No signature line on a catalogue entity — retired by the Three Areas Rule; the card
    // mirrors the page, and the page opens on the name (and the bio, once authored).
    expect(withoutBio.line).toBeUndefined();

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

    expect((await listAlbumsWithFindingCounts(1)).items.map((album) => album.slug)).toEqual([
      "wormhole",
    ]);
  });
});

// The hub's SECOND section: the INDEXABLE findings-free entities, the complement of the editorial
// index reads above, served as a numbered `?page=N` surface (listXxxCataloguePage) with an A–Z lane
// (listXxxCatalogueLetters). The load-bearing contract: (1) a findings-BEARING entity is NEVER here
// (it belongs to the editorial section), (2) the ≥3 renderable-track floor gates a thin entity out,
// (3) the right disjoint slice per page with an honest total + pageCount, and (4) a page past the
// end THROWS (so the route 404s) rather than clamping to page 1.
describe('the hub "more <entities>" ?page=N section', () => {
  /** Seed N findings-free catalogue tracks on one LABEL, stamping the label_id pointer. */
  async function seedCatalogueLabel(label: string, count: number): Promise<void> {
    for (let track = 0; track < count; track++) {
      const trackId = `${label}-${track}`;

      await seedTrack({ album: null, label, title: `T-${trackId}`, trackId });
      await linkTrackToLabel(trackId, label);
    }
  }

  it("LABELS: pages the findings-free set at the 48-tile window, disjoint, with an honest total", async () => {
    // 49 findings-free labels at the floor (3 tracks each) → two pages: 48 + 1. Zero-padded names so
    // the slug order (imprint-00 … imprint-48) is deterministic across the page boundary.
    for (let label = 0; label < 49; label++) {
      await seedCatalogueLabel(`Imprint ${String(label).padStart(2, "0")}`, 3);
    }

    const one = await listLabelsCataloguePage(1);
    expect(one.items).toHaveLength(48);
    expect(one.page).toBe(1);
    expect(one.total).toBe(49);
    expect(one.pageCount).toBe(2);
    expect(one.items[0]?.slug).toBe("imprint-00");
    expect(one.items[0]?.trackCount).toBe(3);

    const two = await listLabelsCataloguePage(2);
    expect(two.items).toHaveLength(1);
    expect(two.page).toBe(2);
    expect(two.total).toBe(49);
    expect(two.pageCount).toBe(2);
    expect(two.items[0]?.slug).toBe("imprint-48");

    // The pager is a window over ONE ordered set: page 2 is disjoint from page 1, never a re-slice.
    const onePage = new Set(one.items.map((entry) => entry.slug));
    expect(two.items.some((entry) => onePage.has(entry.slug))).toBe(false);

    // A page past the end is an honest empty page with the real total, never a clamp to page 1
    // (which would duplicate its URL); the route turns "past the end of every section" into a 404.
    expect(await listLabelsCataloguePage(3)).toMatchObject({
      items: [],
      page: 3,
      pageCount: 2,
      total: 49,
    });
  });

  it("LABELS: page 1 of an empty hub is a real empty page, not a throw", async () => {
    const page = await listLabelsCataloguePage(1);

    expect(page).toEqual({ items: [], letters: [], page: 1, pageCount: 1, total: 0 });
  });

  it("LABELS: the A–Z lane maps each present letter to its first page, folding digits into '#'", async () => {
    await seedCatalogueLabel("Alpha Imprint", 3);
    await seedCatalogueLabel("Bravo Imprint", 3);
    await seedCatalogueLabel("9 Imprint", 3);
    // A thin label (below the floor) is absent from the lane, exactly as it is from the page.
    await seedCatalogueLabel("Thin Imprint", 2);

    const letters = (await listLabelsCataloguePage(1)).letters ?? [];

    // Everything fits on page 1 here; the digit-led "9 imprint" folds into the "#" bucket.
    expect(letters).toEqual(
      expect.arrayContaining([
        { letter: "#", page: 1 },
        { letter: "a", page: 1 },
        { letter: "b", page: 1 },
      ]),
    );
    expect(letters.map((entry) => entry.letter)).not.toContain("t"); // the thin one never appears
  });

  it("ARTISTS: pages, and 404s past the end", async () => {
    for (const trackId of ["da-1", "da-2", "da-3"]) {
      await seedTrack({ album: null, label: null, title: trackId, trackId });
      await upsertTrackArtists(trackId, ["Deep Artist"], [], { fillImages: false });
    }

    const page = await listArtistsCataloguePage(1);
    expect(page.items.map((entry) => entry.name)).toEqual(["Deep Artist"]);
    expect(page.total).toBe(1);
    expect(page.pageCount).toBe(1);

    expect(page.letters).toEqual([{ letter: "d", page: 1 }]);

    // A page past the end is an honest EMPTY page carrying the real total — the route (which also
    // has an editorial section to place) decides the 404. Nothing is ever clamped to page 1.
    const past = await listArtistsCataloguePage(2);
    expect(past).toMatchObject({ items: [], page: 2, pageCount: 1, total: 1 });
  });

  it("ALBUMS: pages, and 404s past the end", async () => {
    for (const trackId of ["dr-1", "dr-2", "dr-3"]) {
      await seedTrack({ album: "Deep Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Deep Record");
    }
    // A thin record (below the floor) is excluded from the page and its total.
    for (const trackId of ["tr-1", "tr-2"]) {
      await seedTrack({ album: "Thin Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Thin Record");
    }

    const page = await listAlbumsCataloguePage(1);
    expect(page.items.map((entry) => entry.slug)).toEqual(["deep-record"]);
    expect(page.total).toBe(1);
    expect(page.pageCount).toBe(1);

    expect(await listAlbumsCataloguePage(2)).toMatchObject({ items: [], page: 2, total: 1 });
  });

  it("LABELS: a findings-bearing label is excluded (sum(certified) = 0), findings-free is in", async () => {
    // A findings-BEARING label with 3 renderable tracks (1 finding + 2 catalogue): it clears the
    // floor, but `sum(certified) = 0` keeps it out — it lives in the EDITORIAL section, never here.
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

    // A findings-FREE label with 3 catalogue tracks clears the floor, so it belongs here.
    await seedCatalogueLabel("Deep Catalogue", 3);

    const page = await listLabelsCataloguePage(1);
    expect(page.items.map((entry) => entry.slug)).toEqual(["deep-catalogue"]);
    expect(page.total).toBe(1);
  });
});

// The COVER a hub tile renders, and the WINDOW the editorial list is served through. Two things the
// hubs used to get wrong at once: every cover was hotlinked raw off whichever provider captured it
// (the album's OWNED master on Fluncle's R2 was never consulted, though the sweep had resolved one),
// and the editorial list SSR'd whole — every logged entity, on every page, forever.
describe("the hub tiles: the owned cover master + the editorial window", () => {
  /** Point a track at a raw provider cover (what the capture stored on the track row). */
  async function setTrackCover(trackId: string, url: string): Promise<void> {
    await db.execute({
      args: [url, trackId],
      sql: `update tracks set album_image_url = ? where track_id = ?`,
    });
  }

  /** Resolve an album's OWNED master, exactly as the cover-masters sweep marks it. */
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

    const [album] = (await listAlbumsWithFindingCounts(1)).items;

    expect(album?.coverImageUrl).toBe(
      "https://found.fluncle.com/cdn-cgi/image/width=640,format=auto/https://found.fluncle.com/albums/wormhole.jpg?v=1784505600000",
    );

    // The LABEL borrows that same record's cover, and must borrow the owned master with it — the
    // four columns have to come off ONE picked track, never a mix of two.
    const [label] = (await listLabelsWithFindingCounts(1)).items;

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

    const [album] = (await listAlbumsWithFindingCounts(1)).items;
    const [label] = (await listLabelsWithFindingCounts(1)).items;

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

    const page = await listAlbumsCataloguePage(1);

    expect(page.items[0]?.coverImageUrl).toContain("/cdn-cgi/image/width=640,format=auto/");
    expect(page.items[0]?.coverImageUrl).toContain("albums/deep-record.jpg");
  });

  it("windows the editorial list at 48, with an honest total on every page", async () => {
    // 50 logged records → two pages: 48 + 2. Zero-padded names so the alphabetical order is
    // deterministic across the page boundary.
    for (let album = 0; album < 50; album++) {
      const name = `Record ${String(album).padStart(2, "0")}`;
      const trackId = `rec-${album}`;

      await seedTrack({ album: name, label: null, logId: `001.1.${album}A`, title: name, trackId });
      await linkTrackToAlbum(trackId, name);
    }

    const one = await listAlbumsWithFindingCounts(1);
    const two = await listAlbumsWithFindingCounts(2);

    expect(one.items).toHaveLength(48);
    expect(one.total).toBe(50);
    expect(one.pageCount).toBe(2);
    expect(one.items[0]?.name).toBe("Record 00");

    expect(two.items.map((entry) => entry.name)).toEqual(["Record 48", "Record 49"]);
    // The total is a SEPARATE read precisely so it stays honest past the window's end — the
    // header's "N logged" and the pager's reach both key off it.
    expect(two.total).toBe(50);
    expect((await listAlbumsWithFindingCounts(3)).total).toBe(50);

    // The window is disjoint: page 2 is never a re-slice of page 1.
    const onPageOne = new Set(one.items.map((entry) => entry.slug));
    expect(two.items.some((entry) => onPageOne.has(entry.slug))).toBe(false);
  });
});

// The bio worklist reads (listArtistsMissingBio / listLabelsMissingBio / listAlbumsMissingBio): a
// bio-empty entity earns a bio the moment its page is INDEXABLE, matching the two ways an entity
// page renders. Four load-bearing cases per kind:
//   (a) a findings-free CATALOGUE entity at the floor (≥3 renderable, 0 certified) is NOW queued
//       (the widening that gives a crawl-minted page a dossier instead of a bare tracklist);
//   (b) a CERTIFIED-but-thin entity (1 finding, below the floor) is STILL queued — NO regression
//       of the original certified-finding gate;
//   (c) a THIN findings-free entity (<3 renderable) is NOT queued (the floor caps Firecrawl +
//       claude -p cost against the wide crawl's stub rows);
//   (d) an entity that already carries a bio is NEVER queued (the fill-empty-only guarantee).
describe("the bio worklist is catalogue-aware (indexable findings-free entities join the queue)", () => {
  it("ARTISTS: queues certified-thin + findings-free-indexable, not the thin or the already-bio'd", async () => {
    // (b) certified but THIN — 1 finding, 0 catalogue, below the ≥3 floor. Still queued.
    await seedTrack({
      album: null,
      label: null,
      logId: "001.1.1A",
      title: "Cert",
      trackId: "bq-art-cert-1",
    });
    await upsertTrackArtists("bq-art-cert-1", ["Certified Artist"], [], { fillImages: false });

    // (a) findings-free but INDEXABLE — 3 catalogue tracks, 0 findings. Now queued.
    for (const trackId of ["bq-art-deep-1", "bq-art-deep-2", "bq-art-deep-3"]) {
      await seedTrack({ album: null, label: null, title: trackId, trackId });
      await upsertTrackArtists(trackId, ["Deep Artist"], [], { fillImages: false });
    }

    // (c) findings-free and THIN — 2 catalogue tracks. Never queued.
    for (const trackId of ["bq-art-thin-1", "bq-art-thin-2"]) {
      await seedTrack({ album: null, label: null, title: trackId, trackId });
      await upsertTrackArtists(trackId, ["Thin Artist"], [], { fillImages: false });
    }

    const queued = await listArtistsMissingBio(100);
    expect(queued.map((entry) => entry.name).sort()).toEqual(["Certified Artist", "Deep Artist"]);

    // (d) author a bio on the indexable one → it drops out of the queue.
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
    // (b) certified but THIN — 1 finding on the label, below the floor. Still queued.
    await seedTrack({
      album: null,
      label: "Certified Imprint",
      logId: "001.1.1A",
      title: "Cert",
      trackId: "bq-lbl-cert-1",
    });
    await linkTrackToLabel("bq-lbl-cert-1", "Certified Imprint");

    // (a) findings-free but INDEXABLE — 3 catalogue tracks. Now queued.
    for (const trackId of ["bq-lbl-deep-1", "bq-lbl-deep-2", "bq-lbl-deep-3"]) {
      await seedTrack({ album: null, label: "Deep Catalogue", title: trackId, trackId });
      await linkTrackToLabel(trackId, "Deep Catalogue");
    }

    // (c) findings-free and THIN — 2 catalogue tracks. Never queued.
    for (const trackId of ["bq-lbl-thin-1", "bq-lbl-thin-2"]) {
      await seedTrack({ album: null, label: "Thin Imprint", title: trackId, trackId });
      await linkTrackToLabel(trackId, "Thin Imprint");
    }

    const queued = await listLabelsMissingBio(100);
    expect(queued.map((entry) => entry.name).sort()).toEqual([
      "Certified Imprint",
      "Deep Catalogue",
    ]);

    // (d) author a bio on the indexable one → it drops out of the queue.
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
    // (b) certified but THIN — 1 finding on the record, below the floor. Still queued.
    await seedTrack({
      album: "Certified Record",
      label: null,
      logId: "001.1.1A",
      title: "Cert",
      trackId: "bq-alb-cert-1",
    });
    await linkTrackToAlbum("bq-alb-cert-1", "Certified Record");

    // (a) findings-free but INDEXABLE — 3 catalogue tracks. Now queued.
    for (const trackId of ["bq-alb-deep-1", "bq-alb-deep-2", "bq-alb-deep-3"]) {
      await seedTrack({ album: "Deep Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Deep Record");
    }

    // (c) findings-free and THIN — 2 catalogue tracks. Never queued.
    for (const trackId of ["bq-alb-thin-1", "bq-alb-thin-2"]) {
      await seedTrack({ album: "Thin Record", label: null, title: trackId, trackId });
      await linkTrackToAlbum(trackId, "Thin Record");
    }

    const queued = await listAlbumsMissingBio(100);
    expect(queued.map((entry) => entry.name).sort()).toEqual(["Certified Record", "Deep Record"]);

    // (d) author a bio on the indexable one → it drops out of the queue.
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

// THE SITEMAP'S TWO READS, PROVEN AGAINST EACH OTHER — over a REAL libSQL database with the
// generated migrations applied, because both halves of this are SQL.
//
// `/sitemap.xml` reads AGGREGATES (`collectSitemapIndexStats`) for its ~eight `<sitemap>` lines,
// and a child reads ONE bag (`collectSitemapBag`). The index carries no `<url>` at all, so neither
// read evaluates the full archive's thin-content gates.
//
// That split is only safe while the cheap read and the rows AGREE, and a mocked-DB test could not
// tell: the agreement lives entirely in whether a `count(*)`/`max()` covers the same set its row
// reader enumerates. So the proof here is differential — build the index BOTH ways over the same
// seeded archive and demand the same answer:
//
//   - the aggregates vs `sitemapIndexStatsFromBags` over the real rows (counts AND dates);
//   - the rendered index XML, byte for byte;
//   - each child's XML from its OWN bag vs from the merged all-bags world, so no kind can quietly
//     grow a dependency on a bag the one-bag fetch no longer loads.

import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSitemapIndexXml,
  buildSitemapShardXml,
  SITEMAP_KINDS,
  type SitemapBags,
  sitemapIndexStatsFromBags,
  sitemapPagesFromBags,
  type SitemapRowBags,
  type SitemapSqlWindowedKind,
} from "../sitemap";

let db: Client;

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => db };
});

import { ALBUM_INDEX_MIN_TRACKS, linkTrackToAlbum, listAlbumSitemapRows } from "./albums";
import { typedRows } from "./db";
import { createIntegrationDb, syncHubCounts } from "./integration-db";
import { ARTIST_INDEX_MIN_FINDINGS, listArtistSitemapRows } from "./artists";
import { LABEL_INDEX_MIN_TRACKS, linkTrackToLabel, listLabelSitemapRows } from "./labels";
import {
  collectSitemapBag,
  collectSitemapIndexStats,
  sitemapBoundaryStatement,
  sitemapWindowStatement,
} from "./sitemap-data";

type TrackFixture = {
  album: string;
  artistId: string;
  artistName: string;
  label: string;
  /** Set ⇒ this track is a CERTIFIED finding at that coordinate; absent ⇒ a catalogue row. */
  logId?: string;
  /** The finding's `added_at`; also what every entity's `lastmod` derives from. */
  addedAt?: string;
  title: string;
  trackId: string;
  updatedAt?: string;
  videoSquaredAt?: string;
  videoUrl?: string;
};

/**
 * One track, wired the way production wires it: the row, its optional `findings` certification
 * (with the `is_catalogue` flip `publishTrack` does), its artist edge, and its label/album
 * pointers written by the REAL link functions — so the joins the sitemap readers walk are the
 * ones the publish path actually creates.
 */
async function seedTrack(track: TrackFixture): Promise<void> {
  await db.execute({
    args: [
      track.trackId,
      track.title,
      JSON.stringify([track.artistName]),
      track.album,
      track.label,
      `https://i.scdn.co/image/${track.trackId}`,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, album, label, duration_ms, album_image_url)
          values (?, ?, ?, ?, ?, 270000, ?)`,
  });

  await db.execute({
    args: [track.artistId, track.artistName, track.artistName.toLowerCase().replace(/\W+/g, "-")],
    sql: `insert or ignore into artists (id, name, slug, created_at, updated_at)
          values (?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
  await db.execute({
    args: [track.trackId, track.artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });

  if (track.logId !== undefined) {
    await db.execute({
      args: [
        track.trackId,
        track.logId,
        track.addedAt ?? "2026-07-01T00:00:00.000Z",
        track.updatedAt ?? null,
        track.videoSquaredAt ?? null,
        track.videoUrl ?? null,
      ],
      sql: `insert into findings (track_id, log_id, added_at, updated_at, video_squared_at, video_url)
            values (?, ?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: [track.trackId],
      sql: `update tracks set is_catalogue = 0 where track_id = ?`,
    });
  }

  await linkTrackToLabel(track.trackId, track.label);
  await linkTrackToAlbum(track.trackId, track.album);
}

async function seedMixtape(options: {
  addedAt: string;
  id: string;
  logId: string;
  setVideoAt?: string;
  title: string;
  updatedAt: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.id,
      options.logId,
      options.title,
      options.addedAt,
      options.addedAt,
      options.updatedAt,
      options.setVideoAt ?? null,
    ],
    sql: `insert into mixtapes
            (id, log_id, title, added_at, created_at, updated_at, set_video_at, status)
          values (?, ?, ?, ?, ?, ?, ?, 'published')`,
  });
}

async function seedLogbookEntry(sector: number, generatedAt: string): Promise<void> {
  await db.execute({
    args: [sector, `Sector ${sector}`, "A drift.", generatedAt, generatedAt, generatedAt],
    sql: `insert into logbook_entries
            (sector, title, body, generated_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function seedGalaxy(options: {
  id: string;
  name: string;
  retiredAt?: string;
  slug: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.id,
      `handle-${options.id}`,
      options.name,
      options.slug,
      options.retiredAt ?? null,
    ],
    sql: `insert into galaxies (id, handle, name, slug, centroid_json, retired_at, created_at, updated_at)
          values (?, ?, ?, ?, '[1,0]', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

async function seedGalaxyMembers(galaxyId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await db.execute({
      args: [`${galaxyId}-member-${index}`, galaxyId],
      // Galaxy membership is derived from `findings.galaxy_id`; this fixture isolates that count
      // contract, so the no-log members do not alter the sitemap's certified-log bag.
      sql: `insert into findings (track_id, galaxy_id, added_at)
            values (?, ?, '2026-07-01T00:00:00.000Z')`,
    });
  }
}

/** Every row bag, each fetched the way its own child route fetches it. */
async function readRowBags(): Promise<SitemapRowBags> {
  const [albums, artists, docs, galaxies, labels, logbook, logs, tracks] = await Promise.all([
    collectSitemapBag("albums"),
    collectSitemapBag("artists"),
    collectSitemapBag("docs"),
    collectSitemapBag("galaxies"),
    collectSitemapBag("labels"),
    collectSitemapBag("logbook"),
    collectSitemapBag("findings"),
    collectSitemapBag("tracks"),
  ]);

  return {
    albums: albums.albums,
    artists: artists.artists,
    docs: docs.docs,
    galaxies: galaxies.galaxies,
    labels: labels.labels,
    logbook: logbook.logbook,
    logs: logs.logs,
    tracks: tracks.tracks,
  };
}

/** The merged world the sitemap USED to build every document from — the reference. */
async function readAllBags(): Promise<SitemapBags> {
  const rows = await readRowBags();
  const { pages } = await collectSitemapBag("pages");

  return { ...rows, pages };
}

beforeEach(async () => {
  db = await createIntegrationDb();

  // A world with all three tiers in it: certified findings (one carrying a squared video, whose
  // `video_squared_at` must LIFT its lastmod past its `added_at`), quieter catalogue rows that
  // push the entities over the thin-content floor without certifying anything, and an entity set
  // that stays BELOW the floor so the gate is actually exercised rather than trivially satisfied.
  await seedTrack({
    addedAt: "2026-06-03T10:00:00.000Z",
    album: "Wormhole",
    artistId: "artist-dimension",
    artistName: "Dimension",
    label: "MedSchool",
    logId: "004.7.2I",
    title: "Wormhole",
    trackId: "track-1",
  });
  await seedTrack({
    addedAt: "2026-06-10T14:57:38.786Z",
    album: "Wormhole",
    artistId: "artist-dimension",
    artistName: "Dimension",
    label: "MedSchool",
    logId: "011.6.8K",
    title: "Black Hole",
    trackId: "track-2",
    videoSquaredAt: "2026-07-14T09:00:00.000Z",
    videoUrl: "https://media.fluncle.com/011.6.8K/footage.mp4",
  });
  await seedTrack({
    album: "Wormhole",
    artistId: "artist-dimension",
    artistName: "Dimension",
    label: "MedSchool",
    title: "Quiet One",
    trackId: "track-3",
  });
  // A second entity family, deliberately BELOW the 3-renderable-track floor: it must be absent
  // from the rows AND uncounted by the aggregate, which is the gate both sides have to agree on.
  await seedTrack({
    album: "Thin Record",
    artistId: "artist-stranger",
    artistName: "Stranger",
    label: "Thin Imprint",
    title: "Only Track",
    trackId: "track-4",
  });

  await seedMixtape({
    addedAt: "2026-05-20T12:00:00.000Z",
    id: "mixtape-1",
    logId: "019.F.1A",
    title: "Deep Space Drift",
    updatedAt: "2026-05-21T12:00:00.000Z",
  });
  await seedMixtape({
    addedAt: "2026-04-20T12:00:00.000Z",
    id: "mixtape-2",
    logId: "018.F.1A",
    setVideoAt: "2026-06-30T12:00:00.000Z",
    title: "Amen Break Voyage",
    updatedAt: "2026-04-21T12:00:00.000Z",
  });

  await seedLogbookEntry(36, "2026-07-04T02:11:00.000Z");
  await seedLogbookEntry(37, "2026-07-05T02:11:00.000Z");
  // A public map with the three sitemap-relevant states: exactly at the floor, thin, and retired.
  // All live rows are named, so the launch gate is open; the child may publish only the first.
  await seedGalaxy({ id: "gal-live", name: "The Liquid Deep", slug: "the-liquid-deep" });
  await seedGalaxyMembers("gal-live", 4);
  await seedGalaxy({ id: "gal-thin", name: "Weightless Rollers", slug: "weightless-rollers" });
  await seedGalaxyMembers("gal-thin", 3);
  await seedGalaxy({
    id: "gal-retired",
    name: "Former System",
    retiredAt: "2026-07-01T00:00:00.000Z",
    slug: "former-system",
  });
  await seedGalaxyMembers("gal-retired", 8);

  // The maintained hub counters the thin-content gate reads. Production moves them as deltas on
  // every write; a fixture that inserts rows directly has to run the real backfill or its world
  // would hold edges with counters at the DDL default of 0.
  await syncHubCounts(db);

  await db.execute({
    args: ["2026-06-01", "https://open.spotify.com/track/example"],
    sql: `update tracks set release_date = ?, spotify_url = ? where is_catalogue = 1`,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("the sitemap index reads aggregates that match the rows", () => {
  it("counts and dates every child exactly as the full bags do", async () => {
    const [stats, bags] = await Promise.all([collectSitemapIndexStats(), readAllBags()]);

    expect(stats).toEqual(sitemapIndexStatsFromBags(bags));
  });

  it("renders a byte-identical index document either way", async () => {
    const [stats, bags] = await Promise.all([collectSitemapIndexStats(), readAllBags()]);

    expect(buildSitemapIndexXml(stats)).toBe(buildSitemapIndexXml(sitemapIndexStatsFromBags(bags)));
  });

  it("carries the real dates the fixture states — a squared video lifts the findings child", async () => {
    const stats = await collectSitemapIndexStats();

    // Three certified findings' worth of pages: two findings + two published mixtapes.
    expect(stats.findings.count).toBe(4);
    // The freshest `/log` date is the SQUARED VIDEO's, not the newest `added_at` — the scalar
    // three-argument max() inside the aggregate one-argument max(), the shape the row read uses.
    expect(stats.findings.lastmod).toBe("2026-07-14T09:00:00.000Z");
    // One artist / label / album clears the floor; the thin family does not.
    expect(stats.artists.count).toBe(1);
    expect(stats.labels.count).toBe(1);
    expect(stats.albums.count).toBe(1);
    // An entity dates from its freshest CERTIFIED finding (`added_at`), never from a catalogue row.
    expect(stats.albums.lastmod).toBe("2026-06-10T14:57:38.786Z");
    expect(stats.logbook).toEqual({ count: 2, lastmod: "2026-07-05T02:11:00.000Z" });
    expect(stats.galaxies.count).toBe(1);
    // Undated by design: the MDX carries no timestamp, and a lens page has no honest date.
    expect(stats.docs.lastmod).toBeUndefined();
    expect(stats.galaxies.lastmod).toBeUndefined();
  });

  it("derives the static child's timestamps and gates from the same aggregates", async () => {
    const [{ pages }, rows] = await Promise.all([collectSitemapBag("pages"), readRowBags()]);

    // `mixOpen` is passed through: it is `getMixChainDepth().open`, which no bag implies.
    expect(pages).toEqual(sitemapPagesFromBags(rows, pages.mixOpen));
    // The hubs' shared stamp is the freshest date ANYWHERE, which here is the squared video.
    expect(pages.latest).toBe("2026-07-14T09:00:00.000Z");
    expect(pages.logbookLatest).toBe("2026-07-05T02:11:00.000Z");
  });

  it("counts sitemap galaxies through the scalar index-backed reader", async () => {
    const execute = vi.spyOn(db, "execute");

    const [stats, bag] = await Promise.all([
      collectSitemapIndexStats(),
      collectSitemapBag("galaxies"),
    ]);

    expect(stats.galaxies.count).toBe(1);
    expect(bag.galaxies).toEqual([{ slug: "the-liquid-deep" }]);

    const statement = execute.mock.calls
      .map(([input]) => input as InStatement)
      .find(
        (input) =>
          typeof input !== "string" &&
          input.sql.includes("from galaxies as galaxy") &&
          input.sql.includes("findings_galaxy_id_idx"),
      );

    if (statement === undefined || typeof statement === "string") {
      throw new Error("sitemap index did not issue its scalar galaxy count");
    }

    expect(statement.sql).not.toMatch(/group by galaxy_id/i);
    expect(statement.sql).not.toMatch(/select id, name, slug/i);

    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });
    const details = typedRows<{ detail: string }>(plan.rows)
      .map((row) => row.detail)
      .join("\n");

    expect(details, details).toMatch(/SEARCH member USING COVERING INDEX findings_galaxy_id_idx/i);
    expect(details, details).not.toContain("USE TEMP B-TREE");
  });
});

describe("a child sitemap fetches only its own bag", () => {
  it("uses bounded row statements for every SQL-windowed child", async () => {
    const execute = vi.spyOn(db, "execute");

    for (const kind of ["albums", "artists", "labels", "logbook", "tracks"] as const) {
      execute.mockClear();
      const bag = await collectSitemapBag(kind, 1, 1);
      const rows = kind === "logbook" ? bag.logbook : bag[kind];
      const sql = execute.mock.calls.map(([statement]) => {
        const input = statement as InStatement;
        return typeof input === "string" ? input : input.sql;
      });

      expect(rows.length, `${kind} returned more than its SQL window`).toBeLessThanOrEqual(1);
      expect(sql.some((statement) => /order by[\s\S]+limit \?/i.test(statement))).toBe(true);
      expect(sql.some((statement) => /\boffset\b/i.test(statement))).toBe(false);
    }

    execute.mockClear();
    expect((await collectSitemapBag("tracks", 2, 1)).tracks).toHaveLength(1);
    expect(
      execute.mock.calls.some(([statement]) => {
        const input = statement as InStatement;
        const sql = typeof input === "string" ? input : input.sql;
        return /\boffset\b/i.test(sql);
      }),
    ).toBe(false);
  });

  it("serves every keyset window as an index search without a temporary sort", async () => {
    const tables: Record<SitemapSqlWindowedKind, string> = {
      albums: "albums",
      artists: "(?:artists|a)",
      labels: "labels",
      logbook: "logbook_entries",
      tracks: "tracks",
    };

    for (const kind of Object.keys(tables) as SitemapSqlWindowedKind[]) {
      for (const statement of [
        sitemapBoundaryStatement(kind, 1, kind === "logbook" ? "38" : "a"),
        sitemapWindowStatement(kind, 1, kind === "logbook" ? "38" : "a"),
      ]) {
        const plan = await db.execute({
          args: statement.args,
          sql: `explain query plan ${statement.sql}`,
        });
        const details = typedRows<{ detail: string }>(plan.rows)
          .map((row) => row.detail)
          .join("\n");

        expect(details, `${kind}\n${details}`).toMatch(
          new RegExp(`SEARCH ${tables[kind]}(?:\\s|$)`, "i"),
        );
        expect(details, `${kind}\n${details}`).not.toMatch(
          new RegExp(`SCAN ${tables[kind]}(?:\\s|$)`, "i"),
        );
        expect(details, `${kind}\n${details}`).not.toMatch(
          /^SCAN (?:albums|artists|a|labels|logbook_entries|tracks|t\d*|f\d*|ta\d*)\b/im,
        );
        expect(details, `${kind}\n${details}`).not.toContain("USE TEMP B-TREE");
      }
    }
  });

  it("preserves each unwindowed set and order across the union of its children", async () => {
    const trackReference = (
      await db.execute({
        sql: `select track_id from tracks
              where is_catalogue = 1
                and duplicate_of_track_id is null
                and trim(title) <> ''
                and artists_json is not null and trim(artists_json) not in ('', '[]')
                and dismissed_at is null
                and album_id is not null
                and release_date is not null
                and album_image_url is not null
                and (spotify_url is not null or apple_music_url is not null)
              order by track_id`,
      })
    ).rows;
    const trackIds = typedRows<{ track_id: string }>(trackReference).map((row) => row.track_id);
    const references: Record<SitemapSqlWindowedKind, string[]> = {
      albums: (await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS)).map((row) => row.slug),
      artists: (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug),
      labels: (await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS)).map((row) => row.slug),
      logbook: typedRows<{ sector: number }>(
        (await db.execute(`select sector from logbook_entries order by sector desc`)).rows,
      ).map((row) => String(row.sector).padStart(3, "0")),
      tracks: trackIds,
    };

    for (const kind of Object.keys(references) as SitemapSqlWindowedKind[]) {
      const actual: string[] = [];
      const reference = references[kind];

      for (let page = 1; page <= reference.length + 1; page += 1) {
        const bag = await collectSitemapBag(kind, page, 1);
        const rows = kind === "logbook" ? bag.logbook : bag[kind];

        if (rows.length === 0) {
          break;
        }

        actual.push(
          ...rows.map((row) =>
            "trackId" in row ? row.trackId : "sector" in row ? String(row.sector) : row.slug,
          ),
        );
      }

      expect(actual, kind).toEqual(reference);
    }
  });

  it("returns an empty SQL-windowed bag past the maintained count", async () => {
    for (const kind of ["albums", "artists", "labels", "logbook", "tracks"] as const) {
      const bag = await collectSitemapBag(kind, 2);
      const rows = kind === "logbook" ? bag.logbook : bag[kind];

      expect(rows, kind).toEqual([]);
      expect(buildSitemapShardXml(kind, 2, bag), kind).toBeUndefined();
    }
  });

  it("recomputes boundaries after a same-count interior membership change", async () => {
    await seedLogbookEntry(38, "2026-07-06T02:11:00.000Z");
    await seedLogbookEntry(39, "2026-07-07T02:11:00.000Z");

    expect((await collectSitemapBag("logbook", 2, 2)).logbook.map((row) => row.sector)).toEqual([
      "037",
      "036",
    ]);

    await db.batch(
      [
        { args: [], sql: `delete from logbook_entries where sector = 38` },
        {
          args: [34, "Sector 34", "A drift.", "2026-07-02T02:11:00.000Z"],
          sql: `insert into logbook_entries
                  (sector, title, body, generated_at, created_at, updated_at)
                values (?, ?, ?, ?, '2026-07-02T02:11:00.000Z', '2026-07-02T02:11:00.000Z')`,
        },
      ],
      "write",
    );

    const actual = (
      await Promise.all([1, 2].map((page) => collectSitemapBag("logbook", page, 2)))
    ).flatMap((bag) => bag.logbook.map((row) => row.sector));

    expect(actual).toEqual(["039", "037", "036", "034"]);
  });

  it("does not count catalogue tracks or entities for the static pages child", async () => {
    const execute = vi.spyOn(db, "execute");
    const sqlText = (statement: InStatement) =>
      typeof statement === "string" ? statement : statement.sql;
    const catalogueCounts = () =>
      execute.mock.calls
        .map(([statement]) => sqlText(statement))
        .filter((sql) =>
          /select count\(\*\) as (?:total|n)\s+from (?:tracks|artists|labels|albums)(?:\s|$)/i.test(
            sql,
          ),
        );

    const { pages } = await collectSitemapBag("pages");
    expect(pages.latest).toBe("2026-07-14T09:00:00.000Z");
    expect(catalogueCounts()).toEqual([]);

    execute.mockClear();
    const stats = await collectSitemapIndexStats();
    expect(catalogueCounts()).toHaveLength(4);
    expect(stats.pages.lastmod).toBe(pages.latest);
  });

  it("serves the identical document it would from the merged all-bags world", async () => {
    const bags = await readAllBags();

    for (const kind of SITEMAP_KINDS) {
      const own = await collectSitemapBag(kind);

      expect(
        buildSitemapShardXml(kind, 1, own),
        `the ${kind} child must not depend on any other kind's bag`,
      ).toBe(buildSitemapShardXml(kind, 1, bags));
    }
  });

  it("carries the entity pages the thin-content gate admits, and no others", async () => {
    const labels = buildSitemapShardXml("labels", 1, await collectSitemapBag("labels")) ?? "";
    const albums = buildSitemapShardXml("albums", 1, await collectSitemapBag("albums")) ?? "";

    expect(labels).toContain("/label/medschool");
    expect(labels).not.toContain("thin-imprint");
    expect(albums).toContain("/album/wormhole");
    expect(albums).not.toContain("thin-record");
  });

  it("lists both findings and published mixtapes in the findings child", async () => {
    const xml = buildSitemapShardXml("findings", 1, await collectSitemapBag("findings")) ?? "";

    for (const coordinate of ["004.7.2I", "011.6.8K", "019.F.1A", "018.F.1A"]) {
      expect(xml).toContain(`/log/${coordinate}`);
    }

    expect(xml.match(/<loc>/g)).toHaveLength(4);
  });
});

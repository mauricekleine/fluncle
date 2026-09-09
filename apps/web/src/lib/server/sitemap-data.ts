// Everything `/sitemap.xml` (the index) and `/sitemap/<kind>-<n>.xml` (the children) know.
//
// ── ONE DOCUMENT, ONE READ ──────────────────────────────────────────────────────────────────────
// The index carries no `<url>` at all, so it reads AGGREGATES (`collectSitemapIndexStats` — a
// `count(*)` and a `max()` per child) while each child reads ONE bag (`collectSitemapBag`).
// The two agree by construction, and
// `sitemap-data.integration.test.ts` proves it over a seeded archive rather than asserting it here.
//
// ── THE CERTIFICATION RAIL, RESTATED AS A BUDGET ────────────────────────────────────────
// The TRACK read drives from `findings` through the inner join, so no `/log` <loc> is ever a
// catalogue row: the log surface is bounded by the ARCHIVE (what Fluncle certified), never by
// the CATALOGUE (what the crawler merely heard of), and a 30,000-row crawl adds exactly ZERO
// `/log` <loc>s. That is not an accident to be re-derived each time someone reads this file, it
// is the certification rail (docs/catalogue-crawler.md), and
// `findings-certification.integration.test.ts` pins it against the real schema.
//
// What the catalogue DOES move is the ENTITY pages. An artist/label/album page counts its findings
// PLUS its quieter uncertified rows toward the thin-content gate, so a record Fluncle found one
// banger on becomes a real tracklist page once the rest of the record is there — and an entity the
// crawler discovered and he has certified NOTHING on is a page too, built from its releases,
// indexable once it clears the same floor. So the crawl DOES add <loc>s here: never for a track,
// always only for the entity its tracks hang off.
//
// That is why the three graph reads below are NOT the ones the `/artists`, `/labels`, `/albums`
// hubs use. The hubs are Fluncle's own editorial lists (findings-joined, "every label I've pulled a
// banger off"); the sitemap is the machine's complete map of pages that exist and may be indexed.
// Using the hub reads here would orphan every crawler-discovered page from the sitemap — exactly
// the invariant this file exists to hold. See docs/album-entity.md.

import { DOCS_PAGES } from "../docs-pages";
import { formatSector } from "../log-id-shared";
import { mixtapeSetVideoUrl, albumCoverAtSize, trackMedia } from "../media";
import { mixtapeCoverUrl } from "../mixtapes";
import { artistTitleLine, definitionalSentences } from "../log-prose";
import {
  EMPTY_SITEMAP_BAGS,
  sitemapMaxUrls,
  type SitemapArtist,
  type SitemapBags,
  type SitemapDoc,
  type SitemapEntity,
  type SitemapGalaxy,
  type SitemapIndexStats,
  type SitemapKind,
  type SitemapKindStats,
  type SitemapLogbookEntry,
  type SitemapLogPage,
  type SitemapPages,
  type SitemapSqlWindowedKind,
  sitemapPagesStats,
} from "../sitemap";
import {
  ALBUM_INDEX_MIN_TRACKS,
  albumSitemapWindowStatement,
  countIndexableAlbums,
  listAlbumSitemapRows,
  maxAlbumSitemapLastmod,
} from "./albums";
import {
  ARTIST_INDEX_MIN_FINDINGS,
  artistSitemapWindowStatement,
  countIndexableArtists,
  listArtistSitemapRows,
  maxArtistSitemapLastmod,
  parseArtistsJson,
} from "./artists";
import { getDb, typedRows } from "./db";
import {
  countPublicIndexableGalaxies,
  GALAXY_INDEX_MIN_FINDINGS,
  listPublicGalaxies,
} from "./galaxies-map";
import {
  countIndexableLabels,
  LABEL_INDEX_MIN_TRACKS,
  labelSitemapWindowStatement,
  listLabelSitemapRows,
  maxLabelSitemapLastmod,
} from "./labels";
import { SITEMAP_CACHE_POLICY } from "./edge-cache";
import {
  countIndexableTrackPages,
  listTrackSitemapRows,
  trackSitemapWindowStatement,
  TRACK_PAGE_INDEXABLE_WHERE,
} from "./track-page";
import { getMixChainDepth } from "./tracks";
type SitemapWindow = { after?: string; limit: number };

/**
 * The bounded key-only query that reconstructs one missing child boundary. Its inner read walks at
 * most one child page from a known key; the outer aggregate returns only that page's final key.
 * There is deliberately no OFFSET: a deep request chains fixed-size seeks through the current
 * corpus until it reaches the requested page.
 */
export function sitemapBoundaryStatement(
  kind: SitemapSqlWindowedKind,
  limit: number,
  after?: string,
) {
  const operator = after === undefined ? ">=" : ">";
  const start = after ?? "";

  switch (kind) {
    case "albums":
      return {
        args: [start, ALBUM_INDEX_MIN_TRACKS, limit],
        sql: `select max(slug) as boundary, count(*) as n from (
                select slug from albums
                where slug ${operator} ? and renderable_track_count >= ?
                order by slug asc limit ?
              )`,
      };
    case "artists":
      return {
        args: [start, ARTIST_INDEX_MIN_FINDINGS, limit],
        sql: `select max(slug) as boundary, count(*) as n from (
                select slug from artists
                where slug ${operator} ? and renderable_track_count >= ?
                order by slug asc limit ?
              )`,
      };
    case "labels":
      return {
        args: [start, LABEL_INDEX_MIN_TRACKS, limit],
        sql: `select max(slug) as boundary, count(*) as n from (
                select slug from labels
                where slug ${operator} ? and renderable_track_count >= ?
                order by slug asc limit ?
              )`,
      };
    case "logbook": {
      const sector = after === undefined ? Number.MAX_SAFE_INTEGER : Number(after);
      const comparison = after === undefined ? "<=" : "<";
      return {
        args: [sector, limit],
        sql: `select min(sector) as boundary, count(*) as n from (
                select sector from logbook_entries
                where sector ${comparison} ?
                order by sector desc limit ?
              )`,
      };
    }
    case "tracks":
      return {
        args: [start, limit],
        sql: `select max(track_id) as boundary, count(*) as n from (
                select tracks.track_id from tracks
                where tracks.track_id ${operator} ? and ${TRACK_PAGE_INDEXABLE_WHERE}
                order by tracks.track_id asc limit ?
              )`,
      };
  }
}

/** The exact row-producing statement each SQL-windowed child executes. */
export function sitemapWindowStatement(
  kind: SitemapSqlWindowedKind,
  limit: number,
  after?: string,
) {
  switch (kind) {
    case "albums":
      return albumSitemapWindowStatement(ALBUM_INDEX_MIN_TRACKS, limit, after);
    case "artists":
      return artistSitemapWindowStatement(ARTIST_INDEX_MIN_FINDINGS, limit, after);
    case "labels":
      return labelSitemapWindowStatement(LABEL_INDEX_MIN_TRACKS, limit, after);
    case "logbook":
      return logbookSitemapWindowStatement(limit, after);
    case "tracks":
      return trackSitemapWindowStatement(limit, after);
  }
}

type TrackRow = {
  added_at: string;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  lastmod: string;
  log_id: string;
  note: string | null;
  title: string;
  video_url: string | null;
};

type MixtapeRow = {
  lastmod: string;
  log_id: string;
  note: string | null;
  set_video_at: string | null;
  title: string;
};

function trackPage(row: TrackRow): SitemapLogPage {
  const logId = row.log_id;
  const media = trackMedia(logId);
  const artists = parseArtistsJson(row.artists_json);
  // Google Images cover: the Spotify album art (full size), falling back to the
  // rendered cover.jpg — mirrors the /log og:image choice, always a real URL.
  const imageLoc = albumCoverAtSize(row.album_image_url ?? undefined, "large") ?? media.coverUrl;

  if (!row.video_url) {
    return { imageLoc, lastmod: row.lastmod, logId };
  }

  const title = artistTitleLine({ artists, title: row.title });
  // The operator note is the richest description; fall back to the same
  // definitional line the page's meta description uses (never empty — a
  // video:description is required, and an empty one fails Google's validator).
  const description = row.note?.trim()
    ? row.note.trim()
    : definitionalSentences({
        addedAt: row.added_at,
        artists,
        bpm: row.bpm ?? undefined,
        logId,
        title: row.title,
      });

  return {
    imageLoc,
    lastmod: row.lastmod,
    logId,
    video: {
      // The cover.jpg is the canonical video loading still (see lib/media.ts).
      contentLoc: media.videoUrl,
      description,
      thumbnailLoc: media.coverUrl,
      title,
    },
  };
}

// A published mixtape: its cover for Google Images, plus a `<video:video>` block
// when the full set video is live (setVideoAt) — parity with finding footage, so
// the set recording is crawlable, not just a plain <loc>.
function mixtapePage(row: MixtapeRow): SitemapLogPage {
  const logId = row.log_id;
  const imageLoc = mixtapeCoverUrl(logId, "card");

  if (!row.set_video_at) {
    return { imageLoc, lastmod: row.lastmod, logId };
  }

  return {
    imageLoc,
    lastmod: row.lastmod,
    logId,
    video: {
      contentLoc: mixtapeSetVideoUrl(logId),
      description: row.note?.trim()
        ? row.note.trim()
        : `Fluncle drum & bass mixtape: ${row.title}.`,
      thumbnailLoc: mixtapeCoverUrl(logId, "card"),
      title: row.title,
    },
  };
}

// ── ONE BAG AT A TIME ────────────────────────────────────────────────────────────────────
//
// Each reader below is exactly one child sitemap's rows. They are separate functions rather than
// one omnibus because each child reads exactly its own bag. `/sitemap.xml` is a ~1KB INDEX
// carrying no `<url>` at all, so it reads only aggregate counts and timestamps.

/** Every `/log/<coordinate>` page: the certified findings, then the published mixtapes. */
async function readLogPages(): Promise<SitemapLogPage[]> {
  const db = await getDb();
  const [trackResult, mixtapeResult] = await Promise.all([
    // lastmod = freshest of (video_squared_at, updated_at, added_at). added_at
    // is NOT NULL, and ISO strings sort lexicographically, so coalescing the
    // nullable two to '' keeps max() honest (scalar max() returns NULL on any
    // NULL arg) and a just-squared video lifts the finding's lastmod.
    db.execute({
      sql: `select log_id, title, artists_json, note, bpm, album_image_url, video_url,
                   findings.added_at,
                   max(coalesce(findings.video_squared_at, ''),
                       coalesce(findings.updated_at, ''),
                       findings.added_at) as lastmod
            from findings cross join tracks on tracks.track_id = findings.track_id
            where findings.log_id is not null`,
    }),
    db.execute({
      sql: `select log_id, title, note, set_video_at,
                   max(coalesce(set_video_at, ''), coalesce(updated_at, ''), added_at) as lastmod
            from mixtapes
            where status = 'published' and log_id is not null and added_at is not null
            order by lastmod desc`,
    }),
  ]);

  const trackPages = typedRows<TrackRow>(trackResult.rows)
    .map(trackPage)
    .sort((left, right) => {
      if (left.lastmod !== right.lastmod) {
        return left.lastmod < right.lastmod ? 1 : -1;
      }

      // Match SQLite's default BINARY text order so equal timestamps cannot move rows across a
      // sitemap shard boundary when the engine happens to return the driver in a different order.
      return left.logId < right.logId ? -1 : left.logId > right.logId ? 1 : 0;
    });

  return [...trackPages, ...typedRows<MixtapeRow>(mixtapeResult.rows).map(mixtapePage)];
}

// Thin-content gate: `listArtistSitemapRows` applies the floor IN SQL over RENDERABLE tracks —
// findings PLUS the quieter catalogue rows, the same sum the artist page's `indexable` keys off
// — so a crawler-discovered artist with enough tracks is here and the thin ones (which render
// `noindex, follow`) are not, exactly as labels + albums below.
async function readArtists(window: SitemapWindow): Promise<SitemapArtist[]> {
  return (
    await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS, {
      afterSlug: window.after,
      limit: window.limit,
    })
  ).map((artist) => ({
    imageLoc: albumCoverAtSize(artist.coverImageUrl, "large"),
    lastmod: artist.lastmod,
    slug: artist.slug,
  }));
}

// Thin-content gate, labels + albums: the page indexes past N RENDERABLE tracks — findings
// PLUS the quieter uncertified rows, because both are content on the page and a page is
// thin or not thin on what it RENDERS, never on who wrote it. That gate lives in SQL,
// inside the two reads below, keyed off the very constants the routes' `indexable` uses —
// so a page that says "index me" is always in the sitemap, and one that says `noindex`
// never is. A crawler-discovered label with enough tracks has a real page, and it is here.
async function readLabels(window: SitemapWindow): Promise<SitemapEntity[]> {
  return (
    await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS, {
      afterSlug: window.after,
      limit: window.limit,
    })
  ).map((label) => ({
    imageLoc: albumCoverAtSize(label.coverImageUrl, "large"),
    lastmod: label.lastmod,
    slug: label.slug,
  }));
}

async function readAlbums(window: SitemapWindow): Promise<SitemapEntity[]> {
  return (
    await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS, {
      afterSlug: window.after,
      limit: window.limit,
    })
  ).map((album) => ({
    imageLoc: albumCoverAtSize(album.coverImageUrl, "large"),
    lastmod: album.lastmod,
    slug: album.slug,
  }));
}

/** The logbook travelogue entries — one <loc> per authored sector-day, with its last
    (re)generation as lastmod. */
export function logbookSitemapWindowStatement(limit: number, afterSector?: string) {
  const seek = afterSector === undefined ? "sector <= ?" : "sector < ?";

  return {
    args: [afterSector === undefined ? Number.MAX_SAFE_INTEGER : Number(afterSector), limit],
    sql: `select sector, generated_at from logbook_entries
          where ${seek}
          order by sector desc
          limit ?`,
  };
}

async function readLogbook(window: SitemapWindow): Promise<SitemapLogbookEntry[]> {
  const db = await getDb();
  const result = await db.execute(logbookSitemapWindowStatement(window.limit, window.after));

  return typedRows<{ generated_at: string; sector: number }>(result.rows).map((row) => ({
    lastmod: row.generated_at,
    sector: formatSector(row.sector),
  }));
}

/**
 * The named sonic galaxies — empty until the launch gate opens (browse-by-feel RFC), so no galaxy
 * <loc> leaks before the whole map is named. Thin-content gate on top: only galaxies past
 * GALAXY_INDEX_MIN_FINDINGS enter the sitemap (the thin ones render `noindex, follow`).
 */
async function readGalaxies(): Promise<SitemapGalaxy[]> {
  return (await listPublicGalaxies())
    .filter((galaxy) => galaxy.memberCount >= GALAXY_INDEX_MIN_FINDINGS)
    .map((galaxy) => ({ slug: galaxy.slug }));
}

/** The developer docs: a static list, not a read (see lib/docs-pages.ts — the MDX collection
    cannot be resolved from a module the tests exercise, so a parity test guards the list). */
function readDocs(): SitemapDoc[] {
  return DOCS_PAGES.map((path) => ({ path }));
}

// ── THE AGGREGATES ───────────────────────────────────────────────────────────────────────
//
// The index needs one number and one date per bag, and the `pages` child needs two dates and two
// gates. Both are answered by these small `count(*)` / `max()` reads, aggregated IN SQL — never by
// pulling a bag into the isolate and counting it there (AGENTS.md / docs/local-database.md: rank
// and aggregate in SQL, and never trust the local DB for the shape of either).

/** The freshest of a handful of maybe-dates. ISO strings sort lexicographically. */
function freshest(dates: (string | undefined)[]): string | undefined {
  return dates
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

/** The `findings` child's size and date: the certified findings and the published mixtapes,
    counted and dated where {@link readLogPages} would have listed them. */
async function readLogKindStats(): Promise<SitemapKindStats> {
  const db = await getDb();
  // Two counted/dated reads over the CERTIFIED corpus, mirroring `readLogPages` clause for clause
  // (the same `where`, the same lastmod expression) so the index cannot promise a child a
  // different size than it serves. The outer one-argument `max()` is the AGGREGATE over the rows;
  // the inner three-argument one is the scalar per-row freshest — the same nesting the row read
  // does per row, folded into a single pass here.
  const [findingResult, mixtapeResult] = await Promise.all([
    db.execute({
      sql: `select count(*) as n,
                   max(max(coalesce(findings.video_squared_at, ''),
                           coalesce(findings.updated_at, ''),
                           findings.added_at)) as lastmod
            from findings cross join tracks on tracks.track_id = findings.track_id
            where findings.log_id is not null`,
    }),
    db.execute({
      sql: `select count(*) as n,
                   max(max(coalesce(set_video_at, ''), coalesce(updated_at, ''), added_at)) as lastmod
            from mixtapes
            where status = 'published' and log_id is not null and added_at is not null`,
    }),
  ]);

  type CountedRow = { lastmod: string | null; n: number };
  const findings = typedRows<CountedRow>(findingResult.rows)[0];
  const mixtapes = typedRows<CountedRow>(mixtapeResult.rows)[0];

  return {
    count: Number(findings?.n ?? 0) + Number(mixtapes?.n ?? 0),
    lastmod: freshest([findings?.lastmod ?? undefined, mixtapes?.lastmod ?? undefined]),
  };
}

/** `count(*)` + `max(generated_at)` over the logbook — the child's size and date in one read. */
async function readLogbookKindStats(): Promise<SitemapKindStats> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select count(*) as n, max(generated_at) as lastmod from logbook_entries`,
  });
  const row = typedRows<{ lastmod: string | null; n: number }>(result.rows)[0];

  return { count: Number(row?.n ?? 0), lastmod: row?.lastmod ?? undefined };
}

/** Every counted/dated child, plus the two gates — the whole aggregate pass, run once. */
type SitemapAggregates = {
  albums: SitemapKindStats;
  artists: SitemapKindStats;
  /** Archive-track destinations past the evidence gate. Only the SIZE — a track entry is undated. */
  archiveTrackCount: number;
  /** Named galaxies past the thin-content floor. Only the SIZE matters; a lens page has no date. */
  galaxyCount: number;
  labels: SitemapKindStats;
  logbook: SitemapKindStats;
  /** The `/log` pages: findings AND published mixtapes, counted and dated together. */
  logs: SitemapKindStats;
  mixOpen: boolean;
};

type SitemapPageInputs = Pick<SitemapAggregates, "galaxyCount" | "logbook" | "logs" | "mixOpen"> & {
  albumLastmod: string | undefined;
  artistLastmod: string | undefined;
  labelLastmod: string | undefined;
};

/** Static hub URLs need dates and launch gates, never the catalogue's cardinality. */
async function readSitemapPageInputs(): Promise<SitemapPageInputs> {
  const [logs, artistLastmod, labelLastmod, albumLastmod, logbook, galaxyCount, mixDepth] =
    await Promise.all([
      readLogKindStats(),
      maxArtistSitemapLastmod(ARTIST_INDEX_MIN_FINDINGS),
      maxLabelSitemapLastmod(LABEL_INDEX_MIN_TRACKS),
      maxAlbumSitemapLastmod(ALBUM_INDEX_MIN_TRACKS),
      readLogbookKindStats(),
      countPublicIndexableGalaxies(GALAXY_INDEX_MIN_FINDINGS),
      getMixChainDepth(),
    ]);
  return {
    albumLastmod,
    artistLastmod,
    galaxyCount,
    labelLastmod,
    logbook,
    logs,
    mixOpen: mixDepth.open,
  };
}

/**
 * ONE aggregate pass over the archive: a count and a date per child, plus the two self-lifting
 * gates. Every read in it is a `count(*)` or a `max()` — nothing here pulls a row set into the
 * isolate to size it (AGENTS.md), and they all go out in parallel.
 *
 * The three ENTITY counts read the STORED `renderable_track_count` through the same
 * `countIndexableHubEntities` gate `/admin/funnel` uses — an index range scan on
 * `<entity>_renderable_count_idx` — so the index, the funnel card and the children cannot drift
 * apart on what "indexable" means. The three entity DATES are driven from `findings` OUTWARD (see
 * `maxLabelSitemapLastmod`), bounded by the certified corpus rather than by the growing tables.
 */
async function readSitemapAggregates(): Promise<SitemapAggregates> {
  const [pageInputs, artistCount, labelCount, albumCount, archiveTrackCount] = await Promise.all([
    readSitemapPageInputs(),
    countIndexableArtists(),
    countIndexableLabels(),
    countIndexableAlbums(),
    // The archive-track destinations past the EVIDENCE gate. A `count(*)` whose predicate leads
    // with `is_catalogue = 1`, so it rides the partial catalogue index rather than walking the
    // whole growing table (lib/server/track-page.ts).
    countIndexableTrackPages(),
  ]);

  return {
    albums: { count: albumCount, lastmod: pageInputs.albumLastmod },
    archiveTrackCount,
    artists: { count: artistCount, lastmod: pageInputs.artistLastmod },
    galaxyCount: pageInputs.galaxyCount,
    labels: { count: labelCount, lastmod: pageInputs.labelLastmod },
    logbook: pageInputs.logbook,
    logs: pageInputs.logs,
    mixOpen: pageInputs.mixOpen,
  };
}

/**
 * The `pages` child's inputs. `latest` is the freshest date anywhere in the archive, so it is the
 * max of the five dated bags' own maxima, without enumerating their URLs.
 */
function sitemapPagesFrom(aggregates: SitemapPageInputs): SitemapPages {
  return {
    galaxiesOpen: aggregates.galaxyCount > 0,
    latest: freshest([
      aggregates.logs.lastmod,
      aggregates.artistLastmod,
      aggregates.logbook.lastmod,
      aggregates.labelLastmod,
      aggregates.albumLastmod,
    ]),
    logbookLatest: aggregates.logbook.lastmod,
    mixOpen: aggregates.mixOpen,
  };
}

/**
 * Everything `/sitemap.xml` needs, and nothing more: a count and a date per child.
 *
 * ── WHY IT IS NOT `collectSitemapBag` EIGHT TIMES ────────────────────────────────────────
 * The index carries no `<url>`. Deriving ~eight `<sitemap>` lines by fetching every URL they
 * point at is the shape that made a ~1KB document answer in seconds and grow with the catalogue
 * — and it is the shape that timed the post-deploy surface sweep out. Each line is a `count(*)`
 * and a `max()` now. `sitemap-data.integration.test.ts` pins the whole result against
 * `sitemapIndexStatsFromBags` over the real rows, so the cheap read can never quietly promise a
 * different index than the children serve.
 */
export async function collectSitemapIndexStats(): Promise<SitemapIndexStats> {
  const aggregates = await readSitemapAggregates();

  return {
    albums: aggregates.albums,
    artists: aggregates.artists,
    // The MDX carries no per-page timestamp, so the docs child is honestly undated — as is the
    // galaxies child, whose lens pages date their own members' /log entries instead.
    docs: { count: readDocs().length },
    findings: aggregates.logs,
    galaxies: { count: aggregates.galaxyCount },
    labels: aggregates.labels,
    logbook: aggregates.logbook,
    pages: sitemapPagesStats(
      sitemapPagesFrom({
        ...aggregates,
        albumLastmod: aggregates.albums.lastmod,
        artistLastmod: aggregates.artists.lastmod,
        labelLastmod: aggregates.labels.lastmod,
      }),
    ),
    // Honestly undated, like `docs` and `galaxies`: `tracks` carries no content-change timestamp,
    // and a release date is a different claim (lib/sitemap.ts § SitemapTrack).
    tracks: { count: aggregates.archiveTrackCount },
  };
}

async function sitemapWindowCount(kind: SitemapSqlWindowedKind): Promise<number> {
  switch (kind) {
    case "albums":
      return countIndexableAlbums();
    case "artists":
      return countIndexableArtists();
    case "labels":
      return countIndexableLabels();
    case "logbook":
      return (await readLogbookKindStats()).count;
    case "tracks":
      return countIndexableTrackPages();
  }
}

async function readSitemapBoundary(
  kind: SitemapSqlWindowedKind,
  limit: number,
  after?: string,
): Promise<{ boundary: string | undefined; count: number }> {
  const db = await getDb();
  const result = await db.execute(sitemapBoundaryStatement(kind, limit, after));
  const row = typedRows<{ boundary: number | string | null; n: number }>(result.rows)[0];

  return {
    boundary:
      row?.boundary === null || row?.boundary === undefined ? undefined : String(row.boundary),
    count: Number(row?.n ?? 0),
  };
}

/**
 * Resolve a numbered child to the exact key immediately before it. Every request derives the
 * boundary from the current corpus as fixed-size keyset seeks. Reusing a persisted boundary would
 * be incorrect after a same-cardinality interior membership change: count and first-key
 * fingerprints cannot detect that shift. No request pays a growing OFFSET or transfers a
 * preceding page's rows into the isolate.
 */
async function resolveSitemapWindow(
  kind: SitemapSqlWindowedKind,
  page: number,
  pageSize: number,
): Promise<{ after?: string; pastEnd: boolean }> {
  if (page < 1 || pageSize < 1) {
    return { pastEnd: true };
  }

  if (page === 1) {
    return { pastEnd: false };
  }

  const total = await sitemapWindowCount(kind);

  if ((page - 1) * pageSize >= total) {
    return { pastEnd: true };
  }

  let after: string | undefined;
  let currentPage = 1;

  while (currentPage < page) {
    const boundary = await readSitemapBoundary(kind, pageSize, after);

    if (boundary.count < pageSize || boundary.boundary === undefined) {
      return { pastEnd: true };
    }

    after = boundary.boundary;
    currentPage += 1;
  }

  return { after, pastEnd: false };
}

/**
 * ONE child sitemap's bag — the rows `/sitemap/<kind>-<n>.xml` slices, and no other kind's.
 * Every other bag comes back empty, which is exactly what `buildSitemapShardXml` reads for that
 * kind, so a child serves precisely what it always did at one bag's cost instead of seven.
 *
 * The slug-ordered entity tables, sector-ordered logbook, and track-id-ordered archive all return
 * exactly one SQL window. Their bags are listed in `SITEMAP_SQL_WINDOWED_KINDS`, so the builder
 * renders them without a second slice. Findings retain their two-table concatenated order and
 * galaxies retain their derived member-count order; neither has an existing index that can serve
 * that order, so the no-migration sitemap contract keeps those bounded bags in memory.
 */
export async function collectSitemapBag(
  kind: SitemapKind,
  page = 1,
  pageSize = sitemapMaxUrls(kind),
): Promise<SitemapBags> {
  switch (kind) {
    case "albums": {
      const window = await resolveSitemapWindow("albums", page, pageSize);
      return {
        ...EMPTY_SITEMAP_BAGS,
        albums: window.pastEnd ? [] : await readAlbums({ after: window.after, limit: pageSize }),
      };
    }

    case "artists": {
      const window = await resolveSitemapWindow("artists", page, pageSize);
      return {
        ...EMPTY_SITEMAP_BAGS,
        artists: window.pastEnd ? [] : await readArtists({ after: window.after, limit: pageSize }),
      };
    }

    case "docs":
      return { ...EMPTY_SITEMAP_BAGS, docs: readDocs() };

    case "findings":
      return { ...EMPTY_SITEMAP_BAGS, logs: await readLogPages() };

    case "galaxies":
      return { ...EMPTY_SITEMAP_BAGS, galaxies: await readGalaxies() };

    case "labels": {
      const window = await resolveSitemapWindow("labels", page, pageSize);
      return {
        ...EMPTY_SITEMAP_BAGS,
        labels: window.pastEnd ? [] : await readLabels({ after: window.after, limit: pageSize }),
      };
    }

    case "logbook": {
      const window = await resolveSitemapWindow("logbook", page, pageSize);
      return {
        ...EMPTY_SITEMAP_BAGS,
        logbook: window.pastEnd ? [] : await readLogbook({ after: window.after, limit: pageSize }),
      };
    }

    // The static child needs no rows at all — its `<loc>`s are constants and its two `<lastmod>`s
    // are the same aggregates the index reads.
    case "pages":
      return { ...EMPTY_SITEMAP_BAGS, pages: sitemapPagesFrom(await readSitemapPageInputs()) };

    case "tracks": {
      const window = await resolveSitemapWindow("tracks", page, pageSize);
      return {
        ...EMPTY_SITEMAP_BAGS,
        tracks: window.pastEnd ? [] : await listTrackSitemapRows(pageSize, window.after),
      };
    }
  }
}

/**
 * The sitemap documents' headers. The directive is the EDGE policy's own
 * ({@link SITEMAP_CACHE_POLICY}), stated once: `server.ts` serves these paths through
 * `withEdgeCache`, which stamps the same string on a hit, so origin and edge can never disagree
 * about how long a crawler may hold a sitemap. Shared by the index and its children, so a child is
 * never fresher than the index that pointed at it.
 */
export const SITEMAP_HEADERS = {
  "Cache-Control": SITEMAP_CACHE_POLICY.cacheControl,
  "Content-Type": "application/xml; charset=utf-8",
} as const;

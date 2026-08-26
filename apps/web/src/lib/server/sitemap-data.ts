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
  sitemapPagesStats,
} from "../sitemap";
import {
  ALBUM_INDEX_MIN_TRACKS,
  countIndexableAlbums,
  listAlbumSitemapRows,
  maxAlbumSitemapLastmod,
} from "./albums";
import {
  ARTIST_INDEX_MIN_FINDINGS,
  countIndexableArtists,
  listArtistSitemapRows,
  maxArtistSitemapLastmod,
  parseArtistsJson,
} from "./artists";
import { getDb, typedRows } from "./db";
import { GALAXY_INDEX_MIN_FINDINGS, listPublicGalaxies } from "./galaxies-map";
import {
  countIndexableLabels,
  LABEL_INDEX_MIN_TRACKS,
  listLabelSitemapRows,
  maxLabelSitemapLastmod,
} from "./labels";
import { SITEMAP_CACHE_POLICY } from "./edge-cache";
import { getMixChainDepth } from "./tracks";

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
    .sort((left, right) => right.lastmod.localeCompare(left.lastmod));

  return [...trackPages, ...typedRows<MixtapeRow>(mixtapeResult.rows).map(mixtapePage)];
}

// Thin-content gate: `listArtistSitemapRows` applies the floor IN SQL over RENDERABLE tracks —
// findings PLUS the quieter catalogue rows, the same sum the artist page's `indexable` keys off
// — so a crawler-discovered artist with enough tracks is here and the thin ones (which render
// `noindex, follow`) are not, exactly as labels + albums below.
async function readArtists(): Promise<SitemapArtist[]> {
  return (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((artist) => ({
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
async function readLabels(): Promise<SitemapEntity[]> {
  return (await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS)).map((label) => ({
    imageLoc: albumCoverAtSize(label.coverImageUrl, "large"),
    lastmod: label.lastmod,
    slug: label.slug,
  }));
}

async function readAlbums(): Promise<SitemapEntity[]> {
  return (await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS)).map((album) => ({
    imageLoc: albumCoverAtSize(album.coverImageUrl, "large"),
    lastmod: album.lastmod,
    slug: album.slug,
  }));
}

/** The logbook travelogue entries — one <loc> per authored sector-day, with its last
    (re)generation as lastmod. */
async function readLogbook(): Promise<SitemapLogbookEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select sector, generated_at from logbook_entries order by sector desc`,
  });

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
  /** Named galaxies past the thin-content floor. Only the SIZE matters; a lens page has no date. */
  galaxyCount: number;
  labels: SitemapKindStats;
  logbook: SitemapKindStats;
  /** The `/log` pages: findings AND published mixtapes, counted and dated together. */
  logs: SitemapKindStats;
  mixOpen: boolean;
};

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
  const [
    logs,
    artistCount,
    artistLastmod,
    labelCount,
    labelLastmod,
    albumCount,
    albumLastmod,
    logbook,
    galaxies,
    mixDepth,
  ] = await Promise.all([
    readLogKindStats(),
    countIndexableArtists(),
    maxArtistSitemapLastmod(ARTIST_INDEX_MIN_FINDINGS),
    countIndexableLabels(),
    maxLabelSitemapLastmod(LABEL_INDEX_MIN_TRACKS),
    countIndexableAlbums(),
    maxAlbumSitemapLastmod(ALBUM_INDEX_MIN_TRACKS),
    readLogbookKindStats(),
    readGalaxies(),
    // The `/mix` gate — the SAME self-lifting verdict its route checks on every load
    // (`getMixChainDepth().open`), memoized per-isolate, so the sitemap lists the hub the day
    // the tool opens to the world and drops it the day it would close, with no deploy.
    getMixChainDepth(),
  ]);

  return {
    albums: { count: albumCount, lastmod: albumLastmod },
    artists: { count: artistCount, lastmod: artistLastmod },
    galaxyCount: galaxies.length,
    labels: { count: labelCount, lastmod: labelLastmod },
    logbook,
    logs,
    mixOpen: mixDepth.open,
  };
}

/**
 * The `pages` child's inputs. `latest` is the freshest date anywhere in the archive, so it is the
 * max of the five dated bags' own maxima — each already an aggregate, never a scan.
 */
function sitemapPagesFrom(aggregates: SitemapAggregates): SitemapPages {
  return {
    galaxiesOpen: aggregates.galaxyCount > 0,
    latest: freshest([
      aggregates.logs.lastmod,
      aggregates.artists.lastmod,
      aggregates.logbook.lastmod,
      aggregates.labels.lastmod,
      aggregates.albums.lastmod,
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
    pages: sitemapPagesStats(sitemapPagesFrom(aggregates)),
  };
}

/**
 * ONE child sitemap's bag — the rows `/sitemap/<kind>-<n>.xml` slices, and no other kind's.
 * Every other bag comes back empty, which is exactly what `buildSitemapShardXml` reads for that
 * kind, so a child serves precisely what it always did at one bag's cost instead of seven.
 */
export async function collectSitemapBag(kind: SitemapKind): Promise<SitemapBags> {
  switch (kind) {
    case "albums":
      return { ...EMPTY_SITEMAP_BAGS, albums: await readAlbums() };

    case "artists":
      return { ...EMPTY_SITEMAP_BAGS, artists: await readArtists() };

    case "docs":
      return { ...EMPTY_SITEMAP_BAGS, docs: readDocs() };

    case "findings":
      return { ...EMPTY_SITEMAP_BAGS, logs: await readLogPages() };

    case "galaxies":
      return { ...EMPTY_SITEMAP_BAGS, galaxies: await readGalaxies() };

    case "labels":
      return { ...EMPTY_SITEMAP_BAGS, labels: await readLabels() };

    case "logbook":
      return { ...EMPTY_SITEMAP_BAGS, logbook: await readLogbook() };

    // The static child needs no rows at all — its `<loc>`s are constants and its two `<lastmod>`s
    // are the same aggregates the index reads.
    case "pages":
      return { ...EMPTY_SITEMAP_BAGS, pages: sitemapPagesFrom(await readSitemapAggregates()) };
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

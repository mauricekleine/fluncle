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
  shardPath,
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
import { listedArtistWhere } from "./artist-visibility";
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
import { purgePathsNow, SITEMAP_CACHE_POLICY } from "./edge-cache";
import {
  countIndexableTrackPages,
  listTrackSitemapRows,
  trackSitemapWindowStatement,
  TRACK_PAGE_INDEXABLE_WHERE,
} from "./track-page";
import { getMixChainDepth } from "./tracks";
type SitemapWindow = { after?: string; limit: number };

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
                  and ${listedArtistWhere("artists")}
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
  const imageLoc = albumCoverAtSize(row.album_image_url ?? undefined, "large") ?? media.coverUrl;

  if (!row.video_url) {
    return { imageLoc, lastmod: row.lastmod, logId };
  }

  const title = artistTitleLine({ artists, title: row.title });
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
      contentLoc: media.videoUrl,
      description,
      thumbnailLoc: media.coverUrl,
      title,
    },
  };
}

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

async function readLogPages(): Promise<SitemapLogPage[]> {
  const db = await getDb();
  const [trackResult, mixtapeResult] = await Promise.all([
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

      return left.logId < right.logId ? -1 : left.logId > right.logId ? 1 : 0;
    });

  return [...trackPages, ...typedRows<MixtapeRow>(mixtapeResult.rows).map(mixtapePage)];
}

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

function logbookSitemapWindowStatement(limit: number, afterSector?: string) {
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

async function readGalaxies(): Promise<SitemapGalaxy[]> {
  return (await listPublicGalaxies())
    .filter((galaxy) => galaxy.memberCount >= GALAXY_INDEX_MIN_FINDINGS)
    .map((galaxy) => ({ slug: galaxy.slug }));
}

function readDocs(): SitemapDoc[] {
  return DOCS_PAGES.map((path) => ({ path }));
}

function freshest(dates: (string | undefined)[]): string | undefined {
  return dates
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

async function readLogKindStats(): Promise<SitemapKindStats> {
  const db = await getDb();
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

async function readLogbookKindStats(): Promise<SitemapKindStats> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select count(*) as n, max(generated_at) as lastmod from logbook_entries`,
  });
  const row = typedRows<{ lastmod: string | null; n: number }>(result.rows)[0];

  return { count: Number(row?.n ?? 0), lastmod: row?.lastmod ?? undefined };
}

type SitemapAggregates = {
  albums: SitemapKindStats;
  artists: SitemapKindStats;
  archiveTrackCount: number;
  galaxyCount: number;
  labels: SitemapKindStats;
  logbook: SitemapKindStats;
  logs: SitemapKindStats;
  mixOpen: boolean;
};

type SitemapPageInputs = Pick<SitemapAggregates, "galaxyCount" | "logbook" | "logs" | "mixOpen"> & {
  albumLastmod: string | undefined;
  artistLastmod: string | undefined;
  labelLastmod: string | undefined;
};

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

async function readSitemapAggregates(): Promise<SitemapAggregates> {
  const [pageInputs, artistCount, labelCount, albumCount, archiveTrackCount] = await Promise.all([
    readSitemapPageInputs(),
    countIndexableArtists(),
    countIndexableLabels(),
    countIndexableAlbums(),
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

export async function purgeArtistSitemapCachesNow(): Promise<void> {
  const total = await countIndexableArtists();
  const shards = Math.max(1, Math.ceil(total / sitemapMaxUrls("artists")));
  const paths = ["/sitemap.xml"];

  for (let page = 1; page <= shards; page += 1) {
    paths.push(shardPath("artists", page));
  }

  await purgePathsNow(paths);
}

export async function collectSitemapIndexStats(): Promise<SitemapIndexStats> {
  const aggregates = await readSitemapAggregates();

  return {
    albums: aggregates.albums,
    artists: aggregates.artists,
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

export const SITEMAP_HEADERS = {
  "Cache-Control": SITEMAP_CACHE_POLICY.cacheControl,
  "Content-Type": "application/xml; charset=utf-8",
} as const;

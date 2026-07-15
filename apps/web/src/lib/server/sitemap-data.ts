// Everything `/sitemap.xml` (the index) and `/sitemap/<kind>-<n>.xml` (the children) know,
// gathered in one place so the two can never disagree about what exists.
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

import { formatSector } from "../log-id-shared";
import { mixtapeSetVideoUrl, albumCoverAtSize, trackMedia } from "../media";
import { mixtapeCoverUrl } from "../mixtapes";
import { artistTitleLine, definitionalSentences } from "../log-prose";
import {
  type SitemapArtist,
  type SitemapBags,
  type SitemapEntity,
  type SitemapGalaxy,
  type SitemapLogbookEntry,
  type SitemapLogPage,
} from "../sitemap";
import { ALBUM_INDEX_MIN_TRACKS, listAlbumSitemapRows } from "./albums";
import { ARTIST_INDEX_MIN_FINDINGS, listArtistSitemapRows, parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { GALAXY_INDEX_MIN_FINDINGS, listPublicGalaxies } from "./galaxies-map";
import { LABEL_INDEX_MIN_TRACKS, listLabelSitemapRows } from "./labels";

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

/**
 * Every URL the sitemap can list, gathered once. Seven bounded reads, run in parallel; the
 * index route counts and dates them, a child route slices one bag.
 */
export async function collectSitemapBags(): Promise<SitemapBags> {
  const db = await getDb();
  const [
    trackResult,
    mixtapeResult,
    artistEntries,
    logbookResult,
    galaxyEntries,
    labelEntries,
    albumEntries,
  ] = await Promise.all([
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
            from findings join tracks on tracks.track_id = findings.track_id
            where findings.log_id is not null
            order by lastmod desc`,
    }),
    db.execute({
      sql: `select log_id, title, note, set_video_at,
                   max(coalesce(set_video_at, ''), coalesce(updated_at, ''), added_at) as lastmod
            from mixtapes
            where status = 'published' and log_id is not null and added_at is not null
            order by lastmod desc`,
    }),
    listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS),
    // The logbook travelogue entries — one <loc> per authored sector-day, with
    // its last (re)generation as lastmod.
    db.execute({
      sql: `select sector, generated_at from logbook_entries order by sector desc`,
    }),
    // The named sonic galaxies — empty until the launch gate opens (browse-by-
    // feel RFC), so no galaxy <loc> leaks before the whole map is named.
    listPublicGalaxies(),
    // The graph pages. All three reads apply the thin-content floor IN SQL and return exactly the
    // entities whose page is indexable — findings or no findings, because a graph page now exists
    // on crawled content alone and orphaning those pages from the sitemap would break the
    // invariant this file exists to hold.
    listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS),
    listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS),
  ]);

  const logbook: SitemapLogbookEntry[] = typedRows<{
    generated_at: string;
    sector: number;
  }>(logbookResult.rows).map((row) => ({
    lastmod: row.generated_at,
    sector: formatSector(row.sector),
  }));
  // Thin-content gate: `listArtistSitemapRows` applies the floor IN SQL over RENDERABLE tracks —
  // findings PLUS the quieter catalogue rows, the same sum the artist page's `indexable` keys off
  // — so a crawler-discovered artist with enough tracks is here and the thin ones (which render
  // `noindex, follow`) are not, exactly as labels + albums below.
  const artists: SitemapArtist[] = artistEntries.map((artist) => ({
    imageLoc: albumCoverAtSize(artist.coverImageUrl, "large"),
    lastmod: artist.lastmod,
    slug: artist.slug,
  }));
  // Thin-content gate: only galaxies past GALAXY_INDEX_MIN_FINDINGS enter the
  // sitemap (the thin ones render `noindex, follow`). `galaxyEntries` is already
  // empty behind the launch gate, so this stays dark until the map is fully named.
  const galaxies: SitemapGalaxy[] = galaxyEntries
    .filter((galaxy) => galaxy.memberCount >= GALAXY_INDEX_MIN_FINDINGS)
    .map((galaxy) => ({ slug: galaxy.slug }));
  // Thin-content gate, labels + albums: the page indexes past N RENDERABLE tracks — findings
  // PLUS the quieter uncertified rows, because both are content on the page and a page is
  // thin or not thin on what it RENDERS, never on who wrote it. That gate now lives in SQL,
  // inside the two reads above, keyed off the very constants the routes' `indexable` uses —
  // so a page that says "index me" is always in the sitemap, and one that says `noindex`
  // never is. A crawler-discovered label with enough tracks has a real page, and it is here.
  const labels: SitemapEntity[] = labelEntries.map((label) => ({
    imageLoc: albumCoverAtSize(label.coverImageUrl, "large"),
    lastmod: label.lastmod,
    slug: label.slug,
  }));
  const albums: SitemapEntity[] = albumEntries.map((album) => ({
    imageLoc: albumCoverAtSize(album.coverImageUrl, "large"),
    lastmod: album.lastmod,
    slug: album.slug,
  }));

  return {
    albums,
    artists,
    galaxies,
    labels,
    logbook,
    logs: [
      ...typedRows<TrackRow>(trackResult.rows).map(trackPage),
      ...typedRows<MixtapeRow>(mixtapeResult.rows).map(mixtapePage),
    ],
  };
}

/**
 * The crawl cadence tolerates more staleness than the feeds: a longer CDN hold, with SWR
 * keeping every repeat crawl free during a refresh. Shared by the index and its children so
 * a child is never fresher than the index that pointed at it.
 */
export const SITEMAP_HEADERS = {
  "Cache-Control": "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
  "Content-Type": "application/xml; charset=utf-8",
} as const;

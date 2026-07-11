import { createFileRoute } from "@tanstack/react-router";
import { artistTitleLine, definitionalSentences } from "../lib/log-prose";
import { mixtapeSetVideoUrl, spotifyAlbumImageAtSize, trackMedia } from "../lib/media";
import { mixtapeCoverUrl } from "../lib/mixtapes";
import { formatSector } from "../lib/log-id-shared";
import {
  buildSitemapXml,
  type SitemapArtist,
  type SitemapGalaxy,
  type SitemapLogbookEntry,
  type SitemapLogPage,
} from "../lib/sitemap";
import {
  ARTIST_INDEX_MIN_FINDINGS,
  listArtistsWithFindingCounts,
  parseArtistsJson,
} from "../lib/server/artists";
import { GALAXY_INDEX_MIN_FINDINGS, listPublicGalaxies } from "../lib/server/galaxies-map";
import { getDb, typedRows } from "../lib/server/db";

// One <url> per coordinate-bearing finding (plus the static surfaces). Each
// finding carries an <image:image> cover for Google Images, and a finding with a
// rendered video also carries a Google video-sitemap <video:video> block — so the
// 47 videos and the covers are crawlable, not just plain <loc>s (lib/sitemap.ts).
// lastmod is the finding's freshest real timestamp (a fresh video bumps it and
// prompts a re-crawl).

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
  const imageLoc =
    spotifyAlbumImageAtSize(row.album_image_url ?? undefined, "large") ?? media.coverUrl;

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

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const [trackResult, mixtapeResult, artistEntries, logbookResult, galaxyEntries] =
          await Promise.all([
            // lastmod = freshest of (video_squared_at, updated_at, added_at). added_at
            // is NOT NULL, and ISO strings sort lexicographically, so coalescing the
            // nullable two to '' keeps max() honest (scalar max() returns NULL on any
            // NULL arg) and a just-squared video lifts the finding's lastmod.
            db.execute({
              sql: `select log_id, title, artists_json, note, bpm, album_image_url, video_url,
                         added_at,
                         max(coalesce(video_squared_at, ''), coalesce(updated_at, ''), added_at) as lastmod
                  from tracks
                  where log_id is not null
                  order by lastmod desc`,
            }),
            db.execute({
              sql: `select log_id, title, note, set_video_at,
                         max(coalesce(set_video_at, ''), coalesce(updated_at, ''), added_at) as lastmod
                  from mixtapes
                  where status = 'published' and log_id is not null and added_at is not null
                  order by lastmod desc`,
            }),
            listArtistsWithFindingCounts(),
            // The logbook travelogue entries — one <loc> per authored sector-day, with
            // its last (re)generation as lastmod.
            db.execute({
              sql: `select sector, generated_at from logbook_entries order by sector desc`,
            }),
            // The named sonic galaxies — empty until the launch gate opens (browse-by-
            // feel RFC), so no galaxy <loc> leaks before the whole map is named.
            listPublicGalaxies(),
          ]);

        const trackPages = typedRows<TrackRow>(trackResult.rows).map(trackPage);
        const mixtapePages = typedRows<MixtapeRow>(mixtapeResult.rows).map(mixtapePage);
        const logbookPages: SitemapLogbookEntry[] = typedRows<{
          generated_at: string;
          sector: number;
        }>(logbookResult.rows).map((row) => ({
          lastmod: row.generated_at,
          sector: formatSector(row.sector),
        }));
        // Thin-content gate: only artists past ARTIST_INDEX_MIN_FINDINGS enter the
        // sitemap (the thin ones render `noindex, follow`).
        const artistPages: SitemapArtist[] = artistEntries
          .filter((artist) => artist.findingCount >= ARTIST_INDEX_MIN_FINDINGS)
          .map((artist) => ({
            imageLoc: spotifyAlbumImageAtSize(artist.coverImageUrl, "large"),
            lastmod: artist.lastmod,
            slug: artist.slug,
          }));
        // Thin-content gate: only galaxies past GALAXY_INDEX_MIN_FINDINGS enter the
        // sitemap (the thin ones render `noindex, follow`). `galaxyEntries` is already
        // empty behind the launch gate, so this stays dark until the map is fully named.
        const galaxyPages: SitemapGalaxy[] = galaxyEntries
          .filter((galaxy) => galaxy.memberCount >= GALAXY_INDEX_MIN_FINDINGS)
          .map((galaxy) => ({ slug: galaxy.slug }));
        const xml = buildSitemapXml(
          [...trackPages, ...mixtapePages],
          artistPages,
          logbookPages,
          galaxyPages,
        );

        return new Response(xml, {
          headers: {
            // The crawl cadence tolerates more staleness than the feeds: a longer
            // CDN hold, with SWR keeping every repeat crawl free during a refresh.
            "Cache-Control": "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
            "Content-Type": "application/xml; charset=utf-8",
          },
        });
      },
    },
  },
});

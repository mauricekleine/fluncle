import { createFileRoute } from "@tanstack/react-router";
import { artistTitleLine, definitionalSentences } from "../lib/log-prose";
import { mixtapeSetVideoUrl, spotifyAlbumImageAtSize, trackMedia } from "../lib/media";
import { mixtapeCoverUrl } from "../lib/mixtapes";
import { buildSitemapXml, type SitemapLogPage } from "../lib/sitemap";
import { parseArtistsJson } from "../lib/server/artists";
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
        : `Fluncle drum & bass mixtape — ${row.title}.`,
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
        const [trackResult, mixtapeResult] = await Promise.all([
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
        ]);

        const trackPages = typedRows<TrackRow>(trackResult.rows).map(trackPage);
        const mixtapePages = typedRows<MixtapeRow>(mixtapeResult.rows).map(mixtapePage);
        const xml = buildSitemapXml([...trackPages, ...mixtapePages]);

        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
          },
        });
      },
    },
  },
});

// The attention queue's server reads — the thin impure half behind the `/admin`
// home. Each source gets one honest, scoped read (the trust rule:
// never surface a row the system can't confirm is actionable), then the pure
// model (lib/attention.ts) derives the rows. The render-queue depth rides along
// as the queue's one pulse datum (a number in the header, never a row), and the
// newest finding's cover is the zero state's fresh-load fallback.

import {
  type AttentionItem,
  type DraftInput,
  deriveAttentionItems,
  type UnpostedInput,
} from "../attention";
import { listArtistReviewRows, parseArtistsJson } from "./artists";
import { listClipPosts } from "./clip-social";
import { getDb, typedRows } from "./db";
import { listMixtapes } from "./mixtapes";
import { listRecordings } from "./recordings";
import { listTracks } from "./tracks";

export type AttentionSnapshot = {
  items: AttentionItem[];
  /** The zero state's fresh-load cover (the newest finding) when nothing cleared yet. */
  latestCoverUrl?: string;
  /** Enriched findings still waiting on the box's video render — the pulse datum. */
  renderQueueDepth: number;
};

type DraftRow = {
  album_image_url: string | null;
  artists_json: string;
  log_id: string | null;
  title: string;
  track_id: string;
  updated_at: string;
};

// Every pending TikTok inbox draft, oldest push first — each races the 24h bounce
// (the shared `isStaleTikTokDraft` window; the pure model derives the deadline).
async function listTikTokDraftRows(): Promise<DraftInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select t.track_id, t.title, t.artists_json, t.album_image_url, t.log_id, p.updated_at
          from social_posts p
          join tracks t on t.track_id = p.track_id
          where p.platform = 'tiktok' and p.status = 'draft'
          order by p.updated_at asc`,
  });

  return typedRows<DraftRow>(result.rows).map((row) => ({
    ...(row.album_image_url ? { artUrl: row.album_image_url } : {}),
    artists: parseArtistsJson(row.artists_json),
    ...(row.log_id ? { logId: row.log_id } : {}),
    title: row.title,
    trackId: row.track_id,
    updatedAt: row.updated_at,
  }));
}

type UnpostedRow = {
  added_at: string;
  album_image_url: string | null;
  artists_json: string;
  log_id: string;
  title: string;
  track_id: string;
};

// Dressed findings with NO TikTok post at all, oldest first. A draft — fresh or
// bounced — keeps a finding out of this read (it is the deadline row's business;
// the sources partition). A `failed` push re-opens it here, exactly like the
// board's derivation. Log ID required: the caption/bundle actions key off it
// (the helm gatherer's conservatism).
async function listUnpostedRows(): Promise<UnpostedInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select track_id, title, artists_json, album_image_url, log_id, added_at
          from tracks
          where video_url is not null
            and log_id is not null
            and not exists (
              select 1 from social_posts p
              where p.track_id = tracks.track_id
                and p.platform = 'tiktok'
                and p.status in ('published', 'scheduled', 'draft')
            )
          order by added_at asc`,
  });

  return typedRows<UnpostedRow>(result.rows).map((row) => ({
    addedAt: row.added_at,
    ...(row.album_image_url ? { artUrl: row.album_image_url } : {}),
    artists: parseArtistsJson(row.artists_json),
    logId: row.log_id,
    title: row.title,
    trackId: row.track_id,
  }));
}

/** One pass over the sources + the pulse datum + the zero-state fallback. */
export async function readAttentionSnapshot(now: number = Date.now()): Promise<AttentionSnapshot> {
  const [drafts, unposted, recordings, mixtapes, clipPosts, artistReviews, renders, newest] =
    await Promise.all([
      listTikTokDraftRows(),
      listUnpostedRows(),
      listRecordings(),
      listMixtapes({ includeUnpublished: true }),
      listClipPosts(),
      listArtistReviewRows(),
      // The render queue's canonical read (`fluncle admin tracks queue`): findings
      // with context gathered but no video yet.
      listTracks({ hasContext: true, hasVideo: false, limit: 1 }),
      listTracks({ limit: 1, order: "desc" }),
    ]);

  const items = deriveAttentionItems(
    {
      artistReviews,
      clipPosts: clipPosts.map((post) => ({
        scheduledFor: post.scheduledFor,
        status: post.status,
      })),
      drafts,
      mixtapes: mixtapes.map((mixtape) => ({
        ...((mixtape.addedAt ?? mixtape.createdAt)
          ? { anchorAt: mixtape.addedAt ?? mixtape.createdAt }
          : {}),
        ...(mixtape.coverImageUrl ? { artUrl: mixtape.coverImageUrl } : {}),
        id: mixtape.id ?? mixtape.logId ?? mixtape.title,
        ...(mixtape.logId ? { logId: mixtape.logId } : {}),
        ...(mixtape.externalUrls.mixcloud ? { mixcloudUrl: mixtape.externalUrls.mixcloud } : {}),
        ...(mixtape.recordingId ? { recordingId: mixtape.recordingId } : {}),
        status: mixtape.status,
        title: mixtape.title,
        ...(mixtape.externalUrls.youtube ? { youtubeUrl: mixtape.externalUrls.youtube } : {}),
      })),
      recordings: recordings.map((recording) => ({
        createdAt: recording.createdAt,
        hasVideo: recording.hasVideo,
        id: recording.id,
        ...(recording.mixtapeId ? { mixtapeId: recording.mixtapeId } : {}),
        title: recording.title,
        tracklistLength: recording.tracklist.length,
      })),
      unposted,
    },
    now,
  );

  const latestCoverUrl = newest.tracks[0]?.albumImageUrl;

  return {
    items,
    ...(latestCoverUrl ? { latestCoverUrl } : {}),
    renderQueueDepth: renders.totalCount,
  };
}

// The attention queue's server reads — the thin impure half behind the `/admin`
// home. Each source gets one honest, scoped read (the trust rule:
// never surface a row the system can't confirm is actionable), then the pure
// model (lib/attention.ts) derives the rows. The render-queue depth rides along
// as the queue's one pulse datum (a number in the header, never a row), and the
// newest finding's cover is the zero state's fresh-load fallback.

import {
  type AttentionItem,
  type ClipInput,
  deriveAttentionItems,
  type NewsletterInput,
  type SocialStatus,
  type SubmissionInput,
} from "../attention";
import { listArtistReviewRows, parseArtistsJson } from "./artists";
import { listClipPosts } from "./clip-social";
import { getDb, typedRows } from "./db";
import { listLabelReviewRows } from "./labels";
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

type ClipRow = {
  added_at: string;
  album_image_url: string | null;
  artists_json: string;
  log_id: string;
  title: string;
  tiktok_status: SocialStatus | null;
  tiktok_updated_at: string | null;
  track_id: string;
  youtube_status: SocialStatus | null;
};

// Every dressed finding with a still-pending distribution leg, joined to its per-platform
// post state — one `social_posts` row per (track, platform) (the unique index), so the LEFT
// JOINs stay 1:1. A leg is settled once published/scheduled; a clip with BOTH legs settled
// drops out of this read. Oldest first — the pure model picks the focus clip and derives the
// per-platform todos. Log ID required: the caption/cover actions key off it.
async function listClipRows(): Promise<ClipInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select t.track_id, t.title, t.artists_json, t.album_image_url, t.log_id, t.added_at,
                 tk.status as tiktok_status, tk.updated_at as tiktok_updated_at,
                 yt.status as youtube_status
          from tracks t
          left join social_posts tk on tk.track_id = t.track_id and tk.platform = 'tiktok'
          left join social_posts yt on yt.track_id = t.track_id and yt.platform = 'youtube'
          where t.video_url is not null
            and t.log_id is not null
            and (
              coalesce(tk.status, 'none') not in ('published', 'scheduled')
              or coalesce(yt.status, 'none') not in ('published', 'scheduled')
            )
          order by t.added_at asc`,
  });

  return typedRows<ClipRow>(result.rows).map((row) => ({
    addedAt: row.added_at,
    ...(row.album_image_url ? { artUrl: row.album_image_url } : {}),
    artists: parseArtistsJson(row.artists_json),
    logId: row.log_id,
    title: row.title,
    trackId: row.track_id,
    ...(row.tiktok_status ? { tiktokStatus: row.tiktok_status } : {}),
    ...(row.tiktok_updated_at ? { tiktokUpdatedAt: row.tiktok_updated_at } : {}),
    ...(row.youtube_status ? { youtubeStatus: row.youtube_status } : {}),
  }));
}

type SubmissionRow = {
  artists_json: string;
  artwork_url: string | null;
  created_at: string;
  id: string;
  title: string;
  triage_verdict: string | null;
};

// Every pending crew submission awaiting the operator's approve/reject — one queue row
// each, oldest first, carrying its pre-chew triage verdict when the sweep has visited.
// Scoped to `status = 'pending'` (the trust rule: a reviewed submission is not the
// operator's business anymore); the pure model deep-links each to the review tray.
async function listSubmissionRows(): Promise<SubmissionInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: ["pending"],
    sql: `select id, title, artists_json, artwork_url, created_at, triage_verdict
          from submissions
          where status = ?
          order by created_at asc`,
  });

  return typedRows<SubmissionRow>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    ...(row.artwork_url ? { artUrl: row.artwork_url } : {}),
    createdAt: row.created_at,
    id: row.id,
    title: row.title,
    ...(row.triage_verdict ? { triageVerdict: row.triage_verdict } : {}),
  }));
}

type EditionDraftRow = {
  created_at: string;
  id: string;
  subject: string | null;
};

// Every drafted-but-unsent newsletter edition — one queue row each, oldest first, so the
// Friday sweep's draft (persisted then offered on Discord, but sendable only by the operator)
// stops waiting invisibly. Scoped to `status = 'draft'` (the trust rule: a sent back-issue is
// not the operator's business); the pure model deep-links each to /admin/newsletter.
async function listDraftEditionRows(): Promise<NewsletterInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: ["draft"],
    sql: `select id, subject, created_at
          from editions
          where status = ?
          order by created_at asc`,
  });

  return typedRows<EditionDraftRow>(result.rows).map((row) => ({
    draftedAt: row.created_at,
    id: row.id,
    ...(row.subject ? { subject: row.subject } : {}),
  }));
}

/** One pass over the sources + the pulse datum + the zero-state fallback. */
export async function readAttentionSnapshot(now: number = Date.now()): Promise<AttentionSnapshot> {
  const [
    clips,
    recordings,
    mixtapes,
    clipPosts,
    artistReviews,
    labelReviews,
    submissions,
    newsletters,
    renders,
    newest,
  ] = await Promise.all([
    listClipRows(),
    listRecordings(),
    listMixtapes({ includeUnpublished: true }),
    listClipPosts(),
    listArtistReviewRows(),
    // Every label still awaiting the operator's ruling (the trust rule: a ruled label is
    // not the operator's business anymore). Ruling is crawl scope, never storage.
    listLabelReviewRows(),
    listSubmissionRows(),
    listDraftEditionRows(),
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
      clips,
      labelReviews,
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
      newsletters,
      recordings: recordings.map((recording) => ({
        createdAt: recording.createdAt,
        hasVideo: recording.hasVideo,
        id: recording.id,
        ...(recording.mixtapeId ? { mixtapeId: recording.mixtapeId } : {}),
        title: recording.title,
        tracklistLength: recording.tracklist.length,
      })),
      submissions,
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

import {
  type AttentionItem,
  type AnchorFailureInput,
  type CaptureSuspectInput,
  type ClipInput,
  deriveAttentionItems,
  type NewsletterInput,
  type SocialStatus,
  type SubmissionInput,
} from "../attention";
import { bestAlbumCoverUrl } from "../media";
import { listAnchorReviewRows } from "./anchor";
import { listArtistReviewRows, parseArtistsJson } from "./artists";
import { listBioReviewRows } from "./bio-review";
import { listClipPosts } from "./clip-social";
import { getDb, typedRow, typedRows } from "./db";
import { listLabelReviewRows } from "./labels";
import { listMixtapes } from "./mixtapes";
import { listNoteRejectionReviewRows } from "./note-rejections";
import { listObservationRejectionReviewRows } from "./observation-rejections";
import { listRecordings } from "./recordings";
import { FINDINGS_FROM, listTracks } from "./tracks";

export type AttentionSnapshot = {
  items: AttentionItem[];

  latestCoverUrl?: string;

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

export const CLIP_QUEUE_LIMIT = 50;

async function listAnchorFailureRows(): Promise<AnchorFailureInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [50],
    sql: `select track_id, title, artists_json, mb_recording_id,
                 spotify_anchor_attempted_at, spotify_anchor_terminal_error
          from tracks indexed by tracks_anchor_terminal_idx
          where spotify_anchor_terminal_error is not null
            and spotify_uri is null
            and dismissed_at is null
            and duplicate_of_track_id is null
          order by track_id limit ?`,
  });
  return typedRows<{
    artists_json: string;
    mb_recording_id: null | string;
    spotify_anchor_attempted_at: null | string;
    spotify_anchor_terminal_error: string;
    title: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    anchorAt: row.spotify_anchor_attempted_at ?? new Date(0).toISOString(),
    artists: parseArtistsJson(row.artists_json),
    error: row.spotify_anchor_terminal_error,
    ...(row.mb_recording_id ? { mbRecordingId: row.mb_recording_id } : {}),
    title: row.title,
    trackId: row.track_id,
  }));
}

async function listClipRows(): Promise<ClipInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [CLIP_QUEUE_LIMIT],
    sql: `select t.track_id, t.title, t.artists_json, t.album_image_url, t.log_id, t.added_at,
                 tk.status as tiktok_status, tk.updated_at as tiktok_updated_at,
                 yt.status as youtube_status
          from (findings join tracks on tracks.track_id = findings.track_id) t
          left join social_posts tk on tk.track_id = t.track_id and tk.platform = 'tiktok'
          left join social_posts yt on yt.track_id = t.track_id and yt.platform = 'youtube'
          where t.video_url is not null
            and t.log_id is not null
            and (
              coalesce(tk.status, 'none') not in ('published', 'scheduled')
              or coalesce(yt.status, 'none') not in ('published', 'scheduled')
            )
          order by t.added_at asc
          limit ?`,
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

type CaptureSuspectRow = {
  album_image_url: string | null;
  artists_json: string;
  capture_verified_at: string | null;
  log_id: string | null;
  title: string;
  track_id: string;
};

async function listCaptureSuspectRows(): Promise<CaptureSuspectInput[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select t.track_id, t.title, t.artists_json, t.album_image_url,
                 t.capture_verified_at, f.log_id
          from tracks t
          join findings f on f.track_id = t.track_id
          where t.capture_verification = 'mismatch'
          order by t.capture_verified_at asc, t.track_id asc`,
  });

  return typedRows<CaptureSuspectRow>(result.rows).map((row) => ({
    anchorAt: row.capture_verified_at ?? new Date(0).toISOString(),
    ...(row.album_image_url ? { artUrl: row.album_image_url } : {}),
    artists: parseArtistsJson(row.artists_json),
    ...(row.log_id ? { logId: row.log_id } : {}),
    title: row.title,
    trackId: row.track_id,
  }));
}

type EditionDraftRow = {
  created_at: string;
  id: string;
  subject: string | null;
};

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

type LatestCoverRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
};

async function readLatestCoverUrl(): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select tracks.album_image_url,
                 (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
                 (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
                 (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at
          from ${FINDINGS_FROM}
          order by findings.added_at desc, tracks.track_id desc
          limit 1`,
  });

  const row = typedRow<LatestCoverRow>(result.rows);
  if (!row) {
    return undefined;
  }

  return bestAlbumCoverUrl({
    imageKey: row.album_image_key,
    imageState: row.album_image_state,
    imageUpdatedAt: row.album_image_updated_at,
    spotifyUrl: row.album_image_url,
  });
}

export async function readAttentionSnapshot(now: number = Date.now()): Promise<AttentionSnapshot> {
  const [
    clips,
    recordings,
    mixtapes,
    clipPosts,
    anchorReviews,
    anchorFailures,
    artistReviews,
    bioReviews,
    captureSuspects,
    labelReviews,
    submissions,
    newsletters,
    noteRejections,
    observationRejections,
    renders,
    latestCoverUrl,
  ] = await Promise.all([
    listClipRows(),
    listRecordings(),
    listMixtapes({ includeUnpublished: true }),
    listClipPosts(),

    listAnchorReviewRows(),
    listAnchorFailureRows(),
    listArtistReviewRows(),

    listBioReviewRows(),

    listCaptureSuspectRows(),

    listLabelReviewRows(),
    listSubmissionRows(),
    listDraftEditionRows(),

    listNoteRejectionReviewRows(),

    listObservationRejectionReviewRows(),

    listTracks({ hasContext: true, hasVideo: false, limit: 1 }),

    readLatestCoverUrl(),
  ]);

  const items = deriveAttentionItems(
    {
      anchorFailures,
      anchorReviews,
      artistReviews,
      bioReviews,
      captureSuspects,
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
      noteRejections,
      observationRejections,
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

  return {
    items,
    ...(latestCoverUrl ? { latestCoverUrl } : {}),
    renderQueueDepth: renders.totalCount,
  };
}

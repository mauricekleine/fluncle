import {
  type MixtapeDTO,
  type MixtapeExternalUrls,
  type MixtapeMember,
  type MixtapeStatus,
  type TrackListItem,
} from "@fluncle/contracts";
import { siteUrl } from "./fluncle-links";

export type { MixtapeDTO, MixtapeExternalUrls, MixtapeMember, MixtapeStatus };

/** The aspects the on-the-fly cover endpoint renders (api/mixtape-cover.$logId.ts). */
export type MixtapeCoverSize = "og" | "square" | "wide";

/**
 * The title for on-site display (feed row, /mixtapes index, /log plate): the
 * canonical title minus its " | <coordinate>" suffix, since the Log ID is shown
 * right beside it everywhere. Keeps "#N". The full canonical title still rides
 * into <title>, og:title, and the JSON-LD. (A custom-series title with no " | "
 * passes through unchanged.)
 */
export function mixtapeDisplayTitle(title: string): string {
  return title.split(" | ")[0];
}

/**
 * Bumped whenever the shared cover background or the stamp layout changes. The
 * cover endpoint serves `immutable, max-age=1y`, so this `?v=` is the cache key —
 * raise it to bust every cached cover after a re-bake (e.g. the R2-background
 * fetch fix that replaced the black render).
 */
const COVER_VERSION = 2;

/**
 * The cover URL for a published mixtape, rendered on the fly by the cover
 * endpoint (Satori over the baked Deep-Field background). square backs the
 * coverImageUrl + Mixcloud/SoundCloud artwork, og the /log link-preview, wide
 * the YouTube thumbnail. There's no render step — the cover just exists here.
 */
export function mixtapeCoverUrl(logId: string, size: MixtapeCoverSize = "square"): string {
  return `${siteUrl}/api/mixtape-cover/${encodeURIComponent(logId)}?size=${size}&v=${COVER_VERSION}`;
}

export type FeedItem = MixtapeDTO | TrackListItem;

export type MixtapeRowLike = {
  added_at?: string | null;
  created_at?: string | null;
  duration_ms?: number | null;
  id?: string | null;
  log_id?: string | null;
  member_count?: number | null;
  mixcloud_url?: string | null;
  note?: string | null;
  planned_for?: string | null;
  published_at?: string | null;
  recorded_at?: string | null;
  sequence_number?: number | null;
  soundcloud_url?: string | null;
  status?: MixtapeStatus | null;
  title: string;
  updated_at?: string | null;
  youtube_url?: string | null;
};

export function rowToMixtape(row: MixtapeRowLike, members: MixtapeMember[] = []): MixtapeDTO {
  return {
    addedAt: row.added_at ?? undefined,
    artists: ["Fluncle"],
    // The cover is derived, never stored: a published mixtape's Log ID resolves
    // to the on-the-fly cover endpoint (mixtapeCoverUrl); a draft has no cover yet.
    coverImageUrl: row.log_id ? mixtapeCoverUrl(row.log_id, "square") : undefined,
    createdAt: row.created_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    externalUrls: {
      mixcloud: row.mixcloud_url ?? undefined,
      soundcloud: row.soundcloud_url ?? undefined,
      youtube: row.youtube_url ?? undefined,
    },
    id: row.id ?? undefined,
    logId: row.log_id ?? undefined,
    memberCount: Number(row.member_count ?? members.length),
    members,
    note: row.note?.trim() ? row.note : undefined,
    plannedFor: row.planned_for ?? undefined,
    publishedAt: row.published_at ?? undefined,
    recordedAt: row.recorded_at ?? undefined,
    sequenceNumber: row.sequence_number ?? undefined,
    status: row.status ?? "draft",
    title: row.title,
    type: "mixtape",
    updatedAt: row.updated_at ?? undefined,
  };
}

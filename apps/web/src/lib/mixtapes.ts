import {
  type FeedItem,
  type MixtapeDTO,
  type MixtapeExternalUrls,
  type MixtapeMember,
  type MixtapeStatus,
} from "@fluncle/contracts";
import { buildMixtapeCoverUrl, type MixtapeCoverSize } from "@fluncle/contracts/util/mixtape-cover";
import { siteUrl } from "./fluncle-links";

export type { FeedItem, MixtapeDTO, MixtapeExternalUrls, MixtapeMember, MixtapeStatus };
export { type MixtapeCoverSize } from "@fluncle/contracts/util/mixtape-cover";

export function mixtapeDisplayTitle(title: string): string {
  return title.split(" | ")[0] ?? title;
}

export function mixtapeCoverUrl(logId: string, size: MixtapeCoverSize = "square"): string {
  return buildMixtapeCoverUrl(siteUrl, logId, size);
}

export type MixtapeRowLike = {
  added_at?: string | null;
  announced_at?: string | null;
  created_at?: string | null;
  duration_ms?: number | null;
  id?: string | null;
  log_id?: string | null;
  member_count?: number | null;
  mixcloud_url?: string | null;
  note?: string | null;
  published_at?: string | null;
  recorded_at?: string | null;
  recording_id?: string | null;
  sequence_number?: number | null;
  set_video_at?: string | null;
  soundcloud_url?: string | null;
  status?: MixtapeStatus | null;
  title: string;
  updated_at?: string | null;
  youtube_url?: string | null;
};

export function rowToMixtape(row: MixtapeRowLike, members: MixtapeMember[] = []): MixtapeDTO {
  return {
    addedAt: row.added_at ?? undefined,
    announcedAt: row.announced_at ?? undefined,
    artists: ["Fluncle"],

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
    publishedAt: row.published_at ?? undefined,
    recordedAt: row.recorded_at ?? undefined,

    recordingId: row.recording_id ?? undefined,
    sequenceNumber: row.sequence_number ?? undefined,
    setVideoAt: row.set_video_at ?? undefined,

    status: row.status ?? "published",
    title: row.title,
    type: "mixtape",
    updatedAt: row.updated_at ?? undefined,
  };
}

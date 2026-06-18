import { type TrackListItem } from "./server/tracks";

export type MixtapeStatus = "draft" | "published";

export type MixtapeExternalUrls = {
  mixcloud?: string;
  soundcloud?: string;
  youtube?: string;
};

export type MixtapeDTO = {
  addedAt?: string;
  artists: ["Fluncle"];
  coverImageUrl?: string;
  createdAt?: string;
  durationMs?: number;
  externalUrls: MixtapeExternalUrls;
  id?: string;
  logId?: string;
  memberCount: number;
  members: TrackListItem[];
  note?: string;
  recordedAt?: string;
  sequenceNumber?: number;
  status?: MixtapeStatus;
  title: string;
  type: "mixtape";
  updatedAt?: string;
};

export type FeedItem = TrackListItem | MixtapeDTO;

export type MixtapeRowLike = {
  added_at?: string | null;
  cover_image_url?: string | null;
  created_at?: string | null;
  duration_ms?: number | null;
  id?: string | null;
  log_id?: string | null;
  member_count?: number | null;
  mixcloud_url?: string | null;
  note?: string | null;
  recorded_at?: string | null;
  sequence_number?: number | null;
  soundcloud_url?: string | null;
  status?: MixtapeStatus | null;
  title: string;
  updated_at?: string | null;
  youtube_url?: string | null;
};

export function hasExternalUrl(urls: MixtapeExternalUrls): boolean {
  return Boolean(urls.mixcloud || urls.soundcloud || urls.youtube);
}

export function rowToMixtape(row: MixtapeRowLike, members: TrackListItem[] = []): MixtapeDTO {
  return {
    addedAt: row.added_at ?? undefined,
    artists: ["Fluncle"],
    coverImageUrl: row.cover_image_url ?? undefined,
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
    recordedAt: row.recorded_at ?? undefined,
    sequenceNumber: row.sequence_number ?? undefined,
    status: row.status ?? undefined,
    title: row.title,
    type: "mixtape",
    updatedAt: row.updated_at ?? undefined,
  };
}

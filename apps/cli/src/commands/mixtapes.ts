import { publicApiGet } from "../api";

export type MixtapeListItem = {
  addedAt?: string;
  artists: ["Fluncle"];
  coverImageUrl?: string;
  createdAt?: string;
  durationMs?: number;
  externalUrls: {
    mixcloud?: string;
    soundcloud?: string;
    youtube?: string;
  };
  id?: string;
  logId?: string;
  memberCount: number;
  members: unknown[];
  note?: string;
  recordedAt?: string;
  sequenceNumber?: number;
  status?: "draft" | "published";
  title: string;
  type: "mixtape";
  updatedAt?: string;
};

type MixtapesResponse = {
  mixtapes: MixtapeListItem[];
  ok: true;
};

export async function mixtapesCommand(): Promise<MixtapeListItem[]> {
  const response = await publicApiGet<MixtapesResponse>("/api/mixtapes");

  return response.mixtapes;
}

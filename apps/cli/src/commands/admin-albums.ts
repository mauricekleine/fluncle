import { adminApiGet, adminApiPost } from "../api";
import {
  buildBioBody,
  type EntityBioDraft,
  type EntityBioResult,
  type EntityBioWorkItem,
} from "./admin-artists";

export async function describeAlbumCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; finalAttempt?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/v1/admin/albums/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

export async function draftAlbumBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/v1/admin/albums/${encodeURIComponent(slug)}/bio-draft`);
}

export async function albumsBioQueueCommand(limit: number): Promise<EntityBioWorkItem[]> {
  const response = await adminApiGet<{ albums: EntityBioWorkItem[]; ok: boolean }>(
    `/api/v1/admin/albums/bio-queue?limit=${limit}`,
  );

  return response.albums;
}

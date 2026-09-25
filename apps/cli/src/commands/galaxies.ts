import {
  type GalaxiesAdminResponse,
  type GalaxiesResponse,
  type GalaxyAdminItem,
  type GalaxyListItem,
  type GalaxyMapUpdateResponse,
  type GalaxyResponse,
  type TrackEmbeddingsResponse,
  type TrackListItem,
} from "@fluncle/contracts";
import { adminApiGet, adminApiPut, publicApiGet } from "../api";

export type { GalaxyAdminItem, GalaxyListItem };

export async function galaxiesListCommand(): Promise<GalaxyListItem[]> {
  const response = await publicApiGet<GalaxiesResponse>("/api/v1/galaxies");
  return response.galaxies;
}

export async function galaxyGetCommand(
  slug: string,
): Promise<{ findings: TrackListItem[]; galaxy: GalaxyListItem }> {
  const response = await publicApiGet<GalaxyResponse>(
    `/api/v1/galaxies/${encodeURIComponent(slug)}`,
  );
  return { findings: response.findings, galaxy: response.galaxy };
}

export async function galaxyMapReadCommand(): Promise<GalaxyAdminItem[]> {
  const response = await adminApiGet<GalaxiesAdminResponse>("/api/v1/admin/galaxies");
  return response.galaxies;
}

export async function galaxyEmbeddingsCommand(options: {
  cursor?: string;
  limit?: string;
}): Promise<TrackEmbeddingsResponse> {
  const params = new URLSearchParams();

  if (options.cursor) {
    params.set("cursor", options.cursor);
  }

  if (options.limit) {
    params.set("limit", options.limit);
  }

  const query = params.toString();
  return adminApiGet<TrackEmbeddingsResponse>(
    `/api/v1/admin/tracks/embeddings${query ? `?${query}` : ""}`,
  );
}

export async function galaxyMapWriteCommand(
  clusters: Array<{
    centroid: number[];
    clearSplitRequest?: boolean;
    id: string | null;
    retire?: boolean;
  }>,
): Promise<GalaxyAdminItem[]> {
  const response = await adminApiPut<GalaxyMapUpdateResponse>("/api/v1/admin/galaxies/map", {
    clusters,
  });
  return response.galaxies;
}

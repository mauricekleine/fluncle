// The `galaxies` CLI commands (browse-by-feel RFC). The public `fluncle galaxies
// [slug]` reads clone the `artists.ts` pattern (thin `publicApiGet`); the admin
// `fluncle admin galaxies` sweep subcommands are the `fluncle-cluster` cron's thin
// HTTP client over the map ops (read the map, read the embedded corpus, write the map).

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

/** Every named, non-retired galaxy, member-count descending. `fluncle galaxies`. */
export async function galaxiesListCommand(): Promise<GalaxyListItem[]> {
  const response = await publicApiGet<GalaxiesResponse>("/api/v1/galaxies");
  return response.galaxies;
}

/**
 * One named galaxy by slug + its findings (core-first). Throws the standard
 * `publicApiGet` error on 404. `fluncle galaxies <slug>`.
 */
export async function galaxyGetCommand(
  slug: string,
): Promise<{ findings: TrackListItem[]; galaxy: GalaxyListItem }> {
  const response = await publicApiGet<GalaxyResponse>(
    `/api/v1/galaxies/${encodeURIComponent(slug)}`,
  );
  return { findings: response.findings, galaxy: response.galaxy };
}

/** The FULL admin map (named + unnamed + retired). `fluncle admin galaxies map`. */
export async function galaxyMapReadCommand(): Promise<GalaxyAdminItem[]> {
  const response = await adminApiGet<GalaxiesAdminResponse>("/api/v1/admin/galaxies");
  return response.galaxies;
}

/**
 * One cursor page of the embedded corpus (the cluster engine's input).
 * `fluncle admin galaxies embeddings [--cursor <c>] [--limit <n>]`.
 */
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

/**
 * The transactional map write — the Worker mints ids + handles for `id: null` rows and
 * returns the resulting map. `fluncle admin galaxies set-map` (clusters JSON from a
 * file or stdin).
 */
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

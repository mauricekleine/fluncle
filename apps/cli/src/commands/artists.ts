// The `artists` CLI command — thin `publicApiGet` reads over the public
// `list_artists` / `get_artist` oRPC ops. Mirrors the `recent`/`mixtapes`
// pattern: fetch, format, return.

import {
  type ArtistGetResponse,
  type ArtistsResponse,
  type ArtistListItem,
} from "@fluncle/contracts";
import { publicApiGet } from "../api";

export type { ArtistListItem };

/**
 * Every artist with at least one finding, finding-count descending.
 * The data behind `fluncle artists` (list).
 */
export async function artistsListCommand(): Promise<ArtistListItem[]> {
  const response = await publicApiGet<ArtistsResponse>("/api/v1/artists");
  return response.artists;
}

/**
 * One artist by slug. Throws the standard `publicApiGet` error on 404 (the
 * server's "No artist with slug …" message surfaces there).
 * The data behind `fluncle artists <slug>`.
 */
export async function artistsGetCommand(slug: string): Promise<ArtistListItem> {
  const response = await publicApiGet<ArtistGetResponse>(
    `/api/v1/artists/${encodeURIComponent(slug)}`,
  );
  return response.artist;
}

// The `artists` CLI command — a thin `publicApiGet` read over the public
// `list_artists` / `get_artist` oRPC ops, rendered in the catalogue reference
// register (plain, no cosmos: `/artists` is a reference shelf, VOICE.md §5).
//
// `list_artists` is now the unified index — every artist Fluncle holds, A to Z,
// one page at a time — so the bare list pages with `--page` and each row carries
// a plain track count (the Unlit Rule keeps the certified/tier marker off the
// row; `--json` carries `certified` and the finding count). A bare `slug` reads
// one artist's dossier.

import { type ArtistGetResponse, type ArtistsResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { printJson } from "../output";
import { entityDetailLines, printEntityIndex } from "./entity-browse";

export async function artistsCommand({
  json,
  page,
  slug,
}: {
  json: boolean;
  page: number;
  slug: string | undefined;
}): Promise<void> {
  if (slug) {
    const response = await publicApiGet<ArtistGetResponse>(
      `/api/v1/artists/${encodeURIComponent(slug)}`,
    );

    if (json) {
      printJson(response);
      return;
    }

    const { artist } = response;
    const lines = entityDetailLines(
      artist.name,
      artist.slug,
      artist.trackCount,
      artist.findingCount,
    );

    if (artist.spotifyUrl) {
      lines.push(`Spotify: ${artist.spotifyUrl}`);
    }

    console.log(lines.join("\n"));
    return;
  }

  const response = await publicApiGet<ArtistsResponse>(`/api/v1/artists?page=${page}`);

  if (json) {
    printJson(response);
    return;
  }

  printEntityIndex(
    response.artists,
    response,
    { plural: "artists", singular: "artist" },
    "artists",
  );
}

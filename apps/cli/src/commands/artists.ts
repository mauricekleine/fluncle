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

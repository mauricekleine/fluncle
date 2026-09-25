import { type AlbumGetResponse, type AlbumsResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { printJson } from "../output";
import { entityDetailLines, printEntityIndex } from "./entity-browse";

export async function albumsCommand({
  json,
  page,
  slug,
}: {
  json: boolean;
  page: number;
  slug: string | undefined;
}): Promise<void> {
  if (slug) {
    const response = await publicApiGet<AlbumGetResponse>(
      `/api/v1/albums/${encodeURIComponent(slug)}`,
    );

    if (json) {
      printJson(response);
      return;
    }

    const { album } = response;
    const lines = entityDetailLines(album.name, album.slug, album.trackCount, album.findingCount);

    if (album.releaseDate) {
      lines.push(`Released: ${album.releaseDate.slice(0, 10)}`);
    }

    console.log(lines.join("\n"));
    return;
  }

  const response = await publicApiGet<AlbumsResponse>(`/api/v1/albums?page=${page}`);

  if (json) {
    printJson(response);
    return;
  }

  printEntityIndex(response.albums, response, { plural: "albums", singular: "album" }, "albums");
}

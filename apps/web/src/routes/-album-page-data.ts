import { ALBUM_INDEX_MIN_TRACKS, getAlbumBySlug } from "@/lib/server/albums";
import { type ArtistChip, listArtistsByAlbum } from "@/lib/server/artists";
import { getLabelForAlbum, type LabelRecord } from "@/lib/server/labels";
import {
  type CatalogueTrackItem,
  getFindingsByAlbum,
  listCatalogueTracksByAlbum,
  type TrackListItem,
} from "@/lib/server/tracks";

export type AlbumPageData =
  | {
      artists: ArtistChip[];

      bio: string | undefined;

      catalogue: CatalogueTrackItem[];

      catalogNumber: string | undefined;
      coverImageUrl: string | undefined;
      findings: TrackListItem[];
      indexable: boolean;
      label: LabelRecord | undefined;
      name: string;

      releaseDate: string | undefined;

      releaseGroupMbid: string | undefined;
      slug: string;
      status: "found";

      upc: string | undefined;
    }
  | { status: "missing" };

export async function resolveAlbumPageData(slug: string): Promise<AlbumPageData> {
  const album = await getAlbumBySlug(slug);

  if (!album) {
    return { status: "missing" };
  }

  const [findings, catalogue, artists, label] = await Promise.all([
    getFindingsByAlbum(album.id),
    listCatalogueTracksByAlbum(album.id),
    listArtistsByAlbum(album.id),
    getLabelForAlbum(album.id),
  ]);

  if (findings.length === 0 && catalogue.total === 0) {
    return { status: "missing" };
  }

  return {
    artists,
    bio: album.bio,
    catalogNumber: album.discogsCatno,
    catalogue: catalogue.tracks,

    coverImageUrl: findings[0]?.albumImageUrl,
    findings,

    indexable: findings.length + catalogue.total >= ALBUM_INDEX_MIN_TRACKS,
    label,
    name: album.name,

    releaseDate: album.releaseDate,
    releaseGroupMbid: album.releaseGroupMbid,
    slug: album.slug,
    status: "found",
    upc: album.upc,
  };
}

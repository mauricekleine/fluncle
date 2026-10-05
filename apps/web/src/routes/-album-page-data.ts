import { ALBUM_INDEX_MIN_TRACKS, getAlbumBySlug } from "@/lib/server/albums";
import { type ArtistChip, listArtistsByAlbum } from "@/lib/server/artists";
import { getLabelForAlbum, type LabelRecord } from "@/lib/server/labels";
import { releaseTodayUtc } from "@/lib/server/release-day";
import {
  type CatalogueTrackItem,
  getFindingsByAlbum,
  listCatalogueTracksByAlbum,
  listRelatedFindings,
  type TrackListItem,
} from "@/lib/server/tracks";

export type AlbumPageData =
  | {
      artists: ArtistChip[];

      bio: string | undefined;

      catalogue: CatalogueTrackItem[];
      catalogueTotal: number;

      catalogNumber: string | undefined;
      coverImageUrl: string | undefined;
      findings: TrackListItem[];
      indexable: boolean;
      label: LabelRecord | undefined;
      name: string;
      related: TrackListItem[];

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

  const [findings, catalogue, artists, label, related] = await Promise.all([
    getFindingsByAlbum(album.id),
    listCatalogueTracksByAlbum(album.id),
    listArtistsByAlbum(album.id),
    getLabelForAlbum(album.id),
    listRelatedFindings(
      { albumId: album.id, kind: "album" },
      { today: releaseTodayUtc(new Date()) },
    ).catch((): TrackListItem[] => []),
  ]);

  if (album.renderableTrackCount === 0) {
    return { status: "missing" };
  }

  return {
    artists,
    bio: album.bio,
    catalogNumber: album.discogsCatno,
    catalogue: catalogue.tracks,
    catalogueTotal: catalogue.total,

    coverImageUrl: findings[0]?.albumImageUrl,
    findings,

    indexable: album.renderableTrackCount >= ALBUM_INDEX_MIN_TRACKS,
    label,
    name: album.name,
    related: findings.length > 0 ? [] : related,

    releaseDate: album.releaseDate,
    releaseGroupMbid: album.releaseGroupMbid,
    slug: album.slug,
    status: "found",
    upc: album.upc,
  };
}

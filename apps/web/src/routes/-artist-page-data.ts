import {
  type ArtistNeighbour,
  type ArtistSignature,
  getArtistNeighbours,
  summarizeArtistSignature,
} from "@/lib/server/artist-dossier";
import {
  ARTIST_INDEX_MIN_FINDINGS,
  type ArtistSocialLink,
  getPublicArtistBySlug,
  getPublicArtistAliasNames,
  getPublicArtistSocials,
} from "@/lib/server/artists";
import {
  CataloguePageOutOfRangeError,
  type CatalogueGroupPage,
  type CatalogueRecord,
  type CatalogueSort,
  type UpcomingTrackPage,
} from "@/lib/catalogue";
import { listArtistCatalogue, listArtistUpcoming } from "@/lib/server/catalogue-groups";
import { releaseTodayUtc } from "@/lib/server/release-day";
import { getFindingsByArtist, type TrackListItem } from "@/lib/server/tracks";

export type { ArtistSocialLink };

type ArtistDossier = ArtistSignature & {
  findingCount: number;
  neighbours: ArtistNeighbour[];
};

export type ArtistPageData =
  | {
      alternateNames: string[];

      bio: string | undefined;

      catalogue: CatalogueGroupPage<CatalogueRecord>;
      dossier: ArtistDossier;
      findings: TrackListItem[];
      upcoming: UpcomingTrackPage;

      id: string;
      imageUrl: string | undefined;
      indexable: boolean;
      name: string;
      slug: string;
      socials: ArtistSocialLink[];
      sort: CatalogueSort;
      status: "found";

      discogsUrl: string | undefined;
      lastfmUrl: string | undefined;
      mbid: string | undefined;
      spotifyUrl: string | undefined;
      wikidataQid: string | undefined;
    }
  | { status: "missing" };

export async function resolveArtistPageData(
  slug: string,
  sort: CatalogueSort,
  page: number,
  upcomingPage = 1,
): Promise<ArtistPageData> {
  const today = releaseTodayUtc(new Date());
  const artist = await getPublicArtistBySlug(slug);

  if (!artist) {
    return { status: "missing" };
  }

  const cataloguePromise = listArtistCatalogue(artist.id, sort, page, today).catch(
    (error: unknown): CatalogueGroupPage<CatalogueRecord> | null => {
      if (error instanceof CataloguePageOutOfRangeError) {
        return null;
      }

      throw error;
    },
  );

  const [catalogue, findings, socials, neighbours, alternateNames, upcoming] = await Promise.all([
    cataloguePromise,
    getFindingsByArtist(artist.id, artist.name, today),
    getPublicArtistSocials(artist.id),
    getArtistNeighbours(artist.id),

    getPublicArtistAliasNames(artist.id),
    listArtistUpcoming(artist.id, today, upcomingPage).catch(
      (error: unknown): UpcomingTrackPage | null => {
        if (error instanceof CataloguePageOutOfRangeError) {
          return null;
        }
        throw error;
      },
    ),
  ]);

  if (catalogue === null || upcoming === null) {
    return { status: "missing" };
  }

  const gridFindings = findings.filter((finding) => finding.logId);
  const signature = summarizeArtistSignature(
    gridFindings.map((finding) => ({ addedAt: finding.addedAt })),
  );

  return {
    alternateNames,
    bio: artist.bio,
    catalogue,
    discogsUrl: artist.discogsUrl,
    dossier: { ...signature, findingCount: gridFindings.length, neighbours },
    findings,
    id: artist.id,
    imageUrl: artist.imageUrl,

    indexable: artist.renderableTrackCount >= ARTIST_INDEX_MIN_FINDINGS,
    lastfmUrl: artist.lastfmUrl,
    mbid: artist.mbid,
    name: artist.name,
    slug: artist.slug,
    socials,
    sort,
    spotifyUrl: artist.spotifyUrl,
    status: "found",
    upcoming,
    wikidataQid: artist.wikidataQid,
  };
}

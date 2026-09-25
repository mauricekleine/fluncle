import {
  type CatalogueArtistGroup,
  CataloguePageOutOfRangeError,
  type CatalogueGroupPage,
  type CatalogueSort,
  type UpcomingTrackPage,
} from "@/lib/catalogue";
import { type ArtistChip, listArtistsByLabel } from "@/lib/server/artists";
import { listLabelCatalogue, listLabelUpcoming } from "@/lib/server/catalogue-groups";
import { releaseTodayUtc } from "@/lib/server/release-day";
import {
  getConfirmedAliasNames,
  getLabelBySlug,
  LABEL_INDEX_MIN_TRACKS,
  type LabelLineageEdge,
  resolveLabelAliasRedirect,
} from "@/lib/server/labels";
import { getFindingsByLabel, type TrackListItem } from "@/lib/server/tracks";

export type LabelPageData =
  | {
      alternateNames: string[];
      artists: ArtistChip[];

      bio: string | undefined;

      catalogue: CatalogueGroupPage<CatalogueArtistGroup>;

      discogsLabelId: number | undefined;
      findings: TrackListItem[];
      upcoming: UpcomingTrackPage;

      foundedLocation: string | undefined;

      foundingDate: string | undefined;

      id: string;
      indexable: boolean;

      logoImageUrl: string | undefined;

      mbLabelId: string | undefined;
      name: string;

      parentLabel: LabelLineageEdge | undefined;
      slug: string;
      sort: CatalogueSort;
      status: "found";

      subLabels: LabelLineageEdge[];
    }
  | {
      canonicalSlug: string;
      status: "redirect";
    }
  | { status: "missing" };

export async function resolveLabelPageData(
  slug: string,
  sort: CatalogueSort,
  page: number,
  upcomingPage = 1,
): Promise<LabelPageData> {
  const today = releaseTodayUtc(new Date());
  const label = await getLabelBySlug(slug);

  if (!label) {
    const canonicalSlug = await resolveLabelAliasRedirect(slug);

    if (canonicalSlug && canonicalSlug !== slug) {
      return { canonicalSlug, status: "redirect" };
    }

    return { status: "missing" };
  }

  const cataloguePromise = listLabelCatalogue(label.id, sort, page, today).catch(
    (error: unknown): CatalogueGroupPage<CatalogueArtistGroup> | null => {
      if (error instanceof CataloguePageOutOfRangeError) {
        return null;
      }

      throw error;
    },
  );

  const [catalogue, findings, artists, alternateNames, upcoming] = await Promise.all([
    cataloguePromise,
    getFindingsByLabel(label.id, today),
    listArtistsByLabel(label.id),
    getConfirmedAliasNames(label.id),
    listLabelUpcoming(label.id, today, upcomingPage).catch(
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

  if (catalogue.totalTracks === 0 && findings.length === 0 && upcoming.total === 0) {
    return { status: "missing" };
  }

  return {
    alternateNames,
    artists,
    bio: label.bio,
    catalogue,
    discogsLabelId: label.discogsLabelId,
    findings,
    foundedLocation: label.foundedLocation,
    foundingDate: label.foundingDate,
    id: label.id,

    indexable: (label.renderableTrackCount ?? 0) >= LABEL_INDEX_MIN_TRACKS,
    logoImageUrl: label.logoImageUrl,
    mbLabelId: label.mbLabelId,
    name: label.name,
    parentLabel: label.parentLabel,
    slug: label.slug,
    sort,
    status: "found",
    subLabels: label.subLabels ?? [],
    upcoming,
  };
}

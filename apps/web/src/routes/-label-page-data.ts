// The label page's server-side resolution, lifted out of `label.$slug.tsx` — the same split
// `-album-page-data.ts` carries the long note for: a route's loader/head live in the route's
// critical half, so a resolver referenced there keeps its `lib/server/**` imports (and the
// `getDb` → `@libsql/client` + `drizzle-orm` + `db/schema.ts` chain behind them) alive in the
// eager browser chunk every page downloads before first paint.
//
// The route reaches this by a DYNAMIC import inside its handler and by `import type`.
// `-graph-pages.test.ts` drives the resolver directly, as before.

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
import { countRenderedLabelTracks, publicEntityIndexable } from "@/lib/server/entity-indexability";
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
      /** The label's CONFIRMED alternate spellings — the Organization JSON-LD's `alternateName`. */
      alternateNames: string[];
      artists: ArtistChip[];
      /**
       * The label's voiced bio — a short paragraph beneath the dateline, undefined until one is
       * authored (lib/server/bio.ts). The masthead renders it only when present.
       */
      bio: string | undefined;
      /** The crawled catalogue, grouped by artist — one page of it, plus SQL-counted totals. */
      catalogue: CatalogueGroupPage<CatalogueArtistGroup>;
      /** The Discogs label id → the Organization JSON-LD's `sameAs` (`discogs.com/label/<id>`). */
      discogsLabelId: number | undefined;
      findings: TrackListItem[];
      upcoming: UpcomingTrackPage;
      /** The label's founding place (MusicBrainz `area.name`) — the dateline + Organization `location`. */
      foundedLocation: string | undefined;
      /** The label's founding date (MusicBrainz `life-span.begin`) — the dateline + `foundingDate`. */
      foundingDate: string | undefined;
      /** The label entity's id — the key a signed-in user's watch files against (D2a). */
      id: string;
      indexable: boolean;
      /** The label's OWN logo (resolved Discogs/Wikidata image on R2), or undefined. */
      logoImageUrl: string | undefined;
      /** The MusicBrainz label MBID → the Organization JSON-LD's `sameAs` (`musicbrainz.org/label/<mbid>`). */
      mbLabelId: string | undefined;
      name: string;
      /** The imprint this label belongs to → the Organization's `parentOrganization` edge. */
      parentLabel: LabelLineageEdge | undefined;
      slug: string;
      sort: CatalogueSort;
      status: "found";
      /** The sublabels of this label → the Organization's `subOrganization` edges. */
      subLabels: LabelLineageEdge[];
    }
  | {
      /** A merged-away slug: 301 to the canonical label this confirmed alias belongs to. */
      canonicalSlug: string;
      status: "redirect";
    }
  | { status: "missing" };

/**
 * Resolve the label page's data. Extracted from the server fn so the indexability decision is
 * unit-testable (see -graph-pages.test.ts), the `resolveArtistPageData` precedent.
 *
 * ── A LABEL EARNS A PAGE ON ITS CONTENT, NOT ON FLUNCLE'S ───────────────────────────────
 * A label the crawler discovered and never certified a thing on still gets a page, and that is
 * deliberate. A label with 700 crawled releases and zero findings is a genuinely useful page —
 * an honest record of what that label put out — and refusing to serve it throws away the whole
 * point of having crawled it. The HOLLOW RENDERING was the doorway-page bug, never the page's
 * existence, and conditional sections (graph-sections.tsx) fixed that at the source.
 *
 * What stops a 2-row stub from being indexed is the shared thin-content gate over the maintained
 * indexed renderable-track count. Upcoming rows count because they are content on the page.
 *
 * A slug with no `labels` row at all is still MISSING, and still 404s.
 */
export async function resolveLabelPageData(
  slug: string,
  sort: CatalogueSort,
  page: number,
  upcomingPage = 1,
): Promise<LabelPageData> {
  const today = releaseTodayUtc(new Date());
  const label = await getLabelBySlug(slug);

  if (!label) {
    // A slug with no `labels` row of its own may still be a MERGED-AWAY spelling: a confirmed alias
    // whose canonical label lives under another slug (docs/label-entity.md § merge). Resolve it and
    // 301 to the canonical page; a genuinely unknown slug stays MISSING and 404s.
    const canonicalSlug = await resolveLabelAliasRedirect(slug);

    if (canonicalSlug && canonicalSlug !== slug) {
      return { canonicalSlug, status: "redirect" };
    }

    return { status: "missing" };
  }

  // Ride the catalogue read in the SAME parallel wave as the findings/artists/alias reads —
  // all four key only off `label.id` and are mutually independent. A page past the end of the
  // pager throws `CataloguePageOutOfRangeError`; map ONLY that to null here so it no longer
  // blocks the batch, and 404 once the wave settles. Any other error still throws.
  const cataloguePromise = listLabelCatalogue(label.id, sort, page, today).catch(
    (error: unknown): CatalogueGroupPage<CatalogueArtistGroup> | null => {
      if (error instanceof CataloguePageOutOfRangeError) {
        return null;
      }

      throw error;
    },
  );

  const [catalogue, findings, artists, alternateNames, upcoming, renderedCount] = await Promise.all(
    [
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
      countRenderedLabelTracks(label.id, today),
    ],
  );

  if (catalogue === null || upcoming === null) {
    // A page past the end of the pager is genuinely not-found, not a 500 — a crawler or a
    // hand-typed `?page=99` gets an honest 404, never a duplicate of page 1 under a new URL.
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
    // The rendered-membership count includes Upcoming and is the sitemap's gate as well.
    indexable: publicEntityIndexable(renderedCount, LABEL_INDEX_MIN_TRACKS),
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

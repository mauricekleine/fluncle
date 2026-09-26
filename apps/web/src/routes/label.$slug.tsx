import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  CatalogueArtistGroups,
  CataloguePager,
  CatalogueSortControl,
} from "@/components/catalogue-groups";
import {
  ArtistChips,
  FindingsGrid,
  UnlitTracks,
  graphPageTracks,
} from "@/components/graph-sections";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { FollowButton } from "@/components/follow-button";
import { entityFreshChannel } from "@/lib/fresh-feed-rss";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { labelBreadcrumbsJsonLd, recordLabelJsonLd } from "@/lib/log-schema";
import { bioMetaDescription } from "@/lib/meta-description";
import { albumCoverAtSize } from "@/lib/media";
import {
  CATALOGUE_SORT_DEFAULT,
  type CatalogueSort,
  catalogueSortParam,
  entityPageHref,
  flattenArtistGroups,
  parseCatalogueSort,
} from "@/lib/catalogue";
import { pageParam } from "@/lib/search-params";
import { type LabelPageData } from "./-label-page-data";

type LabelSearch = { page?: number; sort?: CatalogueSort; upcomingPage?: number };

const fetchLabel = createServerFn({ method: "GET" })
  .validator(
    (data: { page: number; slug: string; sort: CatalogueSort; upcomingPage: number }) => data,
  )
  .handler(async ({ data: { page, slug, sort, upcomingPage } }): Promise<LabelPageData> => {
    const { resolveLabelPageData } = await import("./-label-page-data");

    return resolveLabelPageData(slug, sort, page, upcomingPage);
  });

function labelHead(loaderData: LabelPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const {
    alternateNames,
    artists,
    bio,
    catalogue,
    upcoming,
    discogsLabelId,
    findings,
    foundedLocation,
    foundingDate,
    indexable,
    logoImageUrl,
    mbLabelId,
    name,
    parentLabel,
    slug,
    subLabels,
  } = loaderData;

  const pageUrl = entityPageHref(
    `${siteUrl}/label/${slug}`,
    catalogue.page,
    CATALOGUE_SORT_DEFAULT,
    CATALOGUE_SORT_DEFAULT,
    upcoming.page,
  );

  const baseTitle = `${name} · Fluncle`;

  const baseDescription =
    bio !== undefined
      ? bioMetaDescription(bio)
      : findings.length > 0
        ? `Drum & bass tracks on ${name} that Fluncle recommends, ${findings.length} so far, with the artists behind them.`
        : `Drum & bass records released on ${name}, with the artists behind them.`;

  const { description, title } =
    catalogue.page > 1
      ? {
          description: `Page ${catalogue.page} of the drum & bass artists released on ${name} that Fluncle holds.`,
          title: `${name}, page ${catalogue.page} · Fluncle`,
        }
      : { description: baseDescription, title: baseTitle };

  const coverFinding = findings[0];
  const imageUrl =
    albumCoverAtSize(logoImageUrl, "large") ??
    (coverFinding ? albumCoverAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  const leadImageUrl = albumCoverAtSize(
    findings.find((finding) => finding.logId)?.albumImageUrl,
    "medium",
  );

  return {
    links: [
      { href: pageUrl, rel: "canonical" },
      ...(leadImageUrl
        ? [{ as: "image", fetchPriority: "high" as const, href: leadImageUrl, rel: "preload" }]
        : []),

      {
        href: `${siteUrl}/label/${slug}/fresh.xml`,
        rel: "alternate",
        title: entityFreshChannel("label", name).title,
        type: "application/rss+xml",
      },
    ],
    meta: [
      { title },
      { content: description, name: "description" },

      ...(indexable ? [] : [{ content: "noindex, follow", name: "robots" }]),
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "website", property: "og:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],

    scripts: [
      jsonLdScript(
        recordLabelJsonLd({
          alternateNames,
          artists,
          bio,
          discogsLabelId,

          foundingDate,
          location: foundedLocation,

          logoImageUrl,
          mbLabelId,
          name,
          parentOrganization: parentLabel,
          slug,
          subOrganizations: subLabels,
          tracks: graphPageTracks(findings, flattenArtistGroups(catalogue.groups)),
        }),
      ),
      jsonLdScript(labelBreadcrumbsJsonLd(name)),
    ],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/label/$slug")({
  validateSearch: (search: Record<string, unknown>): LabelSearch => ({
    page: pageParam(search["page"]),
    sort: catalogueSortParam(search["sort"]),
    upcomingPage: pageParam(search["upcomingPage"]),
  }),

  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    sort: parseCatalogueSort(search.sort),
    upcomingPage: search.upcomingPage ?? 1,
  }),
  loader: async ({ deps, params }): Promise<LabelPageData> => {
    const data = await fetchLabel({
      data: {
        page: deps.page,
        slug: params.slug,
        sort: deps.sort,
        upcomingPage: deps.upcomingPage,
      },
    });

    if (data.status === "redirect") {
      throw redirect({ params: { slug: data.canonicalSlug }, statusCode: 301, to: "/label/$slug" });
    }

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LabelPageData }) => labelHead(loaderData),
  component: LabelPage,
  notFoundComponent: StoryNotFoundState,
});

function labelDateline(
  foundingDate: string | undefined,
  foundedLocation: string | undefined,
): string | undefined {
  const year = foundingDate?.slice(0, 4);

  if (year && foundedLocation) {
    return `Founded ${year} · ${foundedLocation}`;
  }

  if (year) {
    return `Founded ${year}`;
  }

  return foundedLocation;
}

function LabelPage() {
  const data = Route.useLoaderData();
  const navigate = Route.useNavigate();

  if (data.status !== "found") {
    return null;
  }

  const {
    artists,
    bio,
    catalogue,
    findings,
    foundedLocation,
    foundingDate,
    id,
    name,
    slug,
    sort,
    upcoming,
  } = data;
  const dateline = labelDateline(foundingDate, foundedLocation);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>

          {bio ? <p className="log-index-bio">{bio}</p> : undefined}

          {dateline ? <p className="log-index-dateline">{dateline}</p> : undefined}

          <FollowButton entityId={id} kind="label" name={name} />
        </header>

        <FindingsGrid findings={findings} />

        {upcoming.total > 0 ? (
          <section aria-labelledby="label-upcoming-heading" className="catalogue-section">
            <h2 className="artist-similar-label" id="label-upcoming-heading">
              Upcoming
            </h2>
            <FindingsGrid findings={upcoming.findings} label="Upcoming findings" />
            <UnlitTracks label="Upcoming tracks" tracks={upcoming.tracks} />
            <CataloguePager
              buildHref={(nextPage) =>
                entityPageHref(
                  `/label/${slug}`,
                  catalogue.page,
                  sort,
                  CATALOGUE_SORT_DEFAULT,
                  nextPage,
                )
              }
              label="Upcoming, more pages"
              page={upcoming.page}
              pageCount={upcoming.pageCount}
            />
          </section>
        ) : undefined}

        <ArtistChips artists={artists} title={`Artists on ${name}`} />

        {catalogue.groups.length > 0 ? (
          <section aria-labelledby="label-catalogue-heading" className="catalogue-section">
            <h2 className="sr-only" id="label-catalogue-heading">
              Artists released on {name}
            </h2>
            {catalogue.totalGroups > 1 ? (
              <CatalogueSortControl
                label="Sort artists"
                onChange={(next) => navigate({ search: { sort: next } })}
                sort={sort}
              />
            ) : undefined}

            <CatalogueArtistGroups groups={catalogue.groups} labelName={name} />

            <CataloguePager
              buildHref={(page) =>
                entityPageHref(`/label/${slug}`, page, sort, CATALOGUE_SORT_DEFAULT, upcoming.page)
              }
              label={`Artists on ${name}, more pages`}
              page={catalogue.page}
              pageCount={catalogue.pageCount}
            />
          </section>
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/labels">All labels</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}

import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  siBandcamp,
  siBeatport,
  siBluesky,
  siFacebook,
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import { ArtistAvatar } from "@/components/artist-avatar";
import { BrandIcon } from "@/components/brand-icon";
import {
  CataloguePager,
  CatalogueRecords,
  CatalogueSortControl,
} from "@/components/catalogue-groups";
import { FINDING_COVER_SIZES, FindingsGrid, UnlitTracks } from "@/components/graph-sections";
import { GraphLink } from "@/components/graph-link";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { FollowButton } from "@/components/follow-button";
import { type ArtistSocialPlatform } from "@/lib/artist-socials";
import { entityFreshChannel } from "@/lib/fresh-feed-rss";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { artistBreadcrumbsJsonLd, musicGroupJsonLd } from "@/lib/log-schema";
import { bioMetaDescription } from "@/lib/meta-description";
import { type CoverPreloadLink, albumCoverAtSize, coverPreloadLink } from "@/lib/media";
import { artistMetaDescription, artistPageTitle } from "@/lib/page-meta";
import { type CatalogueSort, catalogueSortParam, entityPageHref } from "@/lib/catalogue";
import {
  formatNameList,
  formatNameRange,
  pagedCanonical,
  shouldNoindexPage,
} from "@/lib/paged-indexing";
import { pageParam } from "@/lib/search-params";
import { type ArtistPageData, type ArtistSocialLink } from "./-artist-page-data";

const SOCIAL_META: Record<
  Exclude<ArtistSocialPlatform, "homepage">,
  { path: string; title: string }
> = {
  bandcamp: siBandcamp,
  beatport: siBeatport,
  bluesky: siBluesky,
  facebook: siFacebook,
  instagram: siInstagram,
  mixcloud: siMixcloud,
  soundcloud: siSoundcloud,
  spotify: siSpotify,
  tiktok: siTiktok,
  twitch: siTwitch,
  twitter: siX,
  youtube: siYoutube,
};

const SOCIAL_LABEL: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  beatport: "Beatport",
  bluesky: "Bluesky",
  facebook: "Facebook",
  homepage: "Website",
  instagram: "Instagram",
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  tiktok: "TikTok",
  twitch: "Twitch",
  twitter: "X",
  youtube: "YouTube",
};

const fetchArtist = createServerFn({ method: "GET" })
  .validator(
    (data: { page: number; slug: string; sort: CatalogueSort; upcomingPage: number }) => data,
  )
  .handler(async ({ data: { page, slug, sort, upcomingPage } }): Promise<ArtistPageData> => {
    const { resolveArtistPageData } = await import("./-artist-page-data");

    return resolveArtistPageData(slug, sort, page, upcomingPage);
  });

function artistRecordNames(
  groups: Extract<ArtistPageData, { status: "found" }>["catalogue"]["groups"],
): string[] {
  return groups.flatMap((group) => (group.name !== undefined ? [group.name] : []));
}

function artistRecordRange(
  groups: Extract<ArtistPageData, { status: "found" }>["catalogue"]["groups"],
): string {
  const names = artistRecordNames(groups);

  return formatNameRange(names[0], names[names.length - 1]);
}

function artistRecordDescription(
  artistName: string,
  groups: Extract<ArtistPageData, { status: "found" }>["catalogue"]["groups"],
  page: number,
  pageCount: number,
): string {
  const names = artistRecordNames(groups);
  const listed = names.slice(0, 3);
  const remaining = names.length - listed.length;
  const nameSnippet = formatNameList(listed, remaining);
  const position = `page ${page} of ${pageCount}`;

  return nameSnippet
    ? `Drum & bass records by ${artistName} including ${nameSnippet}, ${position}.`
    : `Page ${page} of the drum & bass records by ${artistName} that Fluncle holds.`;
}

function artistHead(loaderData: ArtistPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const {
    alternateNames,
    bio,
    catalogue,
    dossier,
    upcoming,
    findings,
    imageUrl: artistImageUrl,
    indexable,
    name,
    slug,
    sort,
    socials,
    discogsUrl,
    lastfmUrl,
    mbid,
    spotifyUrl,
    wikidataQid,
  } = loaderData;

  const pageUrl = pagedCanonical(`${siteUrl}/artist/${slug}`, catalogue.page);

  const recordRange = catalogue.page > 1 ? artistRecordRange(catalogue.groups) : "";

  const { description, title } =
    catalogue.page > 1
      ? {
          description: artistRecordDescription(
            name,
            catalogue.groups,
            catalogue.page,
            catalogue.pageCount,
          ),
          title: recordRange
            ? `${name}, page ${catalogue.page}: ${recordRange} · Fluncle`
            : `${name}, page ${catalogue.page} · Fluncle`,
        }
      : {
          description: artistMetaDescription({
            bio,
            findingCount: dossier.findingCount,
            name,
            trackCount: catalogue.totalTracks + dossier.findingCount + upcoming.total,
          }),
          title: artistPageTitle(name),
        };

  const noindex =
    !indexable ||
    shouldNoindexPage({
      nonDefaultSort: sort !== ARTIST_CATALOGUE_SORT_DEFAULT,
      page: catalogue.page,
      upcomingPage: upcoming.page,
    });

  const coverFinding = findings[0];
  const imageUrl =
    artistImageUrl ??
    (coverFinding ? albumCoverAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  const heroImageUrl = albumCoverAtSize(imageUrl, "medium");
  const leadPreload: CoverPreloadLink | undefined =
    leadGridCoverPreload(findings) ??
    (heroImageUrl
      ? { as: "image", fetchPriority: "high", href: heroImageUrl, rel: "preload" }
      : undefined);

  const musicGroup = musicGroupJsonLd(
    {
      alternateNames,
      bio,
      discogsUrl,
      imageUrl,
      lastfmUrl,
      mbid,
      name,
      slug,
      socials: socials.map((social) => social.url),
      spotifyUrl,
      wikidataQid,
    },
    findings.flatMap((finding) =>
      finding.logId
        ? [{ artists: finding.artists, logId: finding.logId, title: finding.title }]
        : [],
    ),
  );

  return {
    links: [
      { href: pageUrl, rel: "canonical" },

      ...(leadPreload ? [leadPreload] : []),

      {
        href: `${siteUrl}/artist/${slug}/fresh.xml`,
        rel: "alternate",
        title: entityFreshChannel("artist", name).title,
        type: "application/rss+xml",
      },

      {
        href: `${siteUrl}/oembed?url=${encodeURIComponent(pageUrl)}&format=json`,
        rel: "alternate",
        title,
        type: "application/json+oembed",
      },
    ],
    meta: [
      { title },
      { content: description, name: "description" },

      ...(noindex ? [{ content: "noindex, follow", name: "robots" }] : []),
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "profile", property: "og:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],

    scripts: [jsonLdScript(musicGroup), jsonLdScript(artistBreadcrumbsJsonLd(name))],
  };
}

export const ARTIST_CATALOGUE_SORT_DEFAULT: CatalogueSort = "recent";

function leadGridCoverPreload(
  findings: Extract<ArtistPageData, { status: "found" }>["findings"],
): CoverPreloadLink | undefined {
  return coverPreloadLink(
    findings.find((finding) => finding.logId)?.albumImageUrl,
    "medium",
    FINDING_COVER_SIZES,
  );
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/artist/$slug")({
  validateSearch: (search: Record<string, unknown>): ArtistSearch => ({
    page: pageParam(search["page"]),
    sort: catalogueSortParam(search["sort"]),
    upcomingPage: pageParam(search["upcomingPage"]),
  }),

  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    sort: search.sort ?? ARTIST_CATALOGUE_SORT_DEFAULT,
    upcomingPage: search.upcomingPage ?? 1,
  }),
  loader: async ({ deps, params }): Promise<ArtistPageData> => {
    const data = await fetchArtist({
      data: {
        page: deps.page,
        slug: params.slug,
        sort: deps.sort,
        upcomingPage: deps.upcomingPage,
      },
    });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: ArtistPageData }) => artistHead(loaderData),
  component: ArtistPage,
  notFoundComponent: StoryNotFoundState,
});

type ArtistSearch = { page?: number; sort?: CatalogueSort; upcomingPage?: number };

function SocialLink({ social }: { social: ArtistSocialLink }) {
  const label = SOCIAL_LABEL[social.platform];

  return (
    <a className="artist-social" href={social.url} rel="noreferrer" target="_blank" title={label}>
      {social.platform === "homepage" ? (
        <GlobeSimpleIcon aria-hidden="true" weight="bold" />
      ) : (
        <BrandIcon icon={SOCIAL_META[social.platform]} />
      )}
      <span>{label}</span>
    </a>
  );
}

function ArtistPage() {
  const data = Route.useLoaderData();
  const navigate = Route.useNavigate();

  if (data.status !== "found") {
    return null;
  }

  const {
    bio,
    catalogue,
    dossier,
    findings,
    id,
    imageUrl,
    name,
    related,
    slug,
    socials,
    sort,
    upcoming,
  } = data;

  const findingsBandLeads = leadGridCoverPreload(findings) !== undefined;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <ArtistAvatar
            className="artist-masthead-avatar"

            eager
            name={name}
            priority={!findingsBandLeads}
            src={albumCoverAtSize(imageUrl, "medium")}
          />
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>

          {bio ? <p className="log-index-bio">{bio}</p> : undefined}

          <FollowButton entityId={id} kind="artist" name={name} />
        </header>

        <FindingsGrid findings={findings} />

        {upcoming.total > 0 ? (
          <section aria-labelledby="artist-upcoming-heading" className="catalogue-section">
            <h2 className="artist-similar-label" id="artist-upcoming-heading">
              Upcoming
            </h2>
            <FindingsGrid findings={upcoming.findings} label="Upcoming findings" />
            <UnlitTracks label="Upcoming tracks" tracks={upcoming.tracks} />
            <CataloguePager
              buildHref={(nextPage) =>
                entityPageHref(
                  `/artist/${slug}`,
                  catalogue.page,
                  sort,
                  ARTIST_CATALOGUE_SORT_DEFAULT,
                  nextPage,
                )
              }
              label="Upcoming, more pages"
              page={upcoming.page}
              pageCount={upcoming.pageCount}
            />
          </section>
        ) : undefined}

        {socials.length > 0 ? (
          <nav aria-label={`Follow ${name}`} className="artist-follow">
            <h2 className="artist-similar-label">Follow {name}</h2>
            <div className="artist-socials">
              {socials.map((social) => (
                <SocialLink key={social.platform} social={social} />
              ))}
            </div>
          </nav>
        ) : undefined}

        {dossier.neighbours.length > 0 ? (
          <nav aria-label="Similar artists" className="artist-similar" data-discovery="similar">
            <h2 className="artist-similar-label">Similar artists</h2>
            <ul className="artist-similar-list">
              {dossier.neighbours.map((neighbour) => (
                <li key={neighbour.slug}>
                  <GraphLink
                    className={
                      neighbour.certified
                        ? "artist-similar-link"
                        : "artist-similar-link artist-similar-link--unlit"
                    }
                    kind="artist"
                    slug={neighbour.slug}
                    variant="chip"
                  >
                    <ArtistAvatar
                      className={
                        neighbour.certified
                          ? "artist-similar-avatar"
                          : "artist-similar-avatar artist-similar-avatar--unlit"
                      }
                      name={neighbour.name}

                      src={albumCoverAtSize(neighbour.imageUrl, "small")}
                    />
                    <span>{neighbour.name}</span>
                  </GraphLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : undefined}

        {catalogue.groups.length > 0 ? (
          <section aria-labelledby="artist-catalogue-heading" className="catalogue-section">
            <h2 className="sr-only" id="artist-catalogue-heading">
              More from {name}
            </h2>
            {catalogue.totalGroups > 1 ? (
              <CatalogueSortControl
                label="Sort records"
                onChange={(next) => navigate({ search: { sort: next } })}
                sort={sort}
              />
            ) : undefined}

            <CatalogueRecords artistName={name} records={catalogue.groups} />

            <CataloguePager
              buildHref={(page) =>
                entityPageHref(
                  `/artist/${slug}`,
                  page,
                  sort,
                  ARTIST_CATALOGUE_SORT_DEFAULT,
                  upcoming.page,
                )
              }
              label={`More from ${name}, more pages`}
              page={catalogue.page}
              pageCount={catalogue.pageCount}
            />
          </section>
        ) : undefined}

        <FindingsGrid findings={related} priority={false} />

        <footer className="log-plate-footer">
          <Link to="/artists">All artists</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}

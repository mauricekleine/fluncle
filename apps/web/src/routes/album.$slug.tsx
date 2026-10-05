import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArtistChips,
  FindingsGrid,
  graphPageTracks,
  UnlitTracks,
} from "@/components/graph-sections";
import { GraphLink } from "@/components/graph-link";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { albumBreadcrumbsJsonLd, musicAlbumJsonLd } from "@/lib/log-schema";
import { FINDING_COVER_SIZES } from "@/components/graph-sections";
import { albumCoverAtSize, coverPreloadLink } from "@/lib/media";
import { albumArtistCredit, albumMetaDescription, albumPageTitle } from "@/lib/page-meta";
import { type AlbumPageData } from "./-album-page-data";

const fetchAlbum = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data: { slug } }): Promise<AlbumPageData> => {
    const { resolveAlbumPageData } = await import("./-album-page-data");

    return resolveAlbumPageData(slug);
  });

function albumHead(loaderData: AlbumPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const {
    artists,
    bio,
    catalogNumber,
    catalogue,
    catalogueTotal,
    coverImageUrl,
    findings,
    indexable,
    label,
    name,
    releaseDate,
    releaseGroupMbid,
    slug,
    upc,
  } = loaderData;
  const pageUrl = `${siteUrl}/album/${slug}`;

  const tracks = [...findings, ...catalogue];
  const tracklistComplete = catalogue.length >= catalogueTotal;
  const artist = tracklistComplete ? albumArtistCredit(tracks) : undefined;
  const title = albumPageTitle({ artist, name, releaseDate });
  const description = albumMetaDescription({
    artist,
    bio,
    findingCount: findings.length,
    label: label?.name,
    name,
    releaseDate,
    trackCount: findings.length + catalogueTotal,
    trackTitles: tracks.map((track) => track.title),
  });
  const imageUrl = albumCoverAtSize(coverImageUrl, "large") ?? `${siteUrl}/fluncle-cover.png`;

  const leadPreload = coverPreloadLink(
    findings.find((finding) => finding.logId)?.albumImageUrl,
    "medium",
    FINDING_COVER_SIZES,
  );

  return {
    links: [{ href: pageUrl, rel: "canonical" }, ...(leadPreload ? [leadPreload] : [])],
    meta: [
      { title },
      { content: description, name: "description" },
      ...(indexable ? [] : [{ content: "noindex, follow", name: "robots" }]),
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "music.album", property: "og:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],
    scripts: [
      jsonLdScript(
        musicAlbumJsonLd({
          artists,
          bio,
          catalogNumber,

          imageUrl: albumCoverAtSize(coverImageUrl, "large"),
          label: label ? { name: label.name, slug: label.slug } : undefined,
          name,
          releaseDate,
          releaseGroupMbid,
          slug,
          tracks: graphPageTracks(findings, catalogue),
          upc,
        }),
      ),
      jsonLdScript(albumBreadcrumbsJsonLd(name)),
    ],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/album/$slug")({
  loader: async ({ params }): Promise<AlbumPageData> => {
    const data = await fetchAlbum({ data: { slug: params.slug } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: AlbumPageData }) => albumHead(loaderData),
  component: AlbumPage,
  notFoundComponent: StoryNotFoundState,
});

function AlbumPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { artists, bio, catalogNumber, catalogue, findings, label, name, related } = data;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>

          {label ? (
            <p className="graph-uplink">
              On{" "}
              <GraphLink kind="label" slug={label.slug}>
                {label.name}
              </GraphLink>
              {catalogNumber ? (
                <>
                  {" "}
                  · <span className="graph-uplink-catno">{catalogNumber}</span>
                </>
              ) : undefined}
            </p>
          ) : undefined}

          {bio ? <p className="log-index-bio">{bio}</p> : undefined}
        </header>

        <FindingsGrid findings={findings} />

        <ArtistChips artists={artists} title={`Artists on ${name}`} />

        <UnlitTracks label={`More tracks on ${name}`} tracks={catalogue} />

        <FindingsGrid findings={related} priority={false} />

        <footer className="log-plate-footer">
          <Link to="/albums">All albums</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}

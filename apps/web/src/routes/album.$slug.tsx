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
import { albumCoverAtSize } from "@/lib/media";
import { bioMetaDescription } from "@/lib/meta-description";
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

  const title = `${name} · Fluncle`;

  const releaseYear = releaseDate?.slice(0, 4);
  const factClause = [
    releaseYear === undefined ? undefined : `a ${releaseYear} release`,
    label === undefined
      ? undefined
      : `${releaseYear === undefined ? "pressed " : ""}on ${label.name}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const description =
    bio !== undefined
      ? bioMetaDescription(bio)
      : findings.length > 0
        ? `Drum & bass tracks on ${name} that Fluncle recommends, ${findings.length} so far, with the artists behind them.`
        : factClause
          ? `The tracks on ${name}, ${factClause}, with the artists behind them.`
          : `The tracks on ${name}, with the artists behind them.`;
  const imageUrl = albumCoverAtSize(coverImageUrl, "large") ?? `${siteUrl}/fluncle-cover.png`;

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
    ],
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

  const { artists, bio, catalogNumber, catalogue, findings, label, name } = data;

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

        <footer className="log-plate-footer">
          <Link to="/albums">All albums</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}

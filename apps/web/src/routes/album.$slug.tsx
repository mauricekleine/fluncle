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

// The album page — one record's place in the archive, and the fourth node of the graph
// (log ↔ artist ↔ label ↔ album). The twin of `/label/<slug>`, plus one edge the label page
// has no use for: the album's LABEL, rendered as a link and stamped into the JSON-LD as
// `albumRelease.recordLabel` pointing at that label page's Organization `@id`. That edge is
// where the graph closes. See docs/album-entity.md.

// The resolver is reached by a DYNAMIC import inside the handler, and the type by `import
// type` — so nothing in this route module statically references `lib/server/**`. The client
// build removes a handler body wholesale, which takes the import (and the whole database chain
// behind it) out of the browser bundle; see `-album-page-data.ts` for the measurement.
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
  // Honestly-plain third-person for the machine-facing strings (the Narrator rule).
  const title = `${name} · Fluncle`;
  // The factual bio is the honest, UNIQUE description when one is authored — the same objective
  // paragraph the page prints, trimmed to the meta cap. Absent (the bio backfill is in flight),
  // it falls back to the templated line verbatim, so nothing regresses. It describes the page it
  // is actually on, and never names the tier the quieter rows belong to — that tier has no public
  // name (docs/album-entity.md), so "catalogue" cannot leak into a SERP snippet.
  // The bare fallback folds in the facts the loader already carries (year, label) so even a
  // bio-less, findings-less record clears the search engines' short-description floor with
  // something true rather than padding.
  const releaseYear = releaseDate?.slice(0, 4);
  const factClause = [
    releaseYear === undefined ? undefined : `a ${releaseYear} release`,
    label === undefined
      ? undefined
      : // "pressed on" when the label stands alone — "The tracks on X, on Y" doubles the "on".
        `${releaseYear === undefined ? "pressed " : ""}on ${label.name}`,
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
  // THE LEAD IMAGE — the findings band's first cover, which is this page's LCP candidate and is
  // already above the fold on every viewport. Preloaded at the `medium` rung, byte-identical to what
  // FindingsGrid asks for, so it is a cache hit rather than a second fetch. Same one-preload shape
  // as /artist/<slug> and the homepage cover; FindingsGrid marks the matching tile non-lazy.
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
          // The owned cover master when the album resolved one (bestAlbumCoverUrl already chose it
          // for the finding's DTO), taken to `large` — never a raw i.scdn.co URL when a master exists.
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

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
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

  const { artists, bio, catalogue, findings, label, name } = data;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          {/* The album → label edge, the one link the label page has no twin for. The label's
              NAME is the graph link; the "On" that introduces it is not part of the entity. */}
          {label ? (
            <p className="graph-uplink">
              On{" "}
              <GraphLink kind="label" slug={label.slug}>
                {label.name}
              </GraphLink>
            </p>
          ) : undefined}
          {/* The voiced bio sits beneath the masthead — body prose that augments the signature
              line, never replaces it. Only rendered once one is authored. */}
          {bio ? <p className="log-index-bio">{bio}</p> : undefined}
        </header>

        {/* Every band below is conditional: an empty one renders nothing at all, so this page
            is only ever about what it actually carries (components/graph-sections.tsx). */}
        <FindingsGrid findings={findings} />

        <ArtistChips artists={artists} title={`Artists on ${name}`} />

        {/* The quieter rows: no heading, no noun, nothing at all when empty. */}
        <UnlitTracks label={`More tracks on ${name}`} tracks={catalogue} />

        <footer className="log-plate-footer">
          <Link to="/albums">All albums</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}

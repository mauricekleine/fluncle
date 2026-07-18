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
import { ALBUM_INDEX_MIN_TRACKS, getAlbumBySlug } from "@/lib/server/albums";
import { type ArtistChip, listArtistsByAlbum } from "@/lib/server/artists";
import { getLabelForAlbum, type LabelRecord } from "@/lib/server/labels";
import {
  type CatalogueTrackItem,
  getFindingsByAlbum,
  listCatalogueTracksByAlbum,
  type TrackListItem,
} from "@/lib/server/tracks";

// The album page — one record's place in the archive, and the fourth node of the graph
// (log ↔ artist ↔ label ↔ album). The twin of `/label/<slug>`, plus one edge the label page
// has no use for: the album's LABEL, rendered as a link and stamped into the JSON-LD as
// `albumRelease.recordLabel` pointing at that label page's Organization `@id`. That edge is
// where the graph closes. See docs/album-entity.md.

type AlbumPageData =
  | {
      artists: ArtistChip[];
      /**
       * The album's voiced factual bio — a short paragraph beneath the masthead, undefined until
       * one is authored (lib/server/bio.ts). The page renders it only when present.
       */
      bio: string | undefined;
      /** Uncertified tracks on this album. Empty until the catalogue lands. */
      catalogue: CatalogueTrackItem[];
      coverImageUrl: string | undefined;
      findings: TrackListItem[];
      indexable: boolean;
      label: LabelRecord | undefined;
      name: string;
      /** The record's earliest track release date → the MusicAlbum's `datePublished`. */
      releaseDate: string | undefined;
      /** The MusicBrainz release-group MBID → the MusicAlbum's `sameAs`. */
      releaseGroupMbid: string | undefined;
      slug: string;
      status: "found";
      /** The album's barcode → the MusicAlbum's `gtin13`. */
      upc: string | undefined;
    }
  | { status: "missing" };

/**
 * Resolve the album page's data. Extracted from the server fn so the indexability decision
 * is unit-testable (see -graph-pages.test.ts), the `resolveArtistPageData` precedent.
 *
 * A record earns a page on its CONTENT, exactly as a label does (`/label/<slug>` carries the
 * long version of this note): a tracklist is a real page, and what keeps a stub out of the index
 * is the thin-content gate below, counting TOTAL renderable tracks. A crawl-minted, findings-free
 * record has an `albums` row (minted inline at crawl time) and renders on its tracklist, indexing
 * once it clears the floor — exactly as a discovered label does on its releases.
 *
 * A slug with no `albums` row at all is still MISSING, and still 404s.
 */
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

  return {
    artists,
    bio: album.bio,
    catalogue: catalogue.tracks,
    // The record's cover is its freshest finding's album art — never invented, never
    // re-hosted (the `i.scdn.co` attribution-by-link precedent). A record with no finding
    // has no cover of its own to show, and shows none.
    coverImageUrl: findings[0]?.albumImageUrl,
    findings,
    // Thin-content gate: index only past ALBUM_INDEX_MIN_TRACKS RENDERABLE tracks — the
    // findings PLUS the quieter rows, because both are real content on the page. The
    // sitemap keys off the same sum (the entity's TRUE catalogue total, never the
    // rendered slice), so an indexable page is never orphaned from it.
    indexable: findings.length + catalogue.total >= ALBUM_INDEX_MIN_TRACKS,
    label,
    name: album.name,
    // The album's identity anchors + its earliest release date, read in the same `getAlbumBySlug`
    // pass (the `datePublished`/`sameAs`/`gtin13` the JSON-LD emits). Undefined when the record
    // carries none.
    releaseDate: album.releaseDate,
    releaseGroupMbid: album.releaseGroupMbid,
    slug: album.slug,
    status: "found",
    upc: album.upc,
  };
}

const fetchAlbum = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(({ data: { slug } }): Promise<AlbumPageData> => resolveAlbumPageData(slug));

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
  const title = `${name} · Fluncle's Findings`;
  // The factual bio is the honest, UNIQUE description when one is authored — the same objective
  // paragraph the page prints, trimmed to the meta cap. Absent (the bio backfill is in flight),
  // it falls back to the templated line verbatim, so nothing regresses. It describes the page it
  // is actually on, and never names the tier the quieter rows belong to — that tier has no public
  // name (docs/album-entity.md), so "catalogue" cannot leak into a SERP snippet.
  const description =
    bio !== undefined
      ? bioMetaDescription(bio)
      : findings.length > 0
        ? `Every banger Fluncle has found on ${name} and logged in the Galaxy, ${findings.length} so far, each with a coordinate.`
        : `The tracks on ${name}, charted in Fluncle's Galaxy.`;
  const imageUrl = albumCoverAtSize(coverImageUrl, "large") ?? `${siteUrl}/fluncle-cover.png`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
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
        <FindingsGrid findings={findings} label={`Findings on ${name}`} />

        <ArtistChips artists={artists} title={`Artists on ${name}`} />

        {/* The quieter rows: no heading, no noun, nothing at all when empty. */}
        <UnlitTracks label={`More tracks on ${name}`} tracks={catalogue} />

        <footer className="log-plate-footer">
          <Link to="/albums">All albums</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}

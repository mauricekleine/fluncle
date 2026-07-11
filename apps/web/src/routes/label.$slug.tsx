import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArtistChips,
  FindingsGrid,
  graphPageTracks,
  UnlitTracks,
} from "@/components/graph-sections";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { labelBreadcrumbsJsonLd, recordLabelJsonLd } from "@/lib/log-schema";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { type ArtistChip, listArtistsByLabel } from "@/lib/server/artists";
import { getLabelBySlug, LABEL_INDEX_MIN_TRACKS } from "@/lib/server/labels";
import {
  type CatalogueTrackItem,
  getFindingsByLabel,
  listCatalogueTracksByLabel,
  type TrackListItem,
} from "@/lib/server/tracks";

// The label page — one imprint's place in the archive, and the third node of the graph
// (log ↔ artist ↔ label ↔ album). It mirrors `/artist/<slug>` exactly: a plate masthead
// over a cover-led grid of findings, the artists as chips, the entity's `@id` graph in
// JSON-LD, and the same thin-content gate. See docs/label-entity.md.
//
// It is BLIND to `seed_state`. A label the operator skipped for the crawler renders here
// exactly as it always did — crawl scope, never storage (lib/server/labels.ts).

type LabelPageData =
  | {
      artists: ArtistChip[];
      /** Uncertified tracks on this label. Empty until the catalogue lands. */
      catalogue: CatalogueTrackItem[];
      findings: TrackListItem[];
      indexable: boolean;
      name: string;
      slug: string;
      status: "found";
    }
  | { status: "missing" };

/**
 * Resolve the label page's data. Extracted from the server fn so the indexability decision
 * is unit-testable (see -label-page.test.ts), the `resolveArtistPageData` precedent.
 */
export async function resolveLabelPageData(slug: string): Promise<LabelPageData> {
  const label = await getLabelBySlug(slug);

  if (!label) {
    return { status: "missing" };
  }

  const [findings, catalogue, artists] = await Promise.all([
    getFindingsByLabel(label.id),
    listCatalogueTracksByLabel(label.id),
    listArtistsByLabel(label.id),
  ]);

  return {
    artists,
    catalogue,
    findings,
    // Thin-content gate: index only past LABEL_INDEX_MIN_TRACKS RENDERABLE tracks — the
    // findings plus the quieter rows, because both are real content on the page. Below it
    // the page still serves 200 but is noindex + out of the sitemap (the
    // ARTIST_INDEX_MIN_FINDINGS precedent; the sitemap keys off the same numbers).
    indexable: findings.length + catalogue.length >= LABEL_INDEX_MIN_TRACKS,
    name: label.name,
    slug: label.slug,
    status: "found",
  };
}

const fetchLabel = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(({ data: { slug } }): Promise<LabelPageData> => resolveLabelPageData(slug));

/**
 * The first-person voice frame — Fluncle framing HIS relationship to the imprint, never a
 * fabricated bio (VOICE.md). It counts FINDINGS only: the quieter rows below are never
 * introduced, never named, and never counted aloud.
 */
function labelSignatureLine(name: string, findings: TrackListItem[]): string {
  const dated = findings
    .map((finding) => finding.addedAt)
    .filter((addedAt): addedAt is string => Boolean(addedAt))
    .sort();
  const firstFoundAt = dated[0];
  const count = findings.length;

  if (count === 0) {
    return "Nothing logged off this one yet.";
  }

  if (!firstFoundAt) {
    return count === 1
      ? "One tune off this imprint so far. Play it loud."
      : `${count} tunes off this imprint so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (count === 1) {
    return `I pulled my first tune off ${name} on ${when}. Just the one so far. Play it loud.`;
  }

  return `I pulled my first tune off ${name} on ${when}, and I've logged ${count} off the imprint since. Have a dig.`;
}

function labelHead(loaderData: LabelPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { artists, catalogue, findings, indexable, name, slug } = loaderData;
  const pageUrl = `${siteUrl}/label/${slug}`;
  // The <title>/meta stay honestly-plain third-person (the Narrator rule); the first person
  // lives only in the on-page voice frame.
  const title = `${name} · Fluncle's Findings`;
  const description =
    findings.length > 0
      ? `Every banger Fluncle has found on ${name} and logged in the Galaxy, ${findings.length} so far, each with a coordinate.`
      : `${name} in Fluncle's Galaxy.`;
  const coverFinding = findings[0];
  const imageUrl =
    (coverFinding ? spotifyAlbumImageAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      // Below the thin-content threshold: keep the page reachable + link equity flowing,
      // but out of the index (noindex, follow).
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
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized payload before
    // it reaches the inline <script>, so a `</script>` in a vendor-sourced label or track
    // name can't break out (stored-XSS sink, security review).
    scripts: [
      jsonLdScript(
        recordLabelJsonLd({
          artists,
          name,
          slug,
          tracks: graphPageTracks(findings, catalogue),
        }),
      ),
      jsonLdScript(labelBreadcrumbsJsonLd(name)),
    ],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/label/$slug")({
  loader: async ({ params }): Promise<LabelPageData> => {
    const data = await fetchLabel({ data: { slug: params.slug } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LabelPageData }) => labelHead(loaderData),
  component: LabelPage,
  notFoundComponent: StoryNotFoundState,
});

function LabelPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { artists, catalogue, findings, name } = data;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          <p className="log-index-intro">{labelSignatureLine(name, findings)}</p>
        </header>

        {/* The findings lead. Always. */}
        <FindingsGrid findings={findings} label={`Findings on ${name}`} />

        <ArtistChips artists={artists} title={`Artists on ${name}`} />

        {/* The quieter rows: no heading, no noun, nothing at all when empty. */}
        <UnlitTracks label={`More tracks on ${name}`} tracks={catalogue} />

        <footer className="log-plate-footer">
          <Link to="/labels">All labels</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}

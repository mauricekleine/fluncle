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
import { firstFoundAt, labelSignatureLine } from "@/lib/graph-prose";
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
      /** Uncertified tracks on this label — a capped SLICE (`GRAPH_PAGE_CATALOGUE_LIMIT`). */
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
 *
 * ── A LABEL EARNS A PAGE ON ITS CONTENT, NOT ON FLUNCLE'S ───────────────────────────────
 * A label the crawler discovered and never certified a thing on still gets a page, and that
 * is deliberate. A label with 700 crawled releases and zero findings is a genuinely useful
 * page — a real record of what that label put out — and refusing to serve it throws away the
 * whole point of having crawled it.
 *
 * The page existing was never the problem. The HOLLOW RENDERING was: the page used to print
 * "Nothing logged off this one yet." as a heading above a wall of Spotify outlinks, which is
 * a doorway page by Google's own definition — a page whose stated subject is a thing that is
 * not on it. The fix is CONDITIONAL SECTIONS (components/graph-sections.tsx): a band with
 * nothing in it renders nothing at all, so a page with no findings never mentions findings,
 * and is then honestly about the tracks it does carry.
 *
 * What stops a 2-row stub from being indexed is the thin-content gate below, and it counts
 * TOTAL content rather than findings — see LABEL_INDEX_MIN_TRACKS.
 *
 * A slug with no `labels` row at all is still MISSING, and still 404s.
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
    catalogue: catalogue.tracks,
    findings,
    // Thin-content gate: index only past LABEL_INDEX_MIN_TRACKS RENDERABLE tracks — the
    // findings PLUS the quieter rows, because both are real content on the page, and a page
    // is thin or not thin on what it renders, never on who wrote it. Below the floor the
    // page still serves 200 (deep links, link equity) but is noindex + out of the sitemap;
    // the sitemap keys off the same sum, so the two can never disagree.
    //
    // It counts the entity's TRUE catalogue total, never the rendered slice — a 3,000-row
    // label and a 100-row one must not read as the same page to the gate.
    indexable: findings.length + catalogue.total >= LABEL_INDEX_MIN_TRACKS,
    name: label.name,
    slug: label.slug,
    status: "found",
  };
}

const fetchLabel = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(({ data: { slug } }): Promise<LabelPageData> => resolveLabelPageData(slug));

function labelHead(loaderData: LabelPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { artists, catalogue, findings, indexable, name, slug } = loaderData;
  const pageUrl = `${siteUrl}/label/${slug}`;
  // The <title>/meta stay honestly-plain third-person (the Narrator rule); the first person
  // lives only in the on-page voice frame.
  const title = `${name} · Fluncle's Findings`;
  // It describes the page it is actually on: with findings, the findings; without, the records
  // this label put out. It never claims findings a page does not have, and it never names the
  // tier the quieter rows belong to (that tier has no public name — docs/album-entity.md), so
  // "catalogue" cannot leak into a SERP snippet.
  const description =
    findings.length > 0
      ? `Every banger Fluncle has found on ${name} and logged in the Galaxy, ${findings.length} so far, each with a coordinate.`
      : `The records released on ${name}, charted in Fluncle's Galaxy.`;
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
  const signature = labelSignatureLine(name, findings.length, firstFoundAt(findings));

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          {/* No findings, no line. The masthead is just the name (lib/graph-prose.ts). */}
          {signature ? <p className="log-index-intro">{signature}</p> : undefined}
        </header>

        {/* Every band below is conditional: an empty one renders nothing at all, so this page
            is only ever about what it actually carries (components/graph-sections.tsx). */}
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

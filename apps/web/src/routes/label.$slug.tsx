import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  CatalogueArtistGroups,
  CataloguePager,
  CatalogueSortControl,
} from "@/components/catalogue-groups";
import { ArtistChips, FindingsGrid, graphPageTracks } from "@/components/graph-sections";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { entityFreshChannel } from "@/lib/fresh-feed-rss";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { labelBreadcrumbsJsonLd, recordLabelJsonLd } from "@/lib/log-schema";
import { bioMetaDescription } from "@/lib/meta-description";
import { albumCoverAtSize } from "@/lib/media";
import { type ArtistChip, listArtistsByLabel } from "@/lib/server/artists";
import {
  type CatalogueArtistGroup,
  CataloguePageOutOfRangeError,
  type CatalogueGroupPage,
  type CatalogueSort,
  flattenArtistGroups,
  listLabelCatalogue,
  parseCatalogueSort,
} from "@/lib/server/catalogue-groups";
import {
  getConfirmedAliasNames,
  getLabelBySlug,
  LABEL_INDEX_MIN_TRACKS,
  type LabelLineageEdge,
} from "@/lib/server/labels";
import { getFindingsByLabel, type TrackListItem } from "@/lib/server/tracks";

// The label page — one label's place in the archive, and the third node of the graph
// (log ↔ artist ↔ label ↔ album). Findings lead, then the label's crawled catalogue GROUPED
// BY ARTIST (each artist a collapsing section, its records inside), then the graph JSON-LD and
// the same thin-content gate. See docs/label-entity.md and docs/album-entity.md.
//
// ── WHY GROUPED ────────────────────────────────────────────────────────────────────────
// A crawled label is a discography, not a list. The pilot pulled 735 tracks off ONE small
// label; Hospital will be several times that. Rendered flat that is a dump, so the quieter
// rows are grouped by artist and paginated, and the bound the flat read carried (a 100-row
// cap after a 4.34 MB page) moves into `catalogue-groups.ts` rather than disappearing: a page
// of `GRAPH_GROUP_PAGE_SIZE` artist sections, each capped inside, with a crawlable pager for
// the rest. Nothing is unbounded and nothing is unreachable.
//
// It is BLIND to `seed_state`. A label the operator skipped for the crawler renders here
// exactly as it always did — crawl scope, never storage (lib/server/labels.ts).

type LabelPageData =
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
      /** The label's founding place (MusicBrainz `area.name`) — the dateline + Organization `location`. */
      foundedLocation: string | undefined;
      /** The label's founding date (MusicBrainz `life-span.begin`) — the dateline + `foundingDate`. */
      foundingDate: string | undefined;
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
 * What stops a 2-row stub from being indexed is the thin-content gate below, and it counts
 * TOTAL content rather than findings — the findings plus the entity's TRUE uncertified total
 * (`catalogue.totalTracks`, counted in SQL over the whole label, never the rendered page).
 *
 * A slug with no `labels` row at all is still MISSING, and still 404s.
 */
export async function resolveLabelPageData(
  slug: string,
  sort: CatalogueSort,
  page: number,
): Promise<LabelPageData> {
  const label = await getLabelBySlug(slug);

  if (!label) {
    return { status: "missing" };
  }

  // Ride the catalogue read in the SAME parallel wave as the findings/artists/alias reads —
  // all four key only off `label.id` and are mutually independent. A page past the end of the
  // pager throws `CataloguePageOutOfRangeError`; map ONLY that to null here so it no longer
  // blocks the batch, and 404 once the wave settles. Any other error still throws.
  const cataloguePromise = listLabelCatalogue(label.id, sort, page).catch(
    (error: unknown): CatalogueGroupPage<CatalogueArtistGroup> | null => {
      if (error instanceof CataloguePageOutOfRangeError) {
        return null;
      }

      throw error;
    },
  );

  const [catalogue, findings, artists, alternateNames] = await Promise.all([
    cataloguePromise,
    getFindingsByLabel(label.id),
    listArtistsByLabel(label.id),
    getConfirmedAliasNames(label.id),
  ]);

  if (catalogue === null) {
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
    // Thin-content gate: index only past LABEL_INDEX_MIN_TRACKS RENDERABLE tracks — the
    // findings PLUS the quieter rows, because both are real content on the page, and a page is
    // thin or not thin on what it renders, never on who wrote it. Below the floor the page
    // still serves 200 (deep links, link equity) but is noindex + out of the sitemap; the
    // sitemap keys off the same sum, so the two can never disagree. It counts the entity's TRUE
    // total, never the rendered page.
    indexable: findings.length + catalogue.totalTracks >= LABEL_INDEX_MIN_TRACKS,
    logoImageUrl: label.logoImageUrl,
    mbLabelId: label.mbLabelId,
    name: label.name,
    parentLabel: label.parentLabel,
    slug: label.slug,
    sort,
    status: "found",
    subLabels: label.subLabels ?? [],
  };
}

// Both params are OPTIONAL, so a plain `<Link to="/label/$slug">` anywhere in the app still
// type-checks without a `search` prop (the `HomeSearch.story?` precedent). The default page and
// sort are applied in `loaderDeps`, never here — the URL stays clean (`/label/x`, not
// `/label/x?sort=name&page=1`) for the canonical, crawlable view.
type LabelSearch = { page?: number; sort?: CatalogueSort };

const fetchLabel = createServerFn({ method: "GET" })
  .validator((data: { page: number; slug: string; sort: CatalogueSort }) => data)
  .handler(
    ({ data: { page, slug, sort } }): Promise<LabelPageData> =>
      resolveLabelPageData(slug, sort, page),
  );

function labelHead(loaderData: LabelPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const {
    alternateNames,
    artists,
    bio,
    catalogue,
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
  // The canonical is SELF-REFERENCING PER PAGE (page 2 is its own page, not a duplicate of page
  // 1) but SORT-COLLAPSING: it always drops the sort param, so `?sort=recent` and the default
  // A–Z view of the same page fold to one canonical URL rather than diluting each other. Page 1
  // stays the bare `/label/<slug>`.
  const pageUrl =
    catalogue.page > 1
      ? `${siteUrl}/label/${slug}?page=${catalogue.page}`
      : `${siteUrl}/label/${slug}`;
  // The <title>/meta stay honestly-plain third-person (the Narrator rule); the first person
  // lives only in the on-page voice frame.
  const title = `${name} · Fluncle's Findings`;
  // The factual bio is the honest, UNIQUE description when one is authored — the same objective
  // paragraph the page prints, trimmed to the meta cap. Absent (the bio backfill is in flight for
  // many labels), it falls back to the templated line verbatim, so nothing regresses: it still
  // describes the page it is actually on (with findings, the findings; without, the records this
  // label put out), never claiming findings a page does not have and never naming the unlit tier
  // (docs/album-entity.md), so "catalogue" cannot leak into a SERP snippet. This one string flows
  // to meta + og + twitter below, so all three go unique together.
  const description =
    bio !== undefined
      ? bioMetaDescription(bio)
      : findings.length > 0
        ? `Every banger Fluncle has found on ${name} and logged in the Galaxy, ${findings.length} so far, each with a coordinate.`
        : `The records released on ${name}, charted in Fluncle's Galaxy.`;
  // The label's representative image, up the same ladder every surface uses: its OWN logo first,
  // then the freshest finding's cover, then the site cover as the final floor.
  const coverFinding = findings[0];
  const imageUrl =
    logoImageUrl ??
    (coverFinding ? albumCoverAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  return {
    links: [
      { href: pageUrl, rel: "canonical" },
      // RSS discovery: this label's new-releases feed (the 30-day window, this label only).
      // The bare `/label/<slug>/fresh.xml`, never the paged catalogue URL.
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
    // The JSON-LD's track list describes exactly what the page RENDERS — the findings, then the
    // quieter rows on this page flattened out of their groups (schema that contradicts the page
    // gets discounted). `jsonLdScript` HTML-escapes the payload, so a `</script>` in a
    // vendor-sourced label or track name can't break out (stored-XSS sink, security review).
    scripts: [
      jsonLdScript(
        recordLabelJsonLd({
          alternateNames,
          artists,
          bio,
          discogsLabelId,
          // The founding facts + imprint hierarchy (RFC label-lineage-remixer U1) → the
          // Organization's `foundingDate` / `location` / `parentOrganization` / `subOrganization`.
          foundingDate,
          location: foundedLocation,
          // The label's own logo becomes the Organization's `logo` (it was only the OG image before).
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

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/label/$slug")({
  validateSearch: (search: Record<string, unknown>): LabelSearch => ({
    page: pageParam(search["page"]),
    sort: sortParam(search["sort"]),
  }),
  // Defaults land HERE, so the loader always gets a real page + sort while the URL keeps them
  // implicit. `parseCatalogueSort` folds anything to the default A–Z.
  loaderDeps: ({ search }) => ({ page: search.page ?? 1, sort: parseCatalogueSort(search.sort) }),
  loader: async ({ deps, params }): Promise<LabelPageData> => {
    const data = await fetchLabel({
      data: { page: deps.page, slug: params.slug, sort: deps.sort },
    });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LabelPageData }) => labelHead(loaderData),
  component: LabelPage,
  notFoundComponent: StoryNotFoundState,
});

/** A page param the reader typed: junk or an absent value folds to undefined (default 1). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/** A sort param the reader typed: only a known sort survives, so a junk value stays implicit. */
function sortParam(value: unknown): CatalogueSort | undefined {
  return value === "name" || value === "recent" ? value : undefined;
}

/**
 * The label's dossier dateline (reference register): "Founded 1996 · London" (date + place),
 * "Founded 1996" (date only), or the bare place. Undefined when the label carries neither, so the
 * masthead renders nothing. The founding date is shown as its YEAR (the verbatim value on the row —
 * a year or a full date — rides the JSON-LD `foundingDate`, but the visible line stays terse).
 */
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

  const { artists, bio, catalogue, findings, foundedLocation, foundingDate, name, slug, sort } =
    data;
  const dateline = labelDateline(foundingDate, foundedLocation);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          {/* The dossier bio is the masthead's prose — the reference register (the Three Areas
              Rule; the first-person signature line is retired). Rendered once authored. */}
          {bio ? <p className="log-index-bio">{bio}</p> : undefined}
          {/* One quiet reference-register line: where and when the label started (label-lineage
              sweep, U1). Rendered only when MusicBrainz carried a founding date or place. */}
          {dateline ? <p className="log-index-dateline">{dateline}</p> : undefined}
        </header>

        {/* Every band below is conditional: an empty one renders nothing at all, so this page
            is only ever about what it actually carries (components/graph-sections.tsx). */}
        <FindingsGrid findings={findings} label={`Findings on ${name}`} />

        <ArtistChips artists={artists} title={`Artists on ${name}`} />

        {/* The crawled catalogue, grouped by artist. The sort control rides above it only when
            there is more than one group to order; the pager below only when there is more than
            one page. Changing either resets to page 1 — a different order has different pages. */}
        {catalogue.groups.length > 0 ? (
          <section aria-label={`Artists released on ${name}`} className="catalogue-section">
            {catalogue.totalGroups > 1 ? (
              <CatalogueSortControl
                label="Sort artists"
                onChange={(next) => navigate({ search: { sort: next } })}
                sort={sort}
              />
            ) : undefined}

            <CatalogueArtistGroups groups={catalogue.groups} labelName={name} />

            <CataloguePager
              buildHref={(page) => `/label/${slug}?sort=${sort}&page=${page}`}
              label={`Artists on ${name}, more pages`}
              page={catalogue.page}
              pageCount={catalogue.pageCount}
            />
          </section>
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/labels">All labels</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}

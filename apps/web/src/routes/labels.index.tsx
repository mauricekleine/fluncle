import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
import { HubFooter } from "@/components/hub-footer";
import { HubOrderSwitch, HubThisMonth, HubTile } from "@/components/hub-sections";
import { HubSearchInput } from "@/components/hub-search-input";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, hubCoverSrcSet } from "@/lib/media";
import { type HubOrder, hubHref, hubOrderParam } from "@/lib/hub-order";
import { pageParam, textParam } from "@/lib/search-params";
import {
  type CatalogueHubNumberedPage,
  type LabelHubEntry,
  listLabelsHubPage,
  listLabelsThisMonth,
  labelsHaveRecentActivity,
} from "@/lib/server/labels";

const countFormatter = new Intl.NumberFormat("en-US");

type LabelsPageData =
  | {
      hub: CatalogueHubNumberedPage<LabelHubEntry>;
      order: HubOrder;
      recentReady: boolean;
      requestedOrder: HubOrder;
      page: number;
      q: string | undefined;
      status: "found";
      thisMonth: LabelHubEntry[];
    }
  | { status: "missing" };

async function resolveLabelsPage(
  page: number | undefined,
  q: string | undefined,
  order: HubOrder,
): Promise<LabelsPageData> {
  const requested = page ?? 1;
  const recentReady = await labelsHaveRecentActivity();
  const served: HubOrder = order === "recent" && !recentReady ? "most" : order;
  const withStrip = requested === 1 && q === undefined && served === "most";
  const [hub, thisMonth] = await Promise.all([
    listLabelsHubPage(requested, q, served),
    withStrip ? listLabelsThisMonth() : Promise.resolve([]),
  ]);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return {
    hub,
    order: served,
    page: requested,
    q,
    recentReady,
    requestedOrder: order,
    status: "found",
    thisMonth,
  };
}

const fetchLabelsPage = createServerFn({ method: "GET" })
  .validator((data: { order?: HubOrder; page?: number; q?: string }) => data)
  .handler(
    ({ data }): Promise<LabelsPageData> =>
      resolveLabelsPage(data.page, data.q, data.order ?? "most"),
  );

const title = "Every drum & bass record label · Fluncle";
const description =
  "Every drum & bass record label Fluncle holds, with the founding facts and lineage that link them.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass record label Fluncle holds.`,
    title: `Every drum & bass record label, page ${page} · Fluncle`,
  };
}

function labelsHead(loaderData: LabelsPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const filtered = loaderData.q !== undefined || loaderData.requestedOrder !== "most";
  const canonical =
    filtered || loaderData.page <= 1
      ? `${siteUrl}/labels`
      : `${siteUrl}/labels?page=${loaderData.page}`;

  const meta = pagedMeta(filtered ? 1 : loaderData.page);
  const ogImage = `${siteUrl}/api/og/hub?hub=labels`;
  const metaTags = [
    { title: meta.title },
    { content: meta.description, name: "description" },
    { content: meta.title, property: "og:title" },
    { content: meta.description, property: "og:description" },
    { content: ogImage, property: "og:image" },
    { content: "1200", property: "og:image:width" },
    { content: "630", property: "og:image:height" },
    { content: "image/png", property: "og:image:type" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: meta.title, name: "twitter:title" },
    { content: meta.description, name: "twitter:description" },
    { content: ogImage, name: "twitter:image" },
  ];

  if (filtered) {
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  const labels = loaderData.hub.items;
  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: labels.map((label, index) => ({
        "@type": "ListItem",
        name: label.name,
        position: index + 1,
        url: `${siteUrl}/label/${encodeURIComponent(label.slug)}`,
      })),
      numberOfItems: loaderData.hub.total,
    },
    name: "Every drum & bass record label Fluncle holds",
    url: `${siteUrl}/labels`,
  };

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: metaTags,
    scripts: [jsonLdScript(collectionPage)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (validateSearch → head); see AGENTS.md
export const Route = createFileRoute("/labels/")({
  validateSearch: (search: Record<string, unknown>): LabelsSearch => ({
    order: hubOrderParam(search["order"]),
    page: pageParam(search["page"]),
    q: textParam(search["q"]),
  }),
  loaderDeps: ({ search }) => ({ order: search.order, page: search.page, q: search.q }),
  loader: async ({ deps }): Promise<LabelsPageData> => {
    const data = await fetchLabelsPage({
      data: { order: deps.order, page: deps.page, q: deps.q },
    });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LabelsPageData }) => labelsHead(loaderData),
  component: LabelsPage,
  notFoundComponent: StoryNotFoundState,
});

type LabelsSearch = { order?: "az" | "recent"; page?: number; q?: string };

function mastheadLine(total: number): string {
  return total > 1 ? `${countFormatter.format(total)} drum & bass labels.` : "Drum & bass labels.";
}

function LabelTile({
  eager,
  label,
  priority,
}: {
  eager?: boolean;
  label: LabelHubEntry;
  priority?: boolean;
}) {
  const image = label.logoImageUrl || label.coverImageUrl || undefined;

  return (
    <HubTile kind="label" lit={label.certified} name={label.name} slug={label.slug}>
      <Link
        className={label.certified ? "hub-tile-certified" : undefined}
        params={{ slug: label.slug }}
        to="/label/$slug"
      >
        <TrackArtwork
          alt=""
          className="artist-grid-cover"
          eager={eager}
          priority={priority}
          sizes="(min-width: 40rem) 120px, 50vw"
          src={albumCoverAtSize(image, "hub")}
          srcSet={hubCoverSrcSet(image)}
        />
        <span className="artist-grid-line">{label.name}</span>
        <span className="artist-grid-count">{tracksCount(label.trackCount)}</span>
      </Link>
    </HubTile>
  );
}

function matchCount(count: number): string {
  return `${countFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function LabelsPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();

  if (data.status !== "found") {
    return null;
  }

  const { hub, order, q, thisMonth } = data;
  const filtered = q !== undefined;
  const buildHref = (page: number) => hubHref("/labels", { order, page, q });
  const showSearch = filtered || hub.total > 0;
  const setOrder = (next: HubOrder) =>
    void navigate({ search: { order: hubOrderParam(next), q }, to: "/labels" });

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Labels</h1>
          <p className="log-index-intro">{mastheadLine(filtered ? 0 : hub.total)}</p>
        </header>

        {showSearch ? (
          <HubSearchInput
            label="Search labels by name"
            onSearch={(term) =>
              void navigate({ search: { order: hubOrderParam(order), q: term }, to: "/labels" })
            }
            placeholder="Search labels"
            value={q}
          />
        ) : undefined}

        {filtered ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {matchCount(hub.total)}
          </p>
        ) : undefined}

        <HubThisMonth count={thisMonth.length} label="Labels with a record out this month">
          {thisMonth.map((label) => (
            <LabelTile key={label.slug} label={label} />
          ))}
        </HubThisMonth>

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {filtered ? "No labels match that name." : "No drum & bass labels yet."}
          </p>
        ) : (
          <>
            <h2 className="sr-only">Every label</h2>
            <HubOrderSwitch onChange={setOrder} order={order} recentReady={data.recentReady} />
            {filtered || order !== "az" ? undefined : (
              <HubLetterLane
                buildHref={buildHref}
                label="Labels A to Z"
                letters={hub.letters ?? []}
              />
            )}
            <ul aria-label="Labels" className="artist-grid hub-grid">
              {hub.items.map((label, index) => (
                <LabelTile
                  eager={index < 4}
                  key={label.slug}
                  label={label}
                  priority={index === 0}
                />
              ))}
            </ul>
            <CataloguePager
              buildHref={buildHref}
              label="Labels, more pages"
              page={hub.page}
              pageCount={hub.pageCount}
            />
          </>
        )}

        <HubFooter current="/labels" />
      </article>
    </main>
  );
}

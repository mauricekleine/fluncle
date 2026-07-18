import { CircleNotchIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type FormEvent, useEffect, useRef } from "react";
import { FreshStreamRow } from "@/components/fresh/shared";
import { isGalaxyMapFullyNamed, listPublicGalaxies } from "@/lib/server/galaxies-map";
import {
  type TracksHubEntry,
  type TracksHubFilters,
  type TracksHubPage,
  TRACKS_HUB_PAGE_SIZE,
  listTracksHub,
} from "@/lib/server/tracks-hub";
import {
  KEY_FILTER_OPTIONS,
  type TracksSearch,
  parseTracksSearch,
  tracksHead,
  tracksSearchHasFilters,
} from "@/lib/tracks-search";

// `/tracks` — THE WHOLE LIST (D4). The top-level index of every track Fluncle holds: the certified
// findings and the wider catalogue, in one newest-release-first list you can filter and page. A
// CATALOGUE page (VOICE.md's Three Areas) — reference register, no nameplate, no first-person — that
// renders the two-register grammar through the shared `FreshStreamRow` (a lit finding with its Log ID
// coordinate; an unlit catalogue row, dimmed and out to Spotify — DESIGN.md's Unlit Rule).
//
// The filter axes MIRROR the search vocabulary (`SearchFiltersSchema`): `yearMin`/`yearMax`,
// `bpmMin`/`bpmMax`, `key`, `label`, compiled by the same `compileFilters`. `galaxy` is the one
// extension (a galaxy slug; it narrows to certified findings, honestly). The bare hub is indexable +
// in the sitemap; ANY filter param present flips it to `noindex`, and the canonical is always the
// bare `/tracks`. No new oRPC op: the page reads through `createServerFn` like the other hubs.

/** A galaxy the filter control can offer — a named, public galaxy (its display name + slug). */
type GalaxyOption = { name: string; slug: string };

/** The serverFn payload: a page of the hub, plus the galaxy options for the filter control. */
type TracksHubData = TracksHubPage & { galaxyOptions: GalaxyOption[] };

/** What the loader returns: the first page plus the resolved search, so the head reads it directly. */
type TracksLoaderData = TracksHubData & { search: TracksSearch };

// The infinite-scroll page fetch — the SAME serverFn the loader seeds from (the homepage-feed
// precedent), no oRPC op. It owns the galaxy LAUNCH GATE: a `galaxy` filter is honoured only once the
// whole sonic map is named (the same gate `/galaxies` ships behind), so a single mid-naming galaxy
// can never leak via `?galaxy=`. Galaxy options ride along so pages 2+ keep the control populated
// without a second round trip.
const fetchTracksHubPage = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; filters?: TracksHubFilters; limit?: number }) => data)
  .handler(async ({ data }): Promise<TracksHubData> => {
    const filters = data.filters ?? {};
    const [galaxiesNamed, galaxyOptions] = await Promise.all([
      filters.galaxy ? isGalaxyMapFullyNamed() : Promise.resolve(false),
      listPublicGalaxies(),
    ]);

    const page = await listTracksHub({
      cursor: data.cursor,
      filters: { ...filters, galaxy: galaxiesNamed ? filters.galaxy : undefined },
      limit: data.limit ?? TRACKS_HUB_PAGE_SIZE,
    });

    return { ...page, galaxyOptions: galaxyOptions.map((g) => ({ name: g.name, slug: g.slug })) };
  });

// TanStack canonical option order (validateSearch → loaderDeps → loader → head → component); each
// step feeds the next's type inference, so the order isn't alphabetical and sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/tracks")({
  validateSearch: (search: Record<string, unknown>): TracksSearch => parseTracksSearch(search),
  loaderDeps: ({ search }: { search: TracksSearch }) => ({ search }),
  loader: async ({ deps }: { deps: { search: TracksSearch } }): Promise<TracksLoaderData> => {
    const page = await fetchTracksHubPage({
      data: { filters: deps.search, limit: TRACKS_HUB_PAGE_SIZE },
    });

    return { ...page, search: deps.search };
  },
  head: ({ loaderData }: { loaderData?: TracksLoaderData }) =>
    tracksHead(loaderData?.search ?? {}, loaderData),
  component: TracksPage,
});

// ── The filter bar ──────────────────────────────────────────────────────────────────────

/**
 * The filter bar: a real form that navigates on submit (never per-keystroke), so the loader
 * re-seeds from a fresh URL and the page stays crawlable + shareable. Uncontrolled inputs seeded
 * from the current search; "Apply filters" submits, "Clear filters" returns to the bare hub.
 */
function TracksFilters({
  galaxyOptions,
  search,
}: {
  galaxyOptions: GalaxyOption[];
  search: TracksSearch;
}) {
  const navigate = useNavigate();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = Object.fromEntries(form.entries());
    void navigate({ search: parseTracksSearch(raw), to: "/tracks" });
  };

  return (
    <form aria-labelledby="tracks-filter-heading" className="tracks-filters" onSubmit={onSubmit}>
      <h2 className="sr-only" id="tracks-filter-heading">
        Filter tracks
      </h2>

      <div className="tracks-filter-field">
        <label htmlFor="tracks-filter-year-min">From year</label>
        <input
          defaultValue={search.yearMin ?? ""}
          id="tracks-filter-year-min"
          inputMode="numeric"
          max={2100}
          min={1990}
          name="yearMin"
          placeholder="1995"
          type="number"
        />
      </div>

      <div className="tracks-filter-field">
        <label htmlFor="tracks-filter-year-max">To year</label>
        <input
          defaultValue={search.yearMax ?? ""}
          id="tracks-filter-year-max"
          inputMode="numeric"
          max={2100}
          min={1990}
          name="yearMax"
          placeholder="2026"
          type="number"
        />
      </div>

      <div className="tracks-filter-field">
        <label htmlFor="tracks-filter-bpm-min">Min BPM</label>
        <input
          defaultValue={search.bpmMin ?? ""}
          id="tracks-filter-bpm-min"
          inputMode="numeric"
          max={300}
          min={1}
          name="bpmMin"
          placeholder="160"
          type="number"
        />
      </div>

      <div className="tracks-filter-field">
        <label htmlFor="tracks-filter-bpm-max">Max BPM</label>
        <input
          defaultValue={search.bpmMax ?? ""}
          id="tracks-filter-bpm-max"
          inputMode="numeric"
          max={300}
          min={1}
          name="bpmMax"
          placeholder="180"
          type="number"
        />
      </div>

      <div className="tracks-filter-field">
        <label htmlFor="tracks-filter-key">Key</label>
        <select defaultValue={search.key ?? ""} id="tracks-filter-key" name="key">
          <option value="">Any key</option>
          {KEY_FILTER_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      <div className="tracks-filter-field tracks-filter-field-label">
        <label htmlFor="tracks-filter-label">Label</label>
        <input
          defaultValue={search.label ?? ""}
          id="tracks-filter-label"
          name="label"
          placeholder="e.g. Hospital Records"
          type="text"
        />
      </div>

      {/* Galaxy is offered ONLY once the sonic map is named (the launch gate): an empty list keeps
          the control off the page entirely (the /galaxies-dark precedent), never a dead select. */}
      {galaxyOptions.length > 0 ? (
        <div className="tracks-filter-field">
          <label htmlFor="tracks-filter-galaxy">Galaxy</label>
          <select defaultValue={search.galaxy ?? ""} id="tracks-filter-galaxy" name="galaxy">
            <option value="">Any galaxy</option>
            {galaxyOptions.map((galaxy) => (
              <option key={galaxy.slug} value={galaxy.slug}>
                {galaxy.name}
              </option>
            ))}
          </select>
        </div>
      ) : undefined}

      <div className="tracks-filter-actions">
        <button className="tracks-filter-apply" type="submit">
          Apply filters
        </button>
        {tracksSearchHasFilters(search) ? (
          <Link className="tracks-filter-clear" to="/tracks">
            Clear filters
          </Link>
        ) : undefined}
      </div>
    </form>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────────────────

function entryKey(entry: TracksHubEntry): string {
  return entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId;
}

function TracksPage() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const filtered = tracksSearchHasFilters(search);

  // The list reads through react-query so pages stay cached; seeded with the SSR loader's first
  // page (instant first paint, no fetch on mount). Focus-refetch is OFF (a public page — the archive
  // barely changes minute to minute). The queryKey folds the filters so a filter change is a fresh
  // list, not appended pages. Pages 2+ carry the same filters through the same serverFn.
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: { pageParams: [undefined], pages: [initial as TracksHubData] },
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchTracksHubPage({
        data: { cursor: pageParam, filters: search, limit: TRACKS_HUB_PAGE_SIZE },
      }),
    queryKey: ["tracks-hub", search],
    refetchOnWindowFocus: false,
  });

  const entries = data.pages.flatMap((page) => page.entries);
  const galaxyOptions = data.pages.at(-1)?.galaxyOptions ?? initial.galaxyOptions;

  const sentinelRef = useRef<HTMLLIElement | null>(null);

  // Auto-fetch when the sentinel nears the viewport; the button below stays a manual fallback.
  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const observer = new IntersectionObserver(
      (rows) => {
        if (rows.some((row) => row.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "320px" },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Tracks</h1>
          {/* Reference register (VOICE.md's Three Areas): one factual line naming the superset. The
              newest-first order is SHOWN by the row date column (never stated — the /fresh masthead
              rule), and the lit/unlit split is shown visually, never verbally (DESIGN.md's Unlit
              Rule: an uncertified row is never introduced as a tier). So the intro names the whole. */}
          <p className="log-index-intro">Every drum &amp; bass track in the archive.</p>
        </header>

        <TracksFilters galaxyOptions={galaxyOptions} search={search} />

        {entries.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {filtered
              ? "No tracks match those filters. Loosen them and try again."
              : "No tracks logged yet. Quiet sector tonight."}
          </p>
        ) : (
          <ol aria-label="Tracks" className="fresh-rows tracks-hub-list">
            {entries.map((entry) => (
              <FreshStreamRow entry={entry} key={entryKey(entry)} />
            ))}
            {hasNextPage ? (
              <li className="tracks-hub-more" ref={sentinelRef}>
                <button
                  className="tracks-hub-more-button"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                  type="button"
                >
                  {isFetchingNextPage ? (
                    // The spin is decorative; under reduced-motion it hides and the label below
                    // carries the loading state (DESIGN.md §5 grounds motion on reduced-motion).
                    <CircleNotchIcon
                      aria-hidden="true"
                      className="animate-spin motion-reduce:hidden"
                      weight="bold"
                    />
                  ) : undefined}
                  {isFetchingNextPage ? "Loading more tracks" : "Load more"}
                </button>
              </li>
            ) : undefined}
          </ol>
        )}

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/fresh">New releases</Link>
        </footer>
      </article>
    </main>
  );
}

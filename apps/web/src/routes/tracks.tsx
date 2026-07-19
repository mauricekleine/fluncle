import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type FormEvent } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@fluncle/ui/components/select";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubYearLane } from "@/components/catalogue-hub-section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TracksHubRow } from "@/components/tracks-hub-row";
import { isGalaxyMapFullyNamed, listPublicGalaxies } from "@/lib/server/galaxies-map";
import {
  type CatalogueHubNumberedPage,
  CatalogueHubPageOutOfRangeError,
} from "@/lib/server/labels";
import {
  type TracksHubEntry,
  type TracksHubFilters,
  type TracksHubYearLaneEntry,
  countAllTracks,
  listTracksHubPage,
  listTracksHubYearLane,
} from "@/lib/server/tracks-hub";
import {
  KEY_FILTER_OPTIONS,
  type TracksSearch,
  parseTracksSearch,
  tracksHead,
  tracksMastheadLine,
  tracksSearchHasFilters,
} from "@/lib/tracks-search";

// `/tracks` — THE WHOLE LIST (D4). The top-level index of every track Fluncle holds: the certified
// findings and the wider catalogue, in one newest-release-first list you can filter and page. A
// CATALOGUE page (VOICE.md's Three Areas) — reference register, no nameplate, no first-person — that
// renders the two-register grammar through the `/tracks` hub row (a lit finding cover-led with its
// Log ID coordinate; an unlit catalogue row, coverless and dust-inked — DESIGN.md's Unlit Rule).
//
// The filter axes MIRROR the search vocabulary (`SearchFiltersSchema`): `yearMin`/`yearMax`,
// `bpmMin`/`bpmMax`, `key`, `label`, compiled by the same `compileFilters`. `galaxy` is the one
// extension (a galaxy slug; it narrows to certified findings, honestly).
//
// PAGINATION IS NUMBERED (the `/labels` hub precedent, #731): every page — page 1 the bare `/tracks`,
// `?page=N` beyond — SSRs one `limit/offset` slice behind a real-anchor pager, and a quiet YEAR fast
// lane jumps to the page a release year starts on (the A–Z lane mechanic mapped onto time). Nothing
// loads on scroll, so a crawler that runs no JS walks the whole list. A public route: loader +
// `useLoaderData`, no react-query (AGENTS.md). The bare hub is indexable + in the sitemap; ANY filter
// param present flips it to `noindex`, and only the bare `/tracks` is a sitemap URL.

/** A galaxy the filter control can offer — a named, public galaxy (its display name + slug). */
type GalaxyOption = { name: string; slug: string };

/** The serverFn payload: a page of the hub (or "missing" for a page past the end), the year lane, the
    whole held count, and the galaxy options for the filter control. */
type TracksFetchResult =
  | {
      galaxyOptions: GalaxyOption[];
      heldTotal: number;
      hub: CatalogueHubNumberedPage<TracksHubEntry>;
      status: "found";
      years: TracksHubYearLaneEntry[];
    }
  | { status: "missing" };

/** What the loader returns: the found page plus the resolved filters + page, so head + component read
    them directly. */
type TracksLoaderData = {
  filters: TracksSearch;
  galaxyOptions: GalaxyOption[];
  hasFilters: boolean;
  heldTotal: number;
  hub: CatalogueHubNumberedPage<TracksHubEntry>;
  page: number;
  years: TracksHubYearLaneEntry[];
};

/** A page param the reader typed: junk / absent / < 1 folds to undefined (the bare page-1 view). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

// The page fetch — the SAME serverFn the loader calls (no oRPC op; the hub reads through
// `createServerFn` like the other hubs). It owns the galaxy LAUNCH GATE: a `galaxy` filter is honoured
// only once the whole sonic map is named (the gate `/galaxies` ships behind), so a single mid-naming
// galaxy can never leak via `?galaxy=`. It reads the page + the year lane + the held count together,
// and returns "missing" for a page past the end so the loader can 404 rather than clamp.
const fetchTracksHubPage = createServerFn({ method: "GET" })
  .validator((data: { filters: TracksHubFilters; page: number }) => data)
  .handler(async ({ data }): Promise<TracksFetchResult> => {
    const [galaxiesNamed, galaxyOptions] = await Promise.all([
      data.filters.galaxy ? isGalaxyMapFullyNamed() : Promise.resolve(false),
      listPublicGalaxies(),
    ]);
    const filters: TracksHubFilters = {
      ...data.filters,
      galaxy: galaxiesNamed ? data.filters.galaxy : undefined,
    };
    const hasFilters = tracksSearchHasFilters(filters);
    // The year lane is the A–Z lane over time; a year filter already narrows to one region of it, so
    // it is hidden then (the lane read is skipped, not just unrendered).
    const yearFiltered = filters.yearMin !== undefined || filters.yearMax !== undefined;

    try {
      const [hub, years, heldTotal] = await Promise.all([
        listTracksHubPage(filters, data.page),
        yearFiltered ? Promise.resolve([]) : listTracksHubYearLane(filters),
        // On an unfiltered view the page read's own total already IS the held count; only a filtered
        // view needs the extra bare count so the masthead still names the archive's true size.
        hasFilters ? countAllTracks() : Promise.resolve(-1),
      ]);

      return {
        galaxyOptions: galaxyOptions.map((galaxy) => ({ name: galaxy.name, slug: galaxy.slug })),
        heldTotal: heldTotal < 0 ? hub.total : heldTotal,
        hub,
        status: "found",
        years,
      };
    } catch (error) {
      // A page past the end 404s (never clamps to page 1 — that would be a second URL for page 1's
      // rows). The error is hub-local; anything else rethrows.
      if (error instanceof CatalogueHubPageOutOfRangeError) {
        return { status: "missing" };
      }

      throw error;
    }
  });

// TanStack canonical option order (validateSearch → loaderDeps → loader → head → component); each
// step feeds the next's type inference, so the order isn't alphabetical and sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/tracks")({
  validateSearch: (search: Record<string, unknown>): TracksSearch & { page?: number } => ({
    ...parseTracksSearch(search),
    page: pageParam(search["page"]),
  }),
  loaderDeps: ({ search }: { search: TracksSearch & { page?: number } }) => ({ search }),
  loader: async ({
    deps,
  }: {
    deps: { search: TracksSearch & { page?: number } };
  }): Promise<TracksLoaderData> => {
    const { page: pageValue, ...filters } = deps.search;
    const page = pageValue ?? 1;
    const data = await fetchTracksHubPage({ data: { filters, page } });

    if (data.status === "missing") {
      throw notFound();
    }

    return {
      filters,
      galaxyOptions: data.galaxyOptions,
      hasFilters: tracksSearchHasFilters(filters),
      heldTotal: data.heldTotal,
      hub: data.hub,
      page,
      years: data.years,
    };
  },
  head: ({ loaderData }: { loaderData?: TracksLoaderData }) =>
    loaderData
      ? tracksHead(loaderData.filters, {
          entries: loaderData.hub.items,
          page: loaderData.hub.page,
          total: loaderData.hub.total,
        })
      : {},
  component: TracksPage,
  notFoundComponent: StoryNotFoundState,
});

// ── The filter bar (slice A leaves its behaviour intact; slice B redesigns it) ──────────────

/** One number filter field (a year or a BPM bound) — a Shadcn Label + Input, seeded from the URL. */
function NumberFilter({
  defaultValue,
  id,
  label,
  max,
  min,
  name,
  placeholder,
}: {
  defaultValue: number | undefined;
  id: string;
  label: string;
  max: number;
  min: number;
  name: string;
  placeholder: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground" htmlFor={id}>
        {label}
      </Label>
      <Input
        className="w-24"
        defaultValue={defaultValue ?? ""}
        id={id}
        inputMode="numeric"
        max={max}
        min={min}
        name={name}
        placeholder={placeholder}
        type="number"
      />
    </div>
  );
}

/**
 * The filter bar: a real form that navigates on submit (never per-keystroke), so the loader
 * re-seeds from a fresh URL and the page stays crawlable + shareable. Built on the Shadcn design
 * system (Input / Label / Select / Button) — the base-ui Select carries its `name` into the form
 * submit via a hidden input, so the navigate-on-submit read of `FormData` still works. Uncontrolled,
 * seeded from the current search; "Apply filters" submits (which resets to page 1 — a fresh filter
 * set is a fresh list), "Clear filters" returns to the bare hub.
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
    // `parseTracksSearch` carries no `page`, so a filter change drops the page param → page 1.
    void navigate({ search: parseTracksSearch(raw), to: "/tracks" });
  };

  // `items` maps a Select's value → its trigger label so base-ui renders the LABEL (not the raw
  // value) in the closed trigger — load-bearing for the "" default (renders "Any …", never a blank)
  // and for galaxy (value is a slug, label is the name).
  const keyItems: Record<string, string> = {
    "": "Any key",
    ...Object.fromEntries(KEY_FILTER_OPTIONS.map((option) => [option, option])),
  };
  const galaxyItems: Record<string, string> = {
    "": "Any galaxy",
    ...Object.fromEntries(galaxyOptions.map((galaxy) => [galaxy.slug, galaxy.name])),
  };

  return (
    <form
      aria-labelledby="tracks-filter-heading"
      className="flex flex-wrap items-end gap-x-4 gap-y-3 border-y border-border/55 py-4"
      onSubmit={onSubmit}
    >
      <h2 className="sr-only" id="tracks-filter-heading">
        Filter tracks
      </h2>

      <NumberFilter
        defaultValue={search.yearMin}
        id="tracks-filter-year-min"
        label="From year"
        max={2100}
        min={1990}
        name="yearMin"
        placeholder="1995"
      />
      <NumberFilter
        defaultValue={search.yearMax}
        id="tracks-filter-year-max"
        label="To year"
        max={2100}
        min={1990}
        name="yearMax"
        placeholder="2026"
      />
      <NumberFilter
        defaultValue={search.bpmMin}
        id="tracks-filter-bpm-min"
        label="Min BPM"
        max={300}
        min={1}
        name="bpmMin"
        placeholder="160"
      />
      <NumberFilter
        defaultValue={search.bpmMax}
        id="tracks-filter-bpm-max"
        label="Max BPM"
        max={300}
        min={1}
        name="bpmMax"
        placeholder="180"
      />

      <div className="grid gap-1.5">
        <Label className="text-xs font-medium text-muted-foreground" htmlFor="tracks-filter-key">
          Key
        </Label>
        <Select defaultValue={search.key ?? ""} items={keyItems} name="key">
          <SelectTrigger className="w-40" id="tracks-filter-key">
            <SelectValue placeholder="Any key" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Any key</SelectItem>
            {KEY_FILTER_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grow gap-1.5">
        <Label className="text-xs font-medium text-muted-foreground" htmlFor="tracks-filter-label">
          Label
        </Label>
        <Input
          className="min-w-48"
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
        <div className="grid gap-1.5">
          <Label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="tracks-filter-galaxy"
          >
            Galaxy
          </Label>
          <Select defaultValue={search.galaxy ?? ""} items={galaxyItems} name="galaxy">
            <SelectTrigger className="w-40" id="tracks-filter-galaxy">
              <SelectValue placeholder="Any galaxy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Any galaxy</SelectItem>
              {galaxyOptions.map((galaxy) => (
                <SelectItem key={galaxy.slug} value={galaxy.slug}>
                  {galaxy.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : undefined}

      <div className="ml-auto flex items-center gap-2">
        <Button type="submit" variant="outline">
          Apply filters
        </Button>
        {tracksSearchHasFilters(search) ? (
          <Button nativeButton={false} render={<Link to="/tracks" />} size="sm" variant="ghost">
            Clear filters
          </Button>
        ) : undefined}
      </div>
    </form>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────────────────

const numberFormatter = new Intl.NumberFormat("en-US");

/** "1 match" / "312 matches" — the count of tracks a filter set holds, by the form when it is active. */
function matchCount(count: number): string {
  return `${numberFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

/** Build a real `/tracks?…` href for a page, composing the active filters — the pager + year-lane
    anchors a crawler follows. Page 1 drops the `page` param; a bare, unfiltered page-1 is `/tracks`. */
function buildTracksHref(filters: TracksSearch, page: number): string {
  const params = new URLSearchParams();

  if (filters.yearMin !== undefined) {
    params.set("yearMin", String(filters.yearMin));
  }
  if (filters.yearMax !== undefined) {
    params.set("yearMax", String(filters.yearMax));
  }
  if (filters.bpmMin !== undefined) {
    params.set("bpmMin", String(filters.bpmMin));
  }
  if (filters.bpmMax !== undefined) {
    params.set("bpmMax", String(filters.bpmMax));
  }
  if (filters.key !== undefined) {
    params.set("key", filters.key);
  }
  if (filters.label !== undefined) {
    params.set("label", filters.label);
  }
  if (filters.galaxy !== undefined) {
    params.set("galaxy", filters.galaxy);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query ? `/tracks?${query}` : "/tracks";
}

function TracksPage() {
  const { filters, galaxyOptions, hasFilters, heldTotal, hub, years } = Route.useLoaderData();
  const buildHref = (page: number) => buildTracksHref(filters, page);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Tracks</h1>
          {/* Reference register (VOICE.md's Three Areas): one factual line naming the superset, with
              the held count riding it. The newest-first order is SHOWN by the row date column (never
              stated — the /fresh masthead rule), and the lit/unlit split is shown visually, never
              verbally (the Unlit Rule). "holds", not "in the archive" — the archive is the CERTIFIED
              collection, and this list is the wider superset. ONE composed string (see
              tracksMastheadLine): a conditional JSX clause SSRs as comment-split text nodes, which
              naive text extraction misreads as a missing count. */}
          <p className="log-index-intro">{tracksMastheadLine(heldTotal)}</p>
        </header>

        {/* Keyed by the search state: the inputs are uncontrolled (`defaultValue`), so without a
            remount "Clear filters" leaves stale values on screen while the list resets under them. */}
        <TracksFilters
          galaxyOptions={galaxyOptions}
          key={JSON.stringify(filters)}
          search={filters}
        />

        {hasFilters ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {matchCount(hub.total)}
          </p>
        ) : undefined}

        {/* The year fast lane — composes with any active NON-year filter (its anchors carry them),
            and self-hides when the loader fed no years: when a year filter is active (a single year
            needs no time lane) or the set spans no dated release. */}
        <HubYearLane buildHref={buildHref} label="Tracks by year" years={years} />

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {hasFilters
              ? "No tracks match those filters. Loosen them and try again."
              : "Nothing here yet. Quiet sector tonight."}
          </p>
        ) : (
          <ol aria-label="Tracks" className="tracks-hub-rows">
            {hub.items.map((entry) => (
              <TracksHubRow entry={entry} key={entryKey(entry)} />
            ))}
          </ol>
        )}

        <CataloguePager
          buildHref={buildHref}
          label="More tracks, more pages"
          page={hub.page}
          pageCount={hub.pageCount}
        />

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/fresh">Fresh</Link>
        </footer>
      </article>
    </main>
  );
}

function entryKey(entry: TracksHubEntry): string {
  return entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId;
}

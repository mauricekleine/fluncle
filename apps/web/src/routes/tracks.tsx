import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import {
  CalendarBlankIcon,
  CaretDownIcon,
  MusicNotesIcon,
  PlanetIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { Button } from "@fluncle/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  comboboxTriggerClass,
} from "@fluncle/ui/components/combobox";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
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
  listKnownLabelNames,
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
  buildTracksHref,
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
    whole held count, and the galaxy + label options for the filter controls. */
type TracksFetchResult =
  | {
      galaxyOptions: GalaxyOption[];
      heldTotal: number;
      hub: CatalogueHubNumberedPage<TracksHubEntry>;
      labelOptions: string[];
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
  labelOptions: string[];
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
//
// ONE WAVE, NOT TWO. Every round trip here is the Worker reaching a database a continent away, so a
// sequential wave costs a full latency unit however cheap its SQL. The filter-control options
// (galaxies, label names) do not depend on the page read and the page read does not depend on them,
// so they are all fired together. The one genuine dependency is the launch gate: when — and ONLY
// when — a `?galaxy=` is present, the gate must settle before the filter set is known, so that path
// alone keeps its leading round trip. The gate is never weakened to save it.
const fetchTracksHubPage = createServerFn({ method: "GET" })
  .validator((data: { filters: TracksHubFilters; page: number }) => data)
  .handler(async ({ data }): Promise<TracksFetchResult> => {
    // Fired first and awaited last: the option lists ride alongside the page read rather than ahead
    // of it.
    const optionsPromise = Promise.all([listPublicGalaxies(), listKnownLabelNames()]);
    // In flight before the gate's `await`, so a rejection there would leave this one unobserved for a
    // tick. Attaching a handler now keeps it accounted for; the real result is still read below.
    void optionsPromise.catch(() => undefined);
    // The gate is consulted only when a galaxy filter is actually asked for; with none asked for the
    // filter set is already final and nothing has to be awaited to know it.
    const filters: TracksHubFilters = data.filters.galaxy
      ? {
          ...data.filters,
          galaxy: (await isGalaxyMapFullyNamed()) ? data.filters.galaxy : undefined,
        }
      : data.filters;
    const hasFilters = tracksSearchHasFilters(filters);
    // The year lane is the A–Z lane over time; a year filter already narrows to one region of it, so
    // it is hidden then (the lane read is skipped, not just unrendered).
    const yearFiltered = filters.yearMin !== undefined || filters.yearMax !== undefined;

    try {
      const [[galaxies, labelOptions], hub, years, heldTotal] = await Promise.all([
        optionsPromise,
        listTracksHubPage(filters, data.page),
        yearFiltered ? Promise.resolve([]) : listTracksHubYearLane(filters),
        // On an unfiltered view the page read's own total already IS the held count; only a filtered
        // view needs the extra bare count so the masthead still names the archive's true size.
        hasFilters ? countAllTracks() : Promise.resolve(-1),
      ]);

      return {
        galaxyOptions: galaxies.map((galaxy) => ({ name: galaxy.name, slug: galaxy.slug })),
        heldTotal: heldTotal < 0 ? hub.total : heldTotal,
        hub,
        labelOptions,
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
      labelOptions: data.labelOptions,
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

// ── The filter bar — the pill grammar (slice B) ─────────────────────────────────────────────
// One quiet row of compact, iconed pill controls, each AUTO-APPLYING: it commits its axis to the
// URL the instant it changes (a fresh filter set is a fresh list, so the page resets to 1), the
// loader re-seeds from that URL, and the whole bar remounts (`key` on the search state) so every
// control reads its value from one source of truth — the URL — and never drifts. No Apply button;
// a quiet "Clear filters" ghost appears only while a filter is live. The BPM control is gone (the
// axis stays in the search vocabulary — a `?bpmMin=` still narrows the list — but the UI for it
// retired). The pills are chrome on a catalogue page: quiet, dark, bordered, no gold but the focus
// ring (DESIGN.md's Unlit register + One Sun Rule), Phosphor icons only (Iconography).

/** A year the popover typed: junk / non-positive / out of a sane range folds to undefined. */
function yearParam(value: string): number | undefined {
  const n = Number(value.trim());

  return Number.isInteger(n) && n >= 1900 && n <= 2200 ? n : undefined;
}

/** The label a year range reads as in its closed pill — quiet, never a mechanism ("yearMin=…"). */
function yearRangeLabel(from: number | undefined, to: number | undefined): string {
  if (from !== undefined && to !== undefined) {
    return `${from} – ${to}`;
  }
  if (from !== undefined) {
    return `From ${from}`;
  }
  if (to !== undefined) {
    return `To ${to}`;
  }

  return "Any year";
}

/** The year range — ONE pill opening a small two-field popover (from / to). It commits when the
    popover closes (click-away, Escape, Tab-out) or on Enter, and only when the range actually
    changed, so a glance that opens and closes navigates nowhere. */
function YearRangePill({
  from,
  onCommit,
  to,
}: {
  from: number | undefined;
  onCommit: (from: number | undefined, to: number | undefined) => void;
  to: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [fromValue, setFromValue] = useState(from === undefined ? "" : String(from));
  const [toValue, setToValue] = useState(to === undefined ? "" : String(to));

  const apply = () => {
    const nextFrom = yearParam(fromValue);
    const nextTo = yearParam(toValue);
    // No-op guard: re-navigating to the same URL would re-run the loader for nothing.
    if (nextFrom !== from || nextTo !== to) {
      onCommit(nextFrom, nextTo);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
      setOpen(false);
    }
  };

  return (
    <Popover
      onOpenChange={(next, eventDetails) => {
        setOpen(next);
        if (!next) {
          // Escape CANCELS (the universal convention): restore the fields from the URL's committed
          // values and apply nothing. Any other close (click-away, Tab-out, Enter) commits the range.
          if (eventDetails.reason === "escape-key") {
            setFromValue(from === undefined ? "" : String(from));
            setToValue(to === undefined ? "" : String(to));
          } else {
            apply();
          }
        }
      }}
      open={open}
    >
      <PopoverTrigger
        aria-label={`Release year: ${yearRangeLabel(from, to)}`}
        className={`${comboboxTriggerClass} tracks-filter-pill`}
      >
        <CalendarBlankIcon className="size-4 shrink-0 text-muted-foreground" />
        <span
          className={
            from === undefined && to === undefined
              ? "tracks-filter-pill-value text-muted-foreground"
              : "tracks-filter-pill-value"
          }
        >
          {yearRangeLabel(from, to)}
        </span>
        <CaretPill />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="tracks-filter-year-from"
            >
              From
            </Label>
            <Input
              id="tracks-filter-year-from"
              inputMode="numeric"
              onChange={(event) => setFromValue(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="1995"
              value={fromValue}
            />
          </div>
          <div className="grid gap-1.5">
            <Label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="tracks-filter-year-to"
            >
              To
            </Label>
            <Input
              id="tracks-filter-year-to"
              inputMode="numeric"
              onChange={(event) => setToValue(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="2026"
              value={toValue}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The shared chevron every pill wears on its right edge (the base-ui Select's own caret, matched). */
function CaretPill() {
  return <CaretDownIcon className="size-4 shrink-0 text-muted-foreground" />;
}

/** A single-select pill (Key, Galaxy): a base-ui Select dressed as a pill, committing on change.
    `items` maps value → trigger label so the closed pill reads the LABEL, and "" renders the quiet
    "Any …" default rather than a blank. */
function SelectPill({
  ariaLabel,
  emptyLabel,
  icon,
  onCommit,
  options,
  value,
}: {
  ariaLabel: string;
  emptyLabel: string;
  icon: ReactNode;
  onCommit: (value: string | undefined) => void;
  options: { label: string; value: string }[];
  value: string | undefined;
}) {
  const items: Record<string, string> = {
    "": emptyLabel,
    ...Object.fromEntries(options.map((option) => [option.value, option.label])),
  };

  return (
    <Select
      items={items}
      onValueChange={(next) => onCommit(next ? next : undefined)}
      value={value ?? ""}
    >
      <SelectTrigger aria-label={ariaLabel} className="tracks-filter-pill">
        {icon}
        <SelectValue placeholder={emptyLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">{emptyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A label option in the combobox: a known name, or the free-typed string offered as a creatable. */
type LabelOption = { isNew?: boolean; label: string; value: string };

/** The label combobox pill — typeahead over the KNOWN labels, but a free-typed string that matches
    none is still offered (the filter compiles against the raw `tracks.label` string, so an unknown
    imprint is a valid filter). Selecting any row commits; "Any label" clears. */
function LabelComboboxPill({
  onCommit,
  options,
  value,
}: {
  onCommit: (value: string | undefined) => void;
  options: string[];
  value: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const items = useMemo<LabelOption[]>(() => {
    const trimmed = inputValue.trim();
    const lower = trimmed.toLocaleLowerCase();
    const matches = options.filter((name) => name.toLocaleLowerCase().includes(lower));
    const exact = options.some((name) => name.toLocaleLowerCase() === lower);
    const view: LabelOption[] = [];
    // Offer "Any label" as the clear affordance only when there is a live label to clear and the
    // reader is not mid-search (a search is intent to pick or create, not to clear).
    if (value !== undefined && trimmed === "") {
      view.push({ label: "Any label", value: "" });
    }
    view.push(...matches.map((name) => ({ label: name, value: name })));
    if (trimmed !== "" && !exact) {
      view.push({ isNew: true, label: trimmed, value: trimmed });
    }

    return view;
  }, [inputValue, options, value]);

  const selected: LabelOption | null = value === undefined ? null : { label: value, value };

  return (
    <Combobox
      filter={null}
      inputValue={inputValue}
      isItemEqualToValue={(a, b) => a?.value === b?.value}
      items={items}
      itemToStringLabel={(item: LabelOption | null) => item?.label ?? ""}
      onInputValueChange={(next) => setInputValue(next)}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setInputValue("");
        }
      }}
      onValueChange={(item) => onCommit(item && item.value !== "" ? item.value : undefined)}
      open={open}
      value={selected}
    >
      <ComboboxTrigger aria-label={`Label: ${value ?? "Any label"}`} className="tracks-filter-pill">
        <TagIcon className="size-4 shrink-0 text-muted-foreground" />
        <span
          className={
            value === undefined
              ? "tracks-filter-pill-value text-muted-foreground"
              : "tracks-filter-pill-value"
          }
        >
          {value ?? "Any label"}
        </span>
      </ComboboxTrigger>
      <ComboboxContent align="start">
        <ComboboxInput aria-label="Search labels" placeholder="Search labels" />
        <ComboboxEmpty>No labels match that.</ComboboxEmpty>
        <ComboboxList>
          {items.map((item) => (
            <ComboboxItem key={item.value === "" ? "__any__" : item.value} value={item}>
              {item.isNew ? `Filter by “${item.label}”` : item.label}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * The filter bar: one quiet row of pill controls, each auto-applying to the URL on change. The bar
 * is keyed on the search state upstream (`TracksPage`), so a commit remounts it and every control
 * re-seeds from the URL — the single source of truth. No submit; "Clear filters" returns to the
 * bare hub.
 */
function TracksFilters({
  galaxyOptions,
  labelOptions,
  search,
}: {
  galaxyOptions: GalaxyOption[];
  labelOptions: string[];
  search: TracksSearch;
}) {
  const navigate = useNavigate();

  // Merge a patch over the current filters and navigate. Dropping `page` (it is not in `search`)
  // resets to page 1; `validateSearch` re-parses, folding "" / non-positive values to undefined.
  const commit = (patch: Partial<TracksSearch>) => {
    void navigate({ search: { ...search, ...patch }, to: "/tracks" });
  };

  return (
    <section aria-labelledby="tracks-filter-heading" className="tracks-filter-bar">
      <h2 className="sr-only" id="tracks-filter-heading">
        Filter tracks
      </h2>

      <YearRangePill
        from={search.yearMin}
        onCommit={(yearMin, yearMax) => commit({ yearMax, yearMin })}
        to={search.yearMax}
      />

      <SelectPill
        ariaLabel={`Key: ${search.key ?? "Any key"}`}
        emptyLabel="Any key"
        icon={<MusicNotesIcon className="size-4 shrink-0 text-muted-foreground" />}
        onCommit={(key) => commit({ key })}
        options={KEY_FILTER_OPTIONS.map((option) => ({ label: option, value: option }))}
        value={search.key}
      />

      <LabelComboboxPill
        onCommit={(label) => commit({ label })}
        options={labelOptions}
        value={search.label}
      />

      {/* Galaxy is offered ONLY once the sonic map is named (the launch gate): an empty list keeps
          the control off the page entirely (the /galaxies-dark precedent), never a dead pill. */}
      {galaxyOptions.length > 0 ? (
        <SelectPill
          // The aria-label speaks the galaxy's NAME (what the pill shows), never the slug the URL carries.
          ariaLabel={`Galaxy: ${
            galaxyOptions.find((galaxy) => galaxy.slug === search.galaxy)?.name ?? "Any galaxy"
          }`}
          emptyLabel="Any galaxy"
          icon={<PlanetIcon className="size-4 shrink-0 text-muted-foreground" />}
          onCommit={(galaxy) => commit({ galaxy })}
          options={galaxyOptions.map((galaxy) => ({ label: galaxy.name, value: galaxy.slug }))}
          value={search.galaxy}
        />
      ) : undefined}

      {tracksSearchHasFilters(search) ? (
        <Button
          className="tracks-filter-clear"
          nativeButton={false}
          render={<Link to="/tracks" />}
          size="sm"
          variant="ghost"
        >
          Clear filters
        </Button>
      ) : undefined}
    </section>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────────────────

const numberFormatter = new Intl.NumberFormat("en-US");

/** "1 match" / "312 matches" — the count of tracks a filter set holds, by the form when it is active. */
function matchCount(count: number): string {
  return `${numberFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function TracksPage() {
  const { filters, galaxyOptions, hasFilters, heldTotal, hub, labelOptions, years } =
    Route.useLoaderData();
  const buildHref = (page: number) => buildTracksHref(filters, page);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Tracks</h1>
          {/* Reference register (VOICE.md's Three Areas): one factual line — the held count plus
              the list's order (operator ruling 2026-07-20: count-led, no filler tail). The lit/unlit
              split stays visual, never verbal (the Unlit Rule). On a FILTERED view the count drops:
              heldTotal is the whole-archive figure, and captioning a filtered subset with it would
              lie — the aria-live matchline under the filters owns that number. ONE composed string
              (see tracksMastheadLine): a conditional JSX clause SSRs as comment-split text nodes,
              which naive text extraction misreads as a missing count. */}
          <p className="log-index-intro">
            {tracksMastheadLine(tracksSearchHasFilters(filters) ? 0 : heldTotal)}
          </p>
        </header>

        {/* Keyed by the search state: each pill seeds its local state from the URL, so a fresh URL
            must remount the bar to re-seed every control (otherwise a cleared filter would leave a
            stale value on a pill while the list resets under it). The URL is the one source of truth. */}
        <TracksFilters
          galaxyOptions={galaxyOptions}
          key={JSON.stringify(filters)}
          labelOptions={labelOptions}
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

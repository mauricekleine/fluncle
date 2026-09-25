import { Link, createFileRoute, notFound, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { CalendarBlankIcon, CaretDownIcon, MusicNotesIcon, TagIcon } from "@phosphor-icons/react";
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
import { StyleChips } from "@/components/search/style-chips";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { DiscoveryPlayableList } from "@/components/discovery-row";
import { readTracksHubAtOneTime, readTracksHubSoundAtOneTime } from "./-tracks-hub-reads";
import { TracksHubRow } from "@/components/tracks-hub-row";
import { hubEntryToDiscoveryTrack } from "@/lib/discovery-tracks";
import {
  type CatalogueHubNumberedPage,
  CatalogueHubPageOutOfRangeError,
  listKnownLabelNames,
} from "@/lib/server/labels";
import { type TracksHubEntry, type TracksHubYearLaneEntry } from "@/lib/server/tracks-hub";
import { anchorNames, styleBySlug } from "@/lib/search-styles";
import {
  KEY_FILTER_OPTIONS,
  TRACKS_HUB_MAX_PAGE,
  type TracksSearch,
  buildTracksHref,
  parseTracksHubPayload,
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
// `bpmMin`/`bpmMax`, `key`, `label`, compiled by the same `compileFilters`. `sound` is the one
// extension: a style from the lexicon, which re-ranks the list closest first by that style's sound
// rather than filtering it (lib/server/style-probe.ts). Galaxies are the lore map of findings, not a
// catalogue filter, so an old `?galaxy=` link is sent to that galaxy's own page.
//
// PAGINATION IS NUMBERED (the `/labels` hub precedent, #731): every page — page 1 the bare `/tracks`,
// `?page=N` beyond — SSRs one `limit/offset` slice behind a real-anchor pager, and a quiet YEAR fast
// lane jumps to the page a release year starts on (the A–Z lane mechanic mapped onto time). Nothing
// loads on scroll, so a crawler that runs no JS walks the whole list. A public route: loader +
// `useLoaderData`, no react-query (AGENTS.md). The bare hub is indexable + in the sitemap; ANY filter
// param present flips it to `noindex`, and only the bare `/tracks` is a sitemap URL.

/** How a `?sound=` page was ordered: the anchors its sound came from, and whether it ranked at all
    (false when the ranking could not run and the page fell back to newest first). */
type TracksSoundState = { anchors: string[]; limited?: boolean; ranked: boolean; slug: string };

/** The serverFn payload: a page of the hub (or "missing" for a page past the end), the year lane, the
    whole held count, the label options for the filter control, and the sound state when ranked. */
type TracksFetchResult =
  | {
      heldTotal: number;
      hub: CatalogueHubNumberedPage<TracksHubEntry>;
      labelOptions: string[];
      sound?: TracksSoundState;
      status: "found";
      years: TracksHubYearLaneEntry[];
    }
  | { status: "missing" };

/** What the loader returns: the found page plus the resolved filters + page, so head + component read
    them directly. */
type TracksLoaderData = {
  filters: TracksSearch;
  hasFilters: boolean;
  heldTotal: number;
  hub: CatalogueHubNumberedPage<TracksHubEntry>;
  labelOptions: string[];
  page: number;
  sound?: TracksSoundState;
  years: TracksHubYearLaneEntry[];
};

/** A page param the reader typed: junk / absent / out-of-range folds to undefined (the bare page-1
    view). The cap mirrors the serverFn payload boundary so URL navigation cannot create a rejected
    loader call. */
function pageParam(value: unknown): number | undefined {
  const n = Math.trunc(Number(value));

  return Number.isSafeInteger(n) && n >= 1 && n <= TRACKS_HUB_MAX_PAGE ? n : undefined;
}

// The page fetch — the SAME serverFn the loader calls (no oRPC op; the hub reads through
// `createServerFn` like the other hubs). It reads the page + the year lane + the held count together,
// and returns "missing" for a page past the end so the loader can 404 rather than clamp.
//
// ONE WAVE, NOT TWO. Every round trip here is the Worker reaching a database a continent away, so a
// sequential wave costs a full latency unit however cheap its SQL. The label options do not depend on
// the page read and the page read does not depend on them, so they are fired together.
//
// A `?sound=` page is a different ORDER over the same filters: the style's probe ranks the list
// closest first, so the year lane (a map of the newest-first order onto pages) is not read for it.
const fetchTracksHubPage = createServerFn({ method: "GET" })
  // A real runtime parse, not an identity cast: the fn is directly reachable over HTTP, so the
  // payload is allowlisted to the hub's own axes before anything compiles (`certified` and `galaxy`
  // stripped here; the decision and the field rules live on `parseTracksHubPayload`).
  .validator(parseTracksHubPayload)
  .handler(async ({ data }): Promise<TracksFetchResult> => {
    const { filters } = data;
    // Fired first and awaited last: the option list rides alongside the page read.
    const labelOptionsPromise = listKnownLabelNames();
    const hasFilters = tracksSearchHasFilters(filters);
    const style = styleBySlug(filters.sound);
    // The year lane is the A–Z lane over time; a year filter already narrows to one region of it, so
    // it is hidden then (the lane read is skipped, not just unrendered).
    const yearFiltered = filters.yearMin !== undefined || filters.yearMax !== undefined;

    try {
      if (style) {
        const [labelOptions, reads] = await Promise.all([
          labelOptionsPromise,
          import("@tanstack/react-start/server").then(({ getRequest }) =>
            readTracksHubSoundAtOneTime(filters, style, data.page, { request: getRequest() }),
          ),
        ]);
        const [soundPage, heldTotal] = reads;

        return {
          heldTotal,
          hub: soundPage.hub,
          labelOptions,
          sound: {
            anchors: soundPage.anchors,
            ...(soundPage.limited ? { limited: true } : {}),
            ranked: soundPage.ranked,
            slug: style.slug,
          },
          status: "found",
          // The newest-first year lane maps onto the fallback order only.
          years: [],
        };
      }

      const [labelOptions, reads] = await Promise.all([
        labelOptionsPromise,
        readTracksHubAtOneTime(filters, data.page, yearFiltered, hasFilters),
      ]);
      const [hub, years, heldTotal] = reads;

      return {
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
    const { galaxy, page: pageValue, ...filters } = deps.search;

    // Galaxies are the lore map of findings, not a catalogue filter: an old `?galaxy=` link lands on
    // that galaxy's own page, permanently.
    if (galaxy !== undefined) {
      throw redirect({ params: { slug: galaxy }, statusCode: 301, to: "/galaxies/$slug" });
    }

    const page = pageValue ?? 1;
    const data = await fetchTracksHubPage({ data: { filters, page } });

    if (data.status === "missing") {
      throw notFound();
    }

    return {
      filters,
      hasFilters: tracksSearchHasFilters(filters),
      heldTotal: data.heldTotal,
      hub: data.hub,
      labelOptions: data.labelOptions,
      page,
      sound: data.sound,
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

/** A single-select pill (Key): a base-ui Select dressed as a pill, committing on change.
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
function TracksFilters({ labelOptions, search }: { labelOptions: string[]; search: TracksSearch }) {
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

/** The matchline: the count, and on a sound-ranked page the order and the artists it leans on (or,
    when the ranking could not run, that this is the newest-first list instead). */
function tracksMatchline(total: number, sound: TracksSoundState | undefined): string {
  const style = styleBySlug(sound?.slug);

  if (!sound || !style) {
    return matchCount(total);
  }

  // A style orders the list and never filters it, so the count names tracks, never "matches".
  const tracks = `${numberFormatter.format(total)} ${total === 1 ? "track" : "tracks"}`;

  // Two different facts: the style has no anchors with a sound yet (a data gap), or the ranking
  // engine could not answer just now (an outage). Neither is dressed up as the other.
  if (sound.limited) {
    return `${tracks}, newest first. That’s a lot of searching from one place in one go. Give it a minute, then reload for the ${style.label} order.`;
  }

  if (!sound.ranked) {
    return sound.anchors.length === 0
      ? `${tracks}, newest first. The ${style.label} order isn’t ready yet.`
      : `${tracks}, newest first. The ${style.label} order didn’t load just then.`;
  }

  // The masthead names the order; the matchline counts the list and names what the sound was
  // built from, in the phrasing `/search` uses for a style answer.
  return `${tracks}, going by ${anchorNames(sound.anchors)}.`;
}

function TracksPage() {
  const { filters, hasFilters, heldTotal, hub, labelOptions, sound, years } = Route.useLoaderData();
  const buildHref = (page: number) => buildTracksHref(filters, page);
  const nextPageHref = hub.page < hub.pageCount ? buildHref(hub.page + 1) : undefined;
  const discoveryTracks = useMemo(() => hub.items.map(hubEntryToDiscoveryTrack), [hub.items]);

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
            {tracksMastheadLine(
              tracksSearchHasFilters(filters) ? 0 : heldTotal,
              sound?.ranked
                ? `closest to ${styleBySlug(sound.slug)?.label ?? ""} first`
                : undefined,
            )}
          </p>
        </header>

        {/* Keyed by the search state: each pill seeds its local state from the URL, so a fresh URL
            must remount the bar to re-seed every control (otherwise a cleared filter would leave a
            stale value on a pill while the list resets under it). The URL is the one source of truth. */}
        {/* The way in by sound: a chip ranks this list closest first by that style, keeping every
            other filter, and the pressed chip takes the ranking off again. */}
        <StyleChips
          active={filters.sound}
          className="tracks-style-chips"
          hrefFor={(style, pressed) =>
            buildTracksHref({ ...filters, sound: pressed ? undefined : style.slug }, 1)
          }
          label="Sound"
          labelId="tracks-style-chips-label"
        />

        <TracksFilters key={JSON.stringify(filters)} labelOptions={labelOptions} search={filters} />

        {hasFilters ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {tracksMatchline(hub.total, sound)}
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
          // The page is one list to the player: play on any row queues this page from there, and
          // at its end "keep going" walks to the next page.
          <DiscoveryPlayableList nextPageHref={nextPageHref} tracks={discoveryTracks}>
            <ol aria-label="Tracks" className="discovery-list tracks-hub-rows">
              {hub.items.map((entry) => (
                <TracksHubRow entry={entry} key={entryKey(entry)} />
              ))}
            </ol>
          </DiscoveryPlayableList>
        )}

        <CataloguePager
          buildHref={buildHref}
          label="More tracks, more pages"
          page={hub.page}
          pageCount={hub.pageCount}
        />

        <footer className="log-plate-footer">
          <Link to="/findings">Back to the archive</Link>
          <Link to="/fresh">Fresh</Link>
        </footer>
      </article>
    </main>
  );
}

function entryKey(entry: TracksHubEntry): string {
  return entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId;
}

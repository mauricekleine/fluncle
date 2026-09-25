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

type TracksSoundState = { anchors: string[]; limited?: boolean; ranked: boolean; slug: string };

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

function pageParam(value: unknown): number | undefined {
  const n = Math.trunc(Number(value));

  return Number.isSafeInteger(n) && n >= 1 && n <= TRACKS_HUB_MAX_PAGE ? n : undefined;
}

const fetchTracksHubPage = createServerFn({ method: "GET" })
  .validator(parseTracksHubPayload)
  .handler(async ({ data }): Promise<TracksFetchResult> => {
    const { filters } = data;

    const labelOptionsPromise = listKnownLabelNames();
    const hasFilters = tracksSearchHasFilters(filters);
    const style = styleBySlug(filters.sound);

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
      if (error instanceof CatalogueHubPageOutOfRangeError) {
        return { status: "missing" };
      }

      throw error;
    }
  });

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

function yearParam(value: string): number | undefined {
  const n = Number(value.trim());

  return Number.isInteger(n) && n >= 1900 && n <= 2200 ? n : undefined;
}

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

function CaretPill() {
  return <CaretDownIcon className="size-4 shrink-0 text-muted-foreground" />;
}

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

type LabelOption = { isNew?: boolean; label: string; value: string };

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

function TracksFilters({ labelOptions, search }: { labelOptions: string[]; search: TracksSearch }) {
  const navigate = useNavigate();

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

const numberFormatter = new Intl.NumberFormat("en-US");

function matchCount(count: number): string {
  return `${numberFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function tracksMatchline(total: number, sound: TracksSoundState | undefined): string {
  const style = styleBySlug(sound?.slug);

  if (!sound || !style) {
    return matchCount(total);
  }

  const tracks = `${numberFormatter.format(total)} ${total === 1 ? "track" : "tracks"}`;

  if (sound.limited) {
    return `${tracks}, newest first. That’s a lot of searching from one place in one go. Give it a minute, then reload for the ${style.label} order.`;
  }

  if (!sound.ranked) {
    return sound.anchors.length === 0
      ? `${tracks}, newest first. The ${style.label} order isn’t ready yet.`
      : `${tracks}, newest first. The ${style.label} order didn’t load just then.`;
  }

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

          <p className="log-index-intro">
            {tracksMastheadLine(
              tracksSearchHasFilters(filters) ? 0 : heldTotal,
              sound?.ranked
                ? `closest to ${styleBySlug(sound.slug)?.label ?? ""} first`
                : undefined,
            )}
          </p>
        </header>

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

        <HubYearLane buildHref={buildHref} label="Tracks by year" years={years} />

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {hasFilters
              ? "No tracks match those filters. Loosen them and try again."
              : "Nothing here yet. Quiet sector tonight."}
          </p>
        ) : (
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

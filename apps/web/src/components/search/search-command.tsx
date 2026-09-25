import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@fluncle/ui/components/command";
import {
  ArrowRightIcon,
  CaretRightIcon,
  ListMagnifyingGlassIcon,
  MagnifyingGlassIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SpotifyIcon } from "@/components/platform-icons";
import { SearchFilterChips } from "@/components/search/search-filter-chips";
import { SearchExampleGlyph } from "@/components/search/search-glyph";
import { anchorCredit, EntitySoundLine } from "@/components/search/search-results-list";
import { albumCoverAtSize } from "@/lib/media";
import {
  classifySearchQueryKind,
  emitDiscoveryEvent,
  emitDiscoveryFromHref,
} from "@/lib/discovery-events";
import {
  EMPTY_SEARCH,
  ENTITY_GROUPS,
  MIN_QUERY_LENGTH,
  SEARCH_EXAMPLES,
  type SearchEntity,
  type SearchHit,
  type SearchResponse,
  entityHref,
  hitHref,
  searchArchiveApiPath,
  searchPagePath,
} from "@/lib/search-results";
import { cn } from "@/lib/utils";

async function fetchSearch(q: string): Promise<SearchResponse> {
  const response = await fetch(searchArchiveApiPath(q));

  if (!response.ok) {
    return EMPTY_SEARCH;
  }

  return (await response.json()) as SearchResponse;
}

function Cover({ hit }: { hit: SearchHit }): ReactNode {
  if (!hit.albumImageUrl) {
    return <span aria-hidden="true" className="search-cover search-cover--empty" />;
  }

  return <img alt="" className="search-cover" loading="lazy" src={hit.albumImageUrl} />;
}

function TrackRow({
  hit,
  onPick,
}: {
  hit: SearchHit;
  onPick: (hit: SearchHit) => void;
}): ReactNode {
  return (
    <CommandItem
      className={cn("search-row", !hit.certified && "search-row--unlit")}
      key={hit.trackId}
      onSelect={() => onPick(hit)}
      value={`${hit.trackId} ${hit.title} ${hit.artists.join(" ")}`}
    >
      <Cover hit={hit} />
      <span className="search-row-text">
        <span className="search-row-title">{hit.title}</span>
        <span className="search-row-artists">{hit.artists.join(", ")}</span>
      </span>

      <CommandShortcut className="search-row-tail">
        {hit.certified && hit.logId ? (
          <span className="search-row-coordinate">{hit.logId}</span>
        ) : hitHref(hit)?.external === false ? (
          <CaretRightIcon aria-hidden="true" className="search-row-out" size={16} weight="bold" />
        ) : (
          <SpotifyIcon className="search-row-out" />
        )}
      </CommandShortcut>
    </CommandItem>
  );
}

function EntityRow({
  entity,
  onPick,
}: {
  entity: SearchEntity;
  onPick: (entity: SearchEntity) => void;
}): ReactNode {
  return (
    <CommandItem
      className="search-row"
      onSelect={() => onPick(entity)}
      value={`${entity.kind}-${entity.slug}`}
    >
      {entity.imageUrl ? (
        <img
          alt=""
          className="search-cover"
          decoding="async"
          loading="lazy"
          src={albumCoverAtSize(entity.imageUrl, "small")}
        />
      ) : (
        <span aria-hidden="true" className="search-cover search-cover--empty" />
      )}
      <span className="search-row-text">
        <span className="search-row-title">{entity.name}</span>
        <EntitySoundLine entity={entity} />
      </span>
      <CommandShortcut className="search-row-tail">
        <ArrowRightIcon aria-hidden="true" className="search-jump-icon" />
      </CommandShortcut>
    </CommandItem>
  );
}

function SearchDialog({
  onOpenChange,
  open,
  seed,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;

  seed?: { query: string; token: number };
}): ReactNode {
  const navigate = useNavigate();
  const [query, setQuery] = useState(seed?.query ?? "");
  const [debounced, setDebounced] = useState("");
  const exampleClick = useRef(false);
  const seedToken = seed?.token;
  const seedQuery = seed?.query;

  useEffect(() => {
    if (seedToken === undefined || seedQuery === undefined) {
      return;
    }

    setQuery(seedQuery);

    setDebounced(seedQuery.trim());
  }, [seedQuery, seedToken]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = query.trim();

      setDebounced(next);

      if (exampleClick.current) {
        exampleClick.current = false;

        return;
      }

      if (next.length >= MIN_QUERY_LENGTH) {
        emitDiscoveryEvent("discovery_search", { kind: classifySearchQueryKind(next) });
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [query]);

  const enabled = debounced.length >= MIN_QUERY_LENGTH;
  const { data = EMPTY_SEARCH, isFetching } = useQuery({
    enabled,
    queryFn: () => fetchSearch(debounced),
    queryKey: ["search", debounced],

    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const close = useCallback(() => {
    onOpenChange(false);
    setQuery("");
    setDebounced("");
  }, [onOpenChange]);

  const goTo = useCallback(
    (to: string) => {
      close();
      void navigate({ to: to as never });
    },
    [close, navigate],
  );

  const pickEntity = useCallback(
    (entity: SearchEntity) => {
      const href = entityHref(entity);

      emitDiscoveryFromHref(href);
      goTo(href);
    },
    [goTo],
  );

  const pick = useCallback(
    (hit: SearchHit) => {
      const destination = hitHref(hit);

      if (!destination) {
        return;
      }

      emitDiscoveryFromHref(destination.href);

      if (destination.external) {
        close();
        window.open(destination.href, "_blank", "noopener,noreferrer");

        return;
      }

      goTo(destination.href);
    },
    [close, goTo],
  );

  const openPage = useCallback(() => goTo(searchPagePath(debounced)), [debounced, goTo]);

  const showExamples = query.trim().length === 0;
  const nothing = enabled && !isFetching && data.results.length === 0 && data.entities.length === 0;

  const findings = useMemo(() => data.results.filter((hit) => hit.certified), [data.results]);
  const unlit = useMemo(() => data.results.filter((hit) => !hit.certified), [data.results]);

  const headUnlit = findings.length > 0 || data.entities.length > 0;

  const emptyCopy = useMemo(() => {
    if (data.kind === "coordinate") {
      return "No finding at that coordinate.";
    }

    return "Nothing out here.";
  }, [data.kind]);

  return (
    <CommandDialog
      className="search-dialog"
      description="Search Fluncle's archive by name, coordinate, or the sound of it."
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      open={open}
      title="Search the archive"
    >
      <Command shouldFilter={false}>
        <CommandInput
          onValueChange={setQuery}
          placeholder="A name, a coordinate, or the sound of it…"
          value={query}
        />

        {showExamples ? (
          <div className="search-examples">
            {SEARCH_EXAMPLES.map((example) => (
              <button
                className="search-example"
                key={example.query}
                onClick={() => {
                  exampleClick.current = true;
                  emitDiscoveryEvent("discovery_example", { kind: example.icon });
                  setQuery(example.query);
                }}
                type="button"
              >
                <SearchExampleGlyph className="search-example-icon" icon={example.icon} />
                {example.query}
              </button>
            ))}
          </div>
        ) : undefined}

        {data.anchor ? (
          <p className="search-note">
            <WaveformIcon aria-hidden="true" className="search-note-icon" />
            Near <strong>{anchorCredit(data.anchor)}</strong>
          </p>
        ) : undefined}

        {data.degraded ? (
          <p className="search-note search-note--degraded">
            Reading by name only right now. These are the closest words I've got.
          </p>
        ) : undefined}

        {data.filters ? <SearchFilterChips filters={data.filters} /> : undefined}

        {nothing ? <p className="search-note search-note--empty">{emptyCopy}</p> : undefined}

        <CommandList>
          {ENTITY_GROUPS.map((group) => {
            const entities = data.entities.filter((entity) => entity.kind === group.kind);

            if (entities.length === 0) {
              return undefined;
            }

            return (
              <CommandGroup heading={group.heading} key={group.kind}>
                {entities.map((entity) => (
                  <EntityRow
                    entity={entity}
                    key={`${entity.kind}-${entity.slug}`}
                    onPick={pickEntity}
                  />
                ))}
              </CommandGroup>
            );
          })}

          {findings.length > 0 ? (
            <CommandGroup heading="Findings">
              {findings.map((hit) => (
                <TrackRow hit={hit} key={hit.trackId} onPick={pick} />
              ))}
            </CommandGroup>
          ) : undefined}

          {unlit.length > 0 ? (
            headUnlit ? (
              <CommandGroup heading="Tracks">
                {unlit.map((hit) => (
                  <TrackRow hit={hit} key={hit.trackId} onPick={pick} />
                ))}
              </CommandGroup>
            ) : (
              unlit.map((hit) => <TrackRow hit={hit} key={hit.trackId} onPick={pick} />)
            )
          ) : undefined}

          {enabled ? (
            <CommandGroup>
              <CommandItem
                className="search-row search-handoff"
                onSelect={openPage}
                value="__open-search-page"
              >
                <ListMagnifyingGlassIcon aria-hidden="true" className="search-handoff-icon" />
                <span className="search-row-text">
                  <span className="search-row-title">Open this search as a page</span>
                </span>
                <CommandShortcut className="search-row-tail">
                  <ArrowRightIcon aria-hidden="true" className="search-jump-icon" />
                </CommandShortcut>
              </CommandItem>
            </CommandGroup>
          ) : undefined}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

export type SearchController = {
  open: (query?: string) => void;

  seed?: { query: string; token: number };

  setOpen: (open: boolean) => void;

  state: boolean;
};

const SearchContext = createContext<SearchController | undefined>(undefined);

export function SearchProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<{ query: string; token: number }>();

  const controller = useMemo<SearchController>(
    () => ({
      open: (query?: string) => {
        if (query !== undefined) {
          setSeed((current) => ({ query, token: (current?.token ?? 0) + 1 }));
        }

        setOpen(true);
      },
      seed,
      setOpen,
      state: open,
    }),
    [open, seed],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return <SearchContext.Provider value={controller}>{children}</SearchContext.Provider>;
}

export function useSearchController(): SearchController {
  const controller = useContext(SearchContext);

  return controller ?? NO_SEARCH;
}

const NO_SEARCH: SearchController = { open: () => {}, setOpen: () => {}, state: false };

export function SearchTrigger({ showTrigger = true }: { showTrigger?: boolean }): ReactNode {
  const { open, seed, setOpen, state } = useSearchController();
  const isApple = useIsApple();

  return (
    <>
      {showTrigger ? (
        <button
          aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}
          aria-label="Search the archive"
          className="search-trigger"
          onClick={() => open()}
          type="button"
        >
          <MagnifyingGlassIcon aria-hidden="true" className="search-trigger-icon" />
          <span className="search-trigger-label">Search</span>

          <kbd aria-hidden="true" className="search-trigger-kbd">
            {isApple ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      ) : undefined}

      <SearchDialog onOpenChange={setOpen} open={state} seed={seed} />
    </>
  );
}

export function useIsApple(): boolean {
  const [isApple, setIsApple] = useState(false);

  useEffect(() => {
    setIsApple(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent));
  }, []);

  return isApple;
}

// FLUNCLE'S SEARCH — the ACCELERATOR.
//
// A trigger in the top bar, ⌘K / Ctrl+K from anywhere, and one Shadcn `Command` dialog. The
// text input lives INSIDE the dialog; the bar is only a way in.
//
// ── IT IS ONE OF TWO SURFACES, AND IT IS THE FAST ONE ────────────────────────────────
// The palette is the quickest way to reach one known thing and the worst way to HOLD a result
// set: it has no URL, so what it shows cannot be shared, reloaded, or walked back to. `/search`
// (routes/search.tsx) is the other half — the same resolver, server-rendered, with the whole
// query state in `?q=`. This dialog therefore HANDS OFF to it (the last row of every answer,
// `openPage` below) rather than being replaced by it: ⌘K stays one keystroke from every public
// page, and nothing a reader finds through it is trapped in a dialog.
//
// Everything that is not a rendering decision — the wire types, the grouping, the example
// queries, the two destinations, the URL builders — lives in `lib/search-results.ts`, which the
// page imports too, so the two rooms cannot drift on what an answer means.
//
// ── WHAT THE DIALOG IS SAYING, DESIGN-WISE ───────────────────────────────────────────
// The colophon nav is deliberately restrained — a wordmark, a breadcrumb, and nothing else —
// and the cover art is the hero of every page. So search does not get a field in the chrome,
// which would put a form control in the quietest surface in the app. It gets a single quiet
// glyph at the far right of the bar, on the opposite end from the trail, where it competes
// with nothing. The weight is all in the dialog, which opens over the cosmos and closes again.
//
// ── THE UNLIT RULE (DESIGN.md) ───────────────────────────────────────────────────────
// A finding is lit: it carries its coordinate in Oxanium and heats to Eclipse Gold on hover
// (the Gold Veil), because Eclipse Gold is the CERTIFICATION light. A track Fluncle never
// certified catches the Dust Veil instead — the cold light of a thing seen from a distance —
// carries no coordinate, and links OUT to Spotify, because there is no `/log` page to go to.
// The uncertified TIER is never named: no badge, no introduction, no noun of its own. In a
// mixed list a heading may name the SUPERSET ("Tracks" — true of every row under it, the
// mix-builder precedent), and the findings group carries the archive's own name ("Fluncle's
// Findings") because a finding IS a named object. When the unlit rows are all there is, they
// stand bare — a heading over the only content would exist just to name the tier.
// The focus ring stays Eclipse Gold on every row either way — focus is an accessibility
// affordance, not a claim about the music.

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
import { anchorCredit } from "@/components/search/search-results-list";
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

// ── Rows ─────────────────────────────────────────────────────────────────────────────

/** The cover, or the Dust-Veil square that stands in for one. Never a gold placeholder. */
function Cover({ hit }: { hit: SearchHit }): ReactNode {
  if (!hit.albumImageUrl) {
    return <span aria-hidden="true" className="search-cover search-cover--empty" />;
  }

  return <img alt="" className="search-cover" loading="lazy" src={hit.albumImageUrl} />;
}

/**
 * One track row. The `certified` bit decides everything visible about it: a finding carries
 * its coordinate and lights gold; an uncertified track carries a Spotify mark and stays cold.
 * Neither is labelled — the difference is the register, not a badge.
 */
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
      {/* The trailing slot is a `CommandShortcut` in both registers — not for the shortcut
          styling, but because the primitive suppresses its own trailing check glyph when it
          finds one, which is what keeps the right edge clean. */}
      <CommandShortcut className="search-row-tail">
        {hit.certified && hit.logId ? (
          <span className="search-row-coordinate">{hit.logId}</span>
        ) : (
          <SpotifyIcon className="search-row-out" />
        )}
      </CommandShortcut>
    </CommandItem>
  );
}

/**
 * One entity row — an artist, a label, or an album. The FIRST-CLASS destination: the thing the
 * reader searched for, offered as somewhere to go, above the tracks it also brought back.
 *
 * The three are ONE row on purpose. A label is not a chip and an album is not a filter; each is
 * a page in the graph (`docs/album-entity.md`), and a search that hands you a list of tracks
 * while withholding the record they came off is answering a smaller question than you asked.
 *
 * The picture is the artist's portrait, or — where there is no portrait — the entity's cover
 * art (its freshest finding's sleeve, the same one `/labels` and `/albums` print). Failing
 * both, the same Dust-Veil square a coverless track gets. Never a gold placeholder.
 */
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
      {/* A palette row's cover is 2.25rem — 36 CSS px, 72 on a 2× screen — so it takes the 64 rung
          (an unowned artist portrait, Spotify's 160 floor), never the 640 the search DTO hands out
          for consumers that never re-size. A palette can list ~20 rows at once, so this is the
          heaviest single over-fetch a keystroke could trigger. */}
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
      </span>
      <CommandShortcut className="search-row-tail">
        <ArrowRightIcon aria-hidden="true" className="search-jump-icon" />
      </CommandShortcut>
    </CommandItem>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────────────

export function SearchDialog({
  onOpenChange,
  open,
  seed,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /**
   * A query to open WITH — the front door's example pills hand one over, so a click lands in the
   * dialog already answering rather than in an empty field the reader has to retype into. It is a
   * SEED, not a controlled value: the reader owns the field from the first keystroke after. Bumping
   * the token re-seeds, so clicking the same example twice re-opens it the same way.
   */
  seed?: { query: string; token: number };
}): ReactNode {
  const navigate = useNavigate();
  const [query, setQuery] = useState(seed?.query ?? "");
  const [debounced, setDebounced] = useState("");
  const exampleClick = useRef(false);
  const seedToken = seed?.token;
  const seedQuery = seed?.query;

  // Seeding is an EFFECT on the token rather than a prop read on every render, because the field is
  // the reader's the moment they type. Without the token a re-render would keep stamping the
  // example back over what they wrote.
  useEffect(() => {
    if (seedToken === undefined || seedQuery === undefined) {
      return;
    }

    setQuery(seedQuery);
    // Answer immediately: the reader picked a whole query, so there is no typing to wait out.
    setDebounced(seedQuery.trim());
  }, [seedQuery, seedToken]);

  // A keystroke is not a query. The debounce is what keeps a typed word from firing five
  // round trips (and, on the fourth tier, five model calls) on its way to being one.
  // A worked example already emitted discovery_example; do not also fire discovery_search.
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
    // A public read: the archive does not change while you look away from the tab.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const close = useCallback(() => {
    onOpenChange(false);
    setQuery("");
    setDebounced("");
  }, [onOpenChange]);

  // The server hands back a plain path (`/log/024.7.2R`, `/artist/netsky`) — a data-driven
  // destination, not a compile-time route literal — so the cast happens at the ONE navigate
  // boundary, exactly as `NavRouteLink` does it for the data-driven nav model. TanStack builds
  // the real href from the string at runtime regardless of the compile-time union.
  const goTo = useCallback(
    (to: string) => {
      close();
      void navigate({ to: to as never });
    },
    [close, navigate],
  );

  /** An entity goes to its page — the row's own `url` when it carries one (a galaxy's plural
      segment, a mixtape's log page), else the `/<kind>/<slug>` default. */
  const pickEntity = useCallback(
    (entity: SearchEntity) => {
      const href = entityHref(entity);

      emitDiscoveryFromHref(href);
      goTo(href);
    },
    [goTo],
  );

  /** A finding goes to its coordinate. A track with no coordinate goes OUT, to Spotify. */
  const pick = useCallback(
    (hit: SearchHit) => {
      if (hit.certified && hit.logId) {
        emitDiscoveryFromHref(`/log/${hit.logId}`);
        goTo(`/log/${hit.logId}`);

        return;
      }

      if (hit.spotifyUrl) {
        emitDiscoveryFromHref(hit.spotifyUrl);
        close();
        window.open(hit.spotifyUrl, "_blank", "noopener,noreferrer");
      }
    },
    [close, goTo],
  );

  /**
   * THE HANDOFF. The palette is the accelerator; `/search` is the room you can link to, reload, and
   * walk back through. So the last thing in every answer is the door to it, carrying the query the
   * reader already typed — the palette stays the fast way in and stops being the ONLY way in.
   */
  const openPage = useCallback(() => goTo(searchPagePath(debounced)), [debounced, goTo]);

  const showExamples = query.trim().length === 0;
  const nothing = enabled && !isFetching && data.results.length === 0 && data.entities.length === 0;

  // The two registers, partitioned once. The server already ranks certified first; the split
  // here is what lets each block carry its own heading (or, for a bare unlit list, none).
  const findings = useMemo(() => data.results.filter((hit) => hit.certified), [data.results]);
  const unlit = useMemo(() => data.results.filter((hit) => !hit.certified), [data.results]);
  // "Tracks" earns its place only when something named renders above it — then it is doing
  // contrastive work and names the superset. Alone, it would exist just to name the tier.
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
      {/* `shouldFilter={false}` — the ranking is the SERVER's (bm25, vector distance, the
          certified-first tier order). cmdk's own fuzzy filter would re-sort the answer and
          quietly hide rows the resolver deliberately returned. */}
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
            {/* `Artist — Title`, the one sanctioned em dash (VOICE.md §6); inverted it would be an
                em dash in prose, which the same rule bans. Shared with `/search`'s own note. */}
            Near <strong>{anchorCredit(data.anchor)}</strong>
          </p>
        ) : undefined}

        {/* The honesty line. The model was wanted and could not run, so these are text hits,
            not the filters you asked for — and search says so rather than passing one off as
            the other. */}
        {data.degraded ? (
          <p className="search-note search-note--degraded">
            Reading by name only right now. These are the closest words I've got.
          </p>
        ) : undefined}

        {data.filters ? <SearchFilterChips filters={data.filters} /> : undefined}

        {/* There is no synthetic "Go to /artist/netsky" row anywhere in here, deliberately. A
            resolved coordinate comes back as the FINDING (cover, title, coordinate) and a
            resolved artist, label, or album as the ENTITY — the thing, never a rendering of the
            URL you are about to visit. Each is first in the list, so Enter lands exactly where
            the redirect would have taken you. */}
        {/* The empty line sits OUTSIDE `CommandList`, where `CommandEmpty` used to live inside it.
            `CommandEmpty` renders only while the list holds no items, and the handoff row below is
            an item that is always there once a query is long enough — so keeping the message in
            `CommandEmpty` would have silently deleted it in exactly the state it exists for. */}
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

          {/* The findings lead, headed by the NAMED OBJECT rather than the collection's nameplate:
              DESIGN.md's Unlit Rule reserves "Fluncle's Findings" for lore-area surfaces, and a
              palette that opens over every page is not one. Same heading as `/search`, so the two
              doors onto one resolver cannot drift. */}
          {findings.length > 0 ? (
            <CommandGroup heading="Findings">
              {findings.map((hit) => (
                <TrackRow hit={hit} key={hit.trackId} onPick={pick} />
              ))}
            </CommandGroup>
          ) : undefined}

          {/* The unlit rows follow. "Tracks" names the SUPERSET, never the tier (the Unlit
              Rule; the mix-builder precedent) — and only when a named group renders above it.
              A bare unlit list stays unheaded: the register is the only claim made about it. */}
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

          {/* Last, and present in EVERY answered state including the empty one — a query that found
              nothing in a palette is precisely when a reader wants the surface that can explain
              itself, hold the query in a URL, and be sent to someone else. */}
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

// ── The one dialog, and the two ways in ──────────────────────────────────────────────

/**
 * The search controller: `open()` with nothing to land in an empty field, or with a query to land
 * already answering.
 */
export type SearchController = {
  open: (query?: string) => void;
  /** The seed the dialog is mounted with, owned by the provider. */
  seed?: { query: string; token: number };
  /** The dialog's setter, so the one MOUNT POINT below can close it. */
  setOpen: (open: boolean) => void;
  /** Whether the dialog is open — read only by the mount point. */
  state: boolean;
};

const SearchContext = createContext<SearchController | undefined>(undefined);

/**
 * ONE dialog and ONE ⌘K listener for the whole public app, mounted by `PublicChrome`.
 *
 * It is a provider rather than state inside the trigger because search now has TWO ways in — the
 * colophon's quiet glyph on every page, and the front door's large seeding entry with its example
 * pills. Two mounted dialogs would mean two ⌘K owners and two answer surfaces to keep in step; one
 * provider means the ways in are genuinely just doors onto the same room.
 */
export function SearchProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<{ query: string; token: number }>();

  // A monotonic token, not the query string: opening on the SAME example twice has to re-seed, and
  // the token is the only thing that changes on the second click.
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

/**
 * Reach the one dialog from anywhere under the chrome. Outside a provider (the chromeless
 * full-bleed surfaces) it is a no-op rather than a throw: a way IN that cannot open is a dead
 * control, never a crashed page.
 */
export function useSearchController(): SearchController {
  const controller = useContext(SearchContext);

  return controller ?? NO_SEARCH;
}

const NO_SEARCH: SearchController = { open: () => {}, setOpen: () => {}, state: false };

/**
 * The colophon's search slot: the quiet glyph, and the one MOUNT POINT for the dialog itself.
 *
 * `showTrigger` hides the GLYPH where the page already carries a larger door to the same action —
 * the front door's seeding field. Two controls answering to one name on one screen is ambiguous to a
 * screen reader and unusable by voice, and a second quieter door for an action already offered in
 * full is exactly what The Quiet Surface Rule takes off a surface. The ⌘K shortcut is unaffected:
 * its listener lives on the provider, so the keystroke works on every public page either way.
 *
 * `⌘K` on Apple, `Ctrl+K` elsewhere. The hint renders from the same check, so it never tells
 * a Windows reader to press a key their keyboard does not have.
 */
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
          {/* The key hint is a VISUAL affordance only. Left exposed, the button's visible text reads
              "Search ⌘K" while its accessible name is "Search the archive" — the visible label is
              then not contained in the accessible name, which is a WCAG 2.5.3 failure (Lighthouse's
              `label-content-name-mismatch`) and, worse, leaves a voice-control user saying a phrase
              the button does not answer to. Hidden, the visible label is "Search", which the
              accessible name does contain; `aria-keyshortcuts` above already tells assistive tech
              about the shortcut, in the form it is meant to be announced. */}
          <kbd aria-hidden="true" className="search-trigger-kbd">
            {isApple ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      ) : undefined}

      {/* THE ONE MOUNT POINT, and it sits HERE — inside the colophon bar — rather than beside the
          provider. The Command dialog server-renders its own sr-only header, so its DOM position is
          part of the SSR tree; mounting it anywhere else moves that markup and React's hydration
          walk finds the shell's next element where the dialog's used to be. The state is the
          provider's, so the front door's field opens this same dialog; only the rendering stays
          put. */}
      <SearchDialog onOpenChange={setOpen} open={state} seed={seed} />
    </>
  );
}

/**
 * Whether the reader is on an Apple keyboard, resolved after mount. Shared by both ways in so the
 * colophon glyph and the front door's field never disagree about which key to name.
 */
export function useIsApple(): boolean {
  const [isApple, setIsApple] = useState(false);

  useEffect(() => {
    setIsApple(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent));
  }, []);

  return isApple;
}

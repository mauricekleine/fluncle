// FLUNCLE'S SEARCH — the surface.
//
// A trigger in the top bar, ⌘K / Ctrl+K from anywhere, and one Shadcn `Command` dialog. The
// text input lives INSIDE the dialog; the bar is only a way in.
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
// It is never labelled, never introduced, and never given a noun of its own: no badge on those
// rows, and no heading that names the TIER. "Finding" stays the only named object in Fluncle's
// world. The rows DO sit under a "Tracks" heading, which names the superset rather than either
// tier — the ratified test is in DESIGN.md's Unlit Rule, the reasoning in docs/search.md.
// The focus ring stays Eclipse Gold on every row either way — focus is an accessibility
// affordance, not a claim about the music.

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@fluncle/ui/components/command";
import {
  ArrowRightIcon,
  MagnifyingGlassIcon,
  SparkleIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { SpotifyIcon } from "@/components/platform-icons";
import { cn } from "@/lib/utils";

// ── The wire ─────────────────────────────────────────────────────────────────────────

type SearchHit = {
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  certified: boolean;
  galaxy?: string;
  key?: string;
  label?: string;
  logId?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

type EntityKind = "album" | "artist" | "label";

type SearchEntity = { imageUrl?: string; kind: EntityKind; name: string; slug: string };

/**
 * The three graph nodes that HAVE a page, in the order they render — and the order a reader
 * means, because a name is most often a person. Each gets the identical row: the picture, the
 * name, the arrow. An artist is the precedent and a label and an album are not a lesser
 * citizen of it; the only thing `kind` decides is which page the arrow goes to.
 *
 * Every group in the list — these three and the tracks below — is a `CommandGroup`, and that is
 * a LAYOUT invariant as much as a semantic one: the group carries `p-1`, so a row rendered
 * loose in the `CommandList` sits 4px to the left of a row inside a group. One rail for the
 * whole list means one container for every row in it.
 */
const ENTITY_GROUPS = [
  { heading: "Artists", kind: "artist" },
  { heading: "Labels", kind: "label" },
  { heading: "Albums", kind: "album" },
] as const satisfies readonly { heading: string; kind: EntityKind }[];

type SearchFilters = {
  album?: string;
  artist?: string;
  bpmMax?: number;
  bpmMin?: number;
  key?: string;
  label?: string;
  soundsLike?: string;
  text?: string;
  yearMax?: number;
  yearMin?: number;
};

type SearchResponse = {
  anchor?: SearchHit;
  degraded: boolean;
  entities: SearchEntity[];
  filters?: SearchFilters;
  kind: "coordinate" | "empty" | "entity" | "filters" | "sonic" | "token";
  redirect?: string;
  results: SearchHit[];
};

const EMPTY: SearchResponse = { degraded: false, entities: [], kind: "empty", results: [] };

/** The floor the server also enforces — below it there is nothing to go on yet. */
const MIN_QUERY_LENGTH = 2;

/**
 * The four example queries, and they are a lesson disguised as a shortcut: one bare artist
 * name, one label, one natural-language filter, and one sonic. Between them they teach every
 * tier of the resolver without ever explaining that there are tiers.
 *
 * They are REAL — each one returns rows against the live archive. An example query that finds
 * nothing teaches the opposite of what it was for.
 */
const EXAMPLES = [
  { icon: "token", query: "netsky" },
  { icon: "token", query: "Hospital Records" },
  { icon: "filters", query: "tracks in A minor above 170 bpm" },
  { icon: "sonic", query: "tracks that sound like Nine Clouds" },
] as const;

async function fetchSearch(q: string): Promise<SearchResponse> {
  const response = await fetch(`/api/v1/search/archive?q=${encodeURIComponent(q)}`);

  if (!response.ok) {
    return EMPTY;
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
      {entity.imageUrl ? (
        <img alt="" className="search-cover" loading="lazy" src={entity.imageUrl} />
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

/**
 * What the model understood, echoed back. Not decoration: it is the only way a reader can see
 * that "in A minor" became a key filter and correct it when it did not. A search that quietly
 * reinterprets you is a search you cannot trust.
 */
function FilterChips({ filters }: { filters: SearchFilters }): ReactNode {
  const chips = [
    filters.artist && `artist: ${filters.artist}`,
    filters.label && `label: ${filters.label}`,
    filters.album && `album: ${filters.album}`,
    filters.key && `key: ${filters.key}`,
    filters.bpmMin !== undefined && `bpm ≥ ${filters.bpmMin}`,
    filters.bpmMax !== undefined && `bpm ≤ ${filters.bpmMax}`,
    filters.yearMin !== undefined && `from ${filters.yearMin}`,
    filters.yearMax !== undefined && `to ${filters.yearMax}`,
    filters.text && `“${filters.text}”`,
  ].filter((chip): chip is string => Boolean(chip));

  if (chips.length === 0) {
    return undefined;
  }

  return (
    <div className="search-chips">
      {chips.map((chip) => (
        <span className="search-chip" key={chip}>
          {chip}
        </span>
      ))}
    </div>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────────────

function SearchDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}): ReactNode {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // A keystroke is not a query. The debounce is what keeps a typed word from firing five
  // round trips (and, on the fourth tier, five model calls) on its way to being one.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);

    return () => clearTimeout(timer);
  }, [query]);

  const enabled = debounced.length >= MIN_QUERY_LENGTH;
  const { data = EMPTY, isFetching } = useQuery({
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

  /** An entity goes to its page. `kind` is the only thing that picks the route. */
  const pickEntity = useCallback(
    (entity: SearchEntity) => goTo(`/${entity.kind}/${entity.slug}`),
    [goTo],
  );

  /** A finding goes to its coordinate. A track with no coordinate goes OUT, to Spotify. */
  const pick = useCallback(
    (hit: SearchHit) => {
      if (hit.certified && hit.logId) {
        goTo(`/log/${hit.logId}`);

        return;
      }

      if (hit.spotifyUrl) {
        close();
        window.open(hit.spotifyUrl, "_blank", "noopener,noreferrer");
      }
    },
    [close, goTo],
  );

  const showExamples = query.trim().length === 0;
  const nothing = enabled && !isFetching && data.results.length === 0 && data.entities.length === 0;

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
            {EXAMPLES.map((example) => (
              <button
                className="search-example"
                key={example.query}
                onClick={() => setQuery(example.query)}
                type="button"
              >
                {example.icon === "sonic" ? (
                  <WaveformIcon aria-hidden="true" className="search-example-icon" />
                ) : example.icon === "filters" ? (
                  <SparkleIcon aria-hidden="true" className="search-example-icon" />
                ) : (
                  <MagnifyingGlassIcon aria-hidden="true" className="search-example-icon" />
                )}
                {example.query}
              </button>
            ))}
          </div>
        ) : undefined}

        {data.anchor ? (
          <p className="search-note">
            <WaveformIcon aria-hidden="true" className="search-note-icon" />
            Near <strong>{data.anchor.title}</strong>
            {data.anchor.artists.length > 0 ? ` — ${data.anchor.artists.join(", ")}` : ""}
          </p>
        ) : undefined}

        {/* The honesty line. The model was wanted and could not run, so these are text hits,
            not the filters you asked for — and search says so rather than passing one off as
            the other. */}
        {data.degraded ? (
          <p className="search-note search-note--degraded">
            Reading by name only right now — showing the closest words.
          </p>
        ) : undefined}

        {data.filters ? <FilterChips filters={data.filters} /> : undefined}

        {/* There is no synthetic "Go to /artist/netsky" row anywhere in here, deliberately. A
            resolved coordinate comes back as the FINDING (cover, title, coordinate) and a
            resolved artist, label, or album as the ENTITY — the thing, never a rendering of the
            URL you are about to visit. Each is first in the list, so Enter lands exactly where
            the redirect would have taken you. */}
        <CommandList>
          {nothing ? <CommandEmpty>{emptyCopy}</CommandEmpty> : undefined}

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

          {/* "Tracks" names the SUPERSET — true of every row under it, certified or not, and
              singling out neither. See the file header and DESIGN.md's Unlit Rule. */}
          {data.results.length > 0 ? (
            <CommandGroup heading="Tracks">
              {data.results.map((hit) => (
                <TrackRow hit={hit} key={hit.trackId} onPick={pick} />
              ))}
            </CommandGroup>
          ) : undefined}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// ── The trigger ──────────────────────────────────────────────────────────────────────

/**
 * The one control in the top bar, and the ⌘K listener behind it. Mounted once inside
 * `PublicChrome`, so the shortcut works from every public page — the trigger is a way in, not
 * the only way in.
 *
 * `⌘K` on Apple, `Ctrl+K` elsewhere. The hint renders from the same check, so it never tells
 * a Windows reader to press a key their keyboard does not have.
 */
export function SearchTrigger(): ReactNode {
  const [open, setOpen] = useState(false);
  const [isApple, setIsApple] = useState(false);

  useEffect(() => {
    setIsApple(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent));
  }, []);

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

  return (
    <>
      <button
        aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}
        aria-label="Search the archive"
        className="search-trigger"
        onClick={() => setOpen(true)}
        type="button"
      >
        <MagnifyingGlassIcon aria-hidden="true" className="search-trigger-icon" />
        <span className="search-trigger-label">Search</span>
        <kbd className="search-trigger-kbd">{isApple ? "⌘K" : "Ctrl K"}</kbd>
      </button>

      <SearchDialog onOpenChange={setOpen} open={open} />
    </>
  );
}

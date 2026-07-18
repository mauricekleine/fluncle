// THE PLAYLIST PANEL — the artifact itself, crowned by its header (the 2×2 collage cut
// from the picks' covers, Spotify's own auto-cover grammar; the name; the one meta fact
// the interface can't carry — the weekly freshening; the gold Get-playlist CTA — the
// page's One Sun). Under it, the tracklist being assembled: the search to add, the
// candidates the search returns, then the numbered picks with their remove controls, and
// a dashed ghost slot where the next pick lands. The interface carries the meaning; no
// helper prose.
//
// The CTA is coded against the PARALLEL agent's exact interface and folds a 404 gracefully
// (GET/POST /me/frontier-playlist), so the panel ships whether or not that endpoint has
// merged: closed reads as one short line under a disabled button and nothing more.

import {
  ArrowClockwiseIcon,
  MagnifyingGlassIcon,
  PlaylistIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { SpotifyIcon } from "@/components/platform-icons";
import { formatDateLong } from "@/lib/format";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";
import { AddPill, padIndex, RecCover, TrackReadout } from "./rec-rows";
import {
  foldFrontierMint,
  foldFrontierStatus,
  FRONTIER_CLOSED,
  type FrontierState,
  type RecSeedItem,
  SEED_CAP,
} from "./shared";

// The slice of the search resolver's reply the panel consumes — a track candidate. The
// endpoint returns more (entities, filters, the sonic anchor); a pick is a TRACK, so the
// panel reads `results` only and ignores the rest.
type SearchHit = {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  certified: boolean;
  key?: string;
  logId?: string;
  releaseDate?: string;
  title: string;
  trackId: string;
};

type SearchResponse = { results?: SearchHit[] };

/**
 * Three real example queries, a lesson disguised as a shortcut (the ⌘K precedent): a bare
 * artist, a label, and a sonic "sounds like". Each returns rows against the live archive, so
 * clicking one always fills the panel with something pickable.
 */
const EXAMPLE_QUERIES = ["netsky", "hospital records", "tracks that sound like Nine Clouds"];

const MIN_QUERY_LENGTH = 2;

const FRONTIER_PATH = "/api/me/frontier-playlist";

async function readFrontier(): Promise<FrontierState> {
  const response = await fetch(FRONTIER_PATH);
  const body = await response.json().catch(() => undefined);

  return foldFrontierStatus({ body, ok: response.ok, status: response.status });
}

async function fetchCandidates(query: string): Promise<SearchHit[]> {
  const response = await fetch(`/api/v1/search/archive?q=${encodeURIComponent(query)}`);

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as SearchResponse;

  return body.results ?? [];
}

export function PlaylistPanel({
  csrfToken,
  message,
  onAdd,
  onRemove,
  seeds,
}: {
  csrfToken: string;
  message: string;
  onAdd: (trackId: string) => Promise<void>;
  onRemove: (trackId: string) => Promise<void>;
  seeds: RecSeedItem[];
}) {
  const queryClient = useQueryClient();
  const [mintMessage, setMintMessage] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const { notation } = useKeyNotation();

  const pickedIds = useMemo(() => new Set(seeds.map((seed) => seed.trackId)), [seeds]);
  const hasPicks = seeds.length > 0;
  const atCap = seeds.length >= SEED_CAP;
  const queryActive = debounced.length >= MIN_QUERY_LENGTH;

  // A secondary, on-demand panel the loader does not carry, so it rides its own UNSEEDED
  // query (the account convention allows this for data the loader never returned). Never
  // refetches on focus — the playlist doesn't change under the reader's feet mid-session.
  const statusQuery = useQuery({
    queryFn: readFrontier,
    queryKey: ["frontier"],
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const frontier = statusQuery.data ?? FRONTIER_CLOSED;

  const mint = useMutation({
    mutationFn: async () => {
      const response = await fetch(FRONTIER_PATH, {
        // The mint takes no parameters, but the op's input schema still expects an
        // OBJECT — a bodyless POST parses to undefined and 400s (invalid_request).
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });

      if (response.status === 401) {
        window.location.href = "/account";

        return { kind: "closed" as const };
      }

      const body = await response.json().catch(() => undefined);

      return foldFrontierMint({ body, ok: response.ok, status: response.status });
    },
    onSuccess: (result) => {
      if (result.kind === "closed") {
        setMintMessage("");
        queryClient.setQueryData<FrontierState>(["frontier"], FRONTIER_CLOSED);

        return;
      }

      if (result.kind === "error") {
        setMintMessage(result.message);

        return;
      }

      setMintMessage(MINT_MESSAGE[result.status]);
      void queryClient.invalidateQueries({ queryKey: ["frontier"] });
    },
  });

  // A keystroke is not a query — the same 180ms debounce the ⌘K dialog uses, so a typed word
  // fires one resolver round trip on its way to being one, not five.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (debounced.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearching(false);

      return;
    }

    let live = true;

    setSearching(true);
    void fetchCandidates(debounced).then((hits) => {
      if (live) {
        setResults(hits);
        setSearching(false);
      }
    });

    return () => {
      live = false;
    };
  }, [debounced]);

  async function mutate(trackId: string, run: (trackId: string) => Promise<void>) {
    setPending((current) => new Set(current).add(trackId));

    try {
      await run(trackId);
    } finally {
      setPending((current) => {
        const next = new Set(current);

        next.delete(trackId);

        return next;
      });
    }
  }

  // The one meta fact the interface can't carry: the weekly freshening (or when it last
  // landed, once minted). Everything else the header needs, the rows already say.
  const meta =
    frontier.playlistUrl && frontier.lastSyncedAt
      ? `Refreshed ${formatDateLong(frontier.lastSyncedAt)}`
      : "Refreshed every week";

  return (
    <section className="rec-playlist">
      <header className="rec-playlist-head">
        <PlaylistCollage covers={seeds.map((seed) => seed.imageUrl).slice(0, 4)} />
        <div className="rec-playlist-id">
          <h2 className="rec-playlist-name">Fluncle&rsquo;s Frontier</h2>
          <p className="rec-playlist-meta">{meta}</p>

          <div className="rec-playlist-cta">
            {frontier.playlistUrl ? (
              <>
                <Button
                  nativeButton={false}
                  render={
                    <a href={frontier.playlistUrl} rel="noopener noreferrer" target="_blank" />
                  }
                >
                  <SpotifyIcon />
                  Open in Spotify
                </Button>
                {frontier.mintingOpen ? (
                  <Button
                    disabled={mint.isPending}
                    onClick={() => mint.mutate()}
                    type="button"
                    variant="outline"
                  >
                    <ArrowClockwiseIcon aria-hidden="true" weight="bold" />
                    Refresh playlist
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                disabled={!hasPicks || !frontier.mintingOpen || mint.isPending}
                onClick={() => mint.mutate()}
                type="button"
              >
                <PlaylistIcon aria-hidden="true" weight="bold" />
                Get playlist
              </Button>
            )}
          </div>

          {/* The only note the header is allowed: WHY the action lies still — and only
              while it does. */}
          {!frontier.mintingOpen && !frontier.playlistUrl ? (
            <p className="rec-playlist-note">Playlists open soon.</p>
          ) : null}

          {mintMessage ? (
            <p aria-live="polite" className="rec-message">
              {mintMessage}
            </p>
          ) : null}
        </div>
      </header>

      <div className="rec-playlist-tracks">
        <div className="rec-search">
          <MagnifyingGlassIcon aria-hidden="true" className="rec-search-icon" />
          <Input
            aria-label="Search for a track to add to your picks"
            className="rec-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for a track to add"
            ref={searchRef}
            type="search"
            value={query}
          />
        </div>

        {message ? (
          <p aria-live="polite" className="rec-message">
            {message}
          </p>
        ) : null}

        {/* Candidates — the search's reply, inline under the field. The row carries the
            music, the pill carries the pick (the one gesture grammar). */}
        {queryActive ? (
          results.length > 0 ? (
            <ul className="rec-candidates">
              {results.map((hit) => {
                const picked = pickedIds.has(hit.trackId);

                return (
                  <CandidateRow
                    atCap={atCap}
                    busy={pending.has(hit.trackId)}
                    hit={hit}
                    key={hit.trackId}
                    notation={notation}
                    onPick={() => void mutate(hit.trackId, picked ? onRemove : onAdd)}
                    picked={picked}
                  />
                );
              })}
            </ul>
          ) : searching ? (
            <p className="rec-muted">Digging…</p>
          ) : (
            <p aria-live="polite" className="rec-muted">
              Nothing out here by that. Try another name.
            </p>
          )
        ) : null}

        {/* The playlist's tracklist — numbered like the positions it fills. */}
        {hasPicks ? (
          <>
            <div className="rec-picks-head">
              <h3>Your picks</h3>
              <span className="rec-picks-count">
                {seeds.length}/{SEED_CAP}
              </span>
            </div>
            <ol className="rec-pick-list">
              {seeds.map((seed, index) => (
                <PickRow
                  busy={pending.has(seed.trackId)}
                  index={index}
                  key={seed.trackId}
                  onRemove={() => void mutate(seed.trackId, onRemove)}
                  seed={seed}
                />
              ))}
              {!atCap ? (
                <li>
                  <button
                    className="rec-pick-ghost"
                    onClick={() => searchRef.current?.focus()}
                    type="button"
                  >
                    <span aria-hidden className="rec-pick-index">
                      {padIndex(seeds.length)}
                    </span>
                    <span aria-hidden className="rec-pick-ghost-cover">
                      <PlusIcon weight="bold" />
                    </span>
                    <span className="rec-pick-ghost-label">Add another pick</span>
                  </button>
                </li>
              ) : null}
            </ol>
          </>
        ) : !queryActive ? (
          <div className="rec-examples">
            <p className="rec-muted">Try one of these to start.</p>
            <div className="rec-example-row">
              {EXAMPLE_QUERIES.map((example) => (
                <button
                  className="rec-example"
                  key={example}
                  onClick={() => setQuery(example)}
                  type="button"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {atCap ? <p className="rec-muted">The crate is full. Remove one to add another.</p> : null}
      </div>
    </section>
  );
}

const MINT_MESSAGE: Record<"minted" | "refreshed" | "unchanged", string> = {
  minted: "Done. It's on your Spotify.",
  refreshed: "Refreshed with your latest picks.",
  unchanged: "Already up to date.",
};

/**
 * The playlist's cover — Spotify's 2×2 auto-collage, cut from the first four picks. A
 * quadrant with no cover yet falls back to the eclipse gradient over Dust Veil (the
 * artwork-fallback grammar); at zero picks the whole frame is the fallback, the artifact
 * not yet revealed.
 */
function PlaylistCollage({ covers }: { covers: (string | undefined)[] }) {
  return (
    <span aria-hidden className="rec-collage">
      {[0, 1, 2, 3].map((cell) => {
        const cover = albumCoverAtSize(covers[cell], "medium");

        return cover ? (
          <img alt="" height={150} key={cell} loading="lazy" src={cover} width={150} />
        ) : (
          <span className="rec-collage-cell" key={cell} />
        );
      })}
    </span>
  );
}

/**
 * One pick in the tracklist — the playlist's own row: the position numeral, the cover, the
 * fused Artist — Title, and the remove control. The row itself is inert (reordering would
 * be a fake affordance — the engine is order-blind); the X is the only control.
 */
function PickRow({
  busy,
  index,
  onRemove,
  seed,
}: {
  busy: boolean;
  index: number;
  onRemove: () => void;
  seed: RecSeedItem;
}) {
  const trackLine = `${seed.artists.join(", ")} — ${seed.title}`;

  return (
    <li className="rec-pick-row">
      <span aria-hidden className="rec-pick-index">
        {padIndex(index)}
      </span>
      <RecCover url={seed.imageUrl} />
      <span className="rec-pick-title">{trackLine}</span>
      <button
        aria-label={`Remove ${trackLine} from your picks`}
        className="rec-pick-remove"
        disabled={busy}
        onClick={onRemove}
        type="button"
      >
        <XIcon aria-hidden="true" weight="bold" />
      </button>
    </li>
  );
}

/**
 * One candidate. Cover-led, the register carried by the mark beside the pill exactly as the
 * ⌘K rows do it (a finding shows its Log ID, an uncertified track a Spotify mark). The row
 * itself is inert; the Add pill is the gesture. A row already picked reads "Added"; at the
 * cap an un-picked pill disables. An uncertified candidate hovers cold (the Dust Veil, the
 * Unlit Rule), a finding catches gold.
 */
function CandidateRow({
  atCap,
  busy,
  hit,
  notation,
  onPick,
  picked,
}: {
  atCap: boolean;
  busy: boolean;
  hit: SearchHit;
  notation: KeyNotation;
  onPick: () => void;
  picked: boolean;
}) {
  const trackLine = `${hit.artists.join(", ")} — ${hit.title}`;
  const year = hit.releaseDate ? hit.releaseDate.slice(0, 4) : undefined;
  const artistLine = year ? `${hit.artists.join(", ")} · ${year}` : hit.artists.join(", ");

  return (
    <li className={cn("rec-candidate", !hit.certified && "rec-candidate--unlit")}>
      <RecCover url={hit.albumImageUrl} />
      <span className="rec-candidate-body">
        <span className="rec-candidate-title">{hit.title}</span>
        <span className="rec-candidate-artists">{artistLine}</span>
        <TrackReadout bpm={hit.bpm} musicalKey={hit.key} notation={notation} />
      </span>
      <span className="rec-candidate-tail">
        {hit.certified && hit.logId ? (
          <span aria-hidden className="rec-candidate-logid">
            {hit.logId}
          </span>
        ) : (
          <SpotifyIcon className="rec-candidate-out" />
        )}
        <AddPill
          busy={busy}
          disabled={atCap}
          label={picked ? `Remove ${trackLine} from your picks` : `Add ${trackLine} to your picks`}
          onPick={onPick}
          picked={picked}
        />
      </span>
    </li>
  );
}

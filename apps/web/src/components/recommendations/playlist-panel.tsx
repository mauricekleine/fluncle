// THE PLAYLIST PANEL — the artifact itself, crowned by its header (the 2×2 collage cut
// from the picks' covers, Spotify's own auto-cover grammar; the name; the one meta fact
// the interface can't carry — the weekly freshening; the gold Get-playlist CTA — the
// page's One Sun). Under it, the tracklist being assembled: the search to add, the
// candidates the search returns, then the numbered picks with their remove controls, and
// a dashed ghost slot where the next pick lands. The interface carries the meaning; no
// helper prose.
//
// The header CTA is phase-driven (`resolvePlaylistCta`): the DRAFT phase shows the one-time
// "Get playlist" commitment (the mint gesture, lifted into `useFrontierMint` and handed down),
// the COMMITTED phase opens the synced Spotify playlist or — while the Spotify half is still
// dark — shows the honest waiting line. There is no refresh control: the engine's only user
// trigger is that first commit (the other is the Friday sweep).

import { MagnifyingGlassIcon, PlaylistIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
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
  foldFrontierStatus,
  FRONTIER_CLOSED,
  type FrontierState,
  type RecSeedItem,
  resolvePlaylistCta,
  SEED_CAP,
} from "./shared";
import { type FrontierMint } from "./use-frontier-mint";

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
  message,
  mint,
  onAdd,
  onRemove,
  phase,
  seeds,
}: {
  message: string;
  mint: FrontierMint;
  onAdd: (trackId: string) => Promise<void>;
  onRemove: (trackId: string) => Promise<void>;
  phase: "committed" | "draft";
  seeds: RecSeedItem[];
}) {
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

  // The one CTA the header shows, by phase (the shelf-from-editions triggers): DRAFT offers
  // the one-time "Get playlist" commitment; COMMITTED opens the synced playlist, or — for an
  // edition-only user whose Spotify half is still dark — shows nothing but the honest waiting
  // line. There is no refresh control: the engine's only user trigger is that first commit.
  const cta = resolvePlaylistCta({ phase, playlistUrl: frontier.playlistUrl });

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

  // The one meta fact the interface can't carry: the weekly freshening. One quiet line above
  // the CTA — the last refresh once the playlist exists ("Refreshed Jul 17, 2026"), the standing
  // weekly promise before it. The refresh now drains paced across the day rather than on a fixed
  // wall-clock slot, so the line stays honestly "every week" and never names a specific time.
  const meta = !frontier.playlistUrl
    ? "Refreshed every week"
    : frontier.lastSyncedAt
      ? `Refreshed ${formatDateLong(frontier.lastSyncedAt)}`
      : "";

  return (
    <section className="rec-playlist">
      <header className="rec-playlist-head">
        <PlaylistCollage covers={seeds.map((seed) => seed.imageUrl).slice(0, 4)} />
        <div className="rec-playlist-id">
          <h2 className="rec-playlist-name">Fluncle&rsquo;s Frontier</h2>
          {meta ? <p className="rec-playlist-meta">{meta}</p> : null}

          {cta.kind === "waiting" ? (
            // Committed, but the Spotify half is still dark — the set is saved, the playlist
            // follows when the mirror opens. The honest resting line, no control.
            <p className="rec-playlist-note">Your Spotify playlist follows soon.</p>
          ) : (
            <div className="rec-playlist-cta">
              {cta.kind === "open" ? (
                <Button
                  nativeButton={false}
                  render={<a href={cta.url} rel="noopener noreferrer" target="_blank" />}
                >
                  <SpotifyIcon />
                  Open in Spotify
                </Button>
              ) : (
                <Button disabled={!hasPicks || mint.isPending} onClick={mint.run} type="button">
                  <PlaylistIcon aria-hidden="true" weight="bold" />
                  Get playlist
                </Button>
              )}
            </div>
          )}

          {/* The live region is mounted UNCONDITIONALLY and only its text toggles — a "Get
              playlist" click updates the text in a region already on the page, so a screen
              reader announces the outcome (a region inserted together with its content is
              skipped). */}
          <p aria-live="polite" className="rec-message">
            {mint.message || null}
          </p>
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

        {/* Same unconditional-mount rule as the mint toast: the seed-write message (a cap 409,
            say) toggles inside a region already on the page, so a screen reader announces it. */}
        <p aria-live="polite" className="rec-message">
          {message || null}
        </p>

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

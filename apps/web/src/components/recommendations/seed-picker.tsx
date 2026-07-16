// THE SEED PICKER — "Point Fluncle at the tracks you love." A search over the archive
// (the SAME public resolver ⌘K uses — GET /api/v1/search/archive, reused as the DATA path,
// never its dialog UI), rendering candidate rows cover-led. Clicking a row adds a seed; the
// current seeds render as removable cover chips. With zero seeds the picker IS the page (the
// conversion moment), so its empty state teaches the search with three real example queries.
//
// The rows are click-to-ADD, one gesture, no per-row preview control — the picker's job is
// choosing, not auditioning (previews live on the findings slots below, the saves grammar).

import { CheckIcon, MagnifyingGlassIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Input } from "@fluncle/ui/components/input";
import { SpotifyIcon } from "@/components/platform-icons";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";
import { type RecSeedItem } from "./shared";

// The slice of the search resolver's reply the picker consumes — a track candidate. The
// endpoint returns more (entities, filters, the sonic anchor); a seed is a TRACK, so the
// picker reads `results` only and ignores the rest.
type SearchHit = {
  albumImageUrl?: string;
  artists: string[];
  certified: boolean;
  logId?: string;
  title: string;
  trackId: string;
};

type SearchResponse = { results?: SearchHit[] };

/**
 * Three real example queries, a lesson disguised as a shortcut (the ⌘K precedent): a bare
 * artist, a label, and a sonic "sounds like". Each returns rows against the live archive, so
 * clicking one always fills the picker with something seedable. Reused verbatim from the
 * search dialog's own examples so they stay true.
 */
const EXAMPLE_QUERIES = ["netsky", "hospital records", "tracks that sound like Nine Clouds"];

const MIN_QUERY_LENGTH = 2;

async function fetchCandidates(query: string): Promise<SearchHit[]> {
  const response = await fetch(`/api/v1/search/archive?q=${encodeURIComponent(query)}`);

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as SearchResponse;

  return body.results ?? [];
}

export function SeedPicker({
  message,
  onAdd,
  onRemove,
  seeds,
}: {
  message: string;
  onAdd: (trackId: string) => Promise<void>;
  onRemove: (trackId: string) => Promise<void>;
  seeds: RecSeedItem[];
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  const seededIds = useMemo(() => new Set(seeds.map((seed) => seed.trackId)), [seeds]);
  const hasSeeds = seeds.length > 0;

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

  return (
    <section className="account-section rec-picker">
      <div className="rec-picker-head">
        <h2>Point Fluncle at the tracks you love</h2>
        <p className="account-muted">
          Pick around ten. He digs the far side of the archive for more that sit close to them.
        </p>
      </div>

      <div className="rec-search">
        <MagnifyingGlassIcon aria-hidden="true" className="rec-search-icon" />
        <Input
          aria-label="Search the archive by name, label, or the sound of it"
          className="rec-search-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A name, a label, or the sound of it"
          type="search"
          value={query}
        />
      </div>

      {/* Current seeds — removable cover chips. They lead so the reader always sees what they
          have pointed him at, and the count against the cap. */}
      {hasSeeds ? (
        <div className="rec-seeds">
          <p className="rec-seeds-count">{seeds.length} of 12 picked</p>
          <ul className="rec-chip-list">
            {seeds.map((seed) => (
              <SeedChip
                busy={pending.has(seed.trackId)}
                key={seed.trackId}
                onRemove={() => void mutate(seed.trackId, onRemove)}
                seed={seed}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className="rec-examples">
          <p className="account-muted">Try one of these to start.</p>
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
      )}

      {message ? (
        <p aria-live="polite" className="rec-message">
          {message}
        </p>
      ) : null}

      {/* Candidates. A bare list of click-to-add rows; the empty and no-match lines stay quiet
          and never blame the reader's spelling. */}
      {debounced.length >= MIN_QUERY_LENGTH ? (
        results.length > 0 ? (
          <ul className="account-list rec-candidate-list">
            {results.map((hit) => (
              <CandidateRow
                busy={pending.has(hit.trackId)}
                hit={hit}
                key={hit.trackId}
                onAdd={() => void mutate(hit.trackId, onAdd)}
                seeded={seededIds.has(hit.trackId)}
              />
            ))}
          </ul>
        ) : searching ? (
          <p className="account-muted">Digging…</p>
        ) : (
          <p aria-live="polite" className="account-muted">
            Nothing out here by that. Try another name.
          </p>
        )
      ) : null}
    </section>
  );
}

/**
 * One candidate. Cover-led, the register carried by the trailing mark exactly as the ⌘K rows
 * do it (a finding shows its Log ID, an uncertified track a Spotify mark) — but here the whole
 * row is an ADD button, not a link out, because the picker's gesture is choosing. A row already
 * seeded reads as picked and cannot be re-added.
 */
function CandidateRow({
  busy,
  hit,
  onAdd,
  seeded,
}: {
  busy: boolean;
  hit: SearchHit;
  onAdd: () => void;
  seeded: boolean;
}) {
  const trackLine = `${hit.artists.join(", ")} — ${hit.title}`;
  const cover = albumCoverAtSize(hit.albumImageUrl, "small");

  return (
    <li>
      <button
        aria-label={seeded ? `${trackLine} is already a seed` : `Add ${trackLine} to your seeds`}
        className={cn("rec-candidate", seeded && "rec-candidate--seeded")}
        disabled={seeded || busy}
        onClick={onAdd}
        type="button"
      >
        {cover ? (
          <img alt="" className="rec-cover" height={40} loading="lazy" src={cover} width={40} />
        ) : (
          <span aria-hidden className="rec-cover rec-cover--empty" />
        )}
        <span className="rec-candidate-body">
          <span className="rec-candidate-title">{hit.title}</span>
          <span className="rec-candidate-artists">{hit.artists.join(", ")}</span>
        </span>
        <span aria-hidden className="rec-candidate-tail">
          {seeded ? (
            <CheckIcon className="rec-seeded-check" weight="bold" />
          ) : hit.certified && hit.logId ? (
            <span className="rec-candidate-logid">{hit.logId}</span>
          ) : (
            <SpotifyIcon className="rec-candidate-out" />
          )}
          {!seeded ? <PlusIcon className="rec-add-glyph" weight="bold" /> : null}
        </span>
      </button>
    </li>
  );
}

/** A picked seed, as a removable cover chip. The X removes it (a plain act — it destroys nothing). */
function SeedChip({
  busy,
  onRemove,
  seed,
}: {
  busy: boolean;
  onRemove: () => void;
  seed: RecSeedItem;
}) {
  const trackLine = `${seed.artists.join(", ")} — ${seed.title}`;
  const cover = albumCoverAtSize(seed.imageUrl, "small");

  return (
    <li className="rec-chip">
      {cover ? (
        <img alt="" className="rec-chip-cover" height={28} loading="lazy" src={cover} width={28} />
      ) : (
        <span aria-hidden className="rec-chip-cover rec-chip-cover--empty" />
      )}
      <span className="rec-chip-title">{trackLine}</span>
      <button
        aria-label={`Remove ${trackLine} from your seeds`}
        className="rec-chip-remove"
        disabled={busy}
        onClick={onRemove}
        type="button"
      >
        <XIcon aria-hidden="true" weight="bold" />
      </button>
    </li>
  );
}

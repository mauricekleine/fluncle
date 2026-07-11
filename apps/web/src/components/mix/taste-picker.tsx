import { CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type MixArtist } from "@fluncle/contracts";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { MAX_TASTE_ARTISTS } from "@/lib/mix-set";
import { cn } from "@/lib/utils";

// The taste seed — a stranger's first move on `/mix`, and the reason the tool works at all
// for someone who has never heard of Fluncle. They cannot name a track in an archive they
// have never seen, but they can always name artists they like; those artists' tracks carry
// vectors, so a handful of names is a handful of vectors, and that is a taste.
//
// A GRID OF NAMES TO TAP, not a search box to type into. Recognition beats recall: a search
// box asks the reader to guess what is in here, and every guess that misses reads as "this
// place doesn't have my music". The grid shows them the archive's best-represented artists
// and lets them point. The search is there for the one they wanted and did not see.
//
// The seed lives in the URL (`?taste=`), so this component holds no state that outlives a
// click — see `mix-set.ts`.

async function fetchMixArtists(q: string): Promise<MixArtist[]> {
  const params = new URLSearchParams({ limit: "48" });

  if (q.trim()) {
    params.set("q", q.trim());
  }

  const response = await fetch(`/api/v1/mix/artists?${params.toString()}`);

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { artists?: MixArtist[] };

  return body.artists ?? [];
}

/** One artist as a toggle. Selected = the Gold Veil; a real `aria-pressed` button. */
function ArtistToggle({
  artist,
  onToggle,
  selected,
}: {
  artist: MixArtist;
  onToggle: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn("taste-artist", selected && "taste-artist--on")}
      onClick={onToggle}
      type="button"
    >
      {artist.imageUrl ? (
        <img alt="" className="taste-artist-face" loading="lazy" src={artist.imageUrl} />
      ) : (
        <span aria-hidden="true" className="taste-artist-face taste-artist-face--empty" />
      )}
      <span className="taste-artist-name">{artist.name}</span>
      {selected ? (
        <CheckIcon aria-hidden="true" className="taste-artist-check" weight="bold" />
      ) : null}
    </button>
  );
}

export function TastePicker({
  onSeed,
  onSkip,
  seeded,
}: {
  /** Commit the seed (artist slugs) — the page writes it to `?taste=`. */
  onSeed: (slugs: string[]) => void;
  /** "Or search for a track yourself" — skip seeding entirely. */
  onSkip: () => void;
  /** The slugs already seeded, so re-opening the picker shows the current seed selected. */
  seeded: string[];
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<MixArtist[]>([]);
  const [initialised, setInitialised] = useState(false);

  const { data: artists = [] } = useQuery({
    queryFn: () => fetchMixArtists(q),
    queryKey: ["mix-artists", q],
    staleTime: 60_000,
  });

  // Re-opening the picker with a live seed pre-selects it. The seed is slugs (that is all the
  // URL carries), so the names are recovered from the first artist page that loads.
  if (!initialised && seeded.length > 0 && artists.length > 0) {
    const seededSet = new Set(seeded);
    const known = artists.filter((artist) => seededSet.has(artist.slug));

    if (known.length > 0) {
      setPicked(known);
      setInitialised(true);
    }
  }

  const pickedSlugs = new Set(picked.map((artist) => artist.slug));
  const atCap = picked.length >= MAX_TASTE_ARTISTS;

  const toggle = (artist: MixArtist) => {
    setInitialised(true);

    if (pickedSlugs.has(artist.slug)) {
      setPicked(picked.filter((existing) => existing.slug !== artist.slug));
    } else if (!atCap) {
      setPicked([...picked, artist]);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="mb-1 text-sm font-bold">Pick a few artists you like</h2>
        <p className="text-sm text-muted-foreground">
          Five or ten is plenty. I take it from there.
        </p>
      </div>

      <div className="relative">
        <MagnifyingGlassIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search artists"
          className="pl-9"
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search artists"
          type="search"
          value={q}
        />
      </div>

      {artists.length > 0 ? (
        <ul className="taste-grid">
          {artists.map((artist) => (
            <li key={artist.slug}>
              <ArtistToggle
                artist={artist}
                onToggle={() => toggle(artist)}
                selected={pickedSlugs.has(artist.slug)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-sm text-muted-foreground">
          Nobody by that name out here. Try another spelling.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={picked.length === 0}
          onClick={() => onSeed(picked.map((artist) => artist.slug))}
          variant="default"
        >
          Find an opener
        </Button>
        <Button className="px-0" onClick={onSkip} variant="link">
          Or search for a track yourself
        </Button>
      </div>
    </div>
  );
}

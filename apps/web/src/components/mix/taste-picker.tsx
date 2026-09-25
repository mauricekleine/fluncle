import { CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type MixArtist } from "@fluncle/contracts";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { MAX_TASTE_ARTISTS } from "@/lib/mix-set";
import { cn } from "@/lib/utils";

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
  onSeed: (slugs: string[]) => void;

  onSkip: () => void;

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

import { useQuery } from "@tanstack/react-query";

// The nav's Galaxies gate. `/galaxies` 404s until the operator has named the WHOLE
// sonic map, so a site-wide nav must not link it before then. The home loader
// resolves this server-side, but the nav mounts at the root without a loader, so it
// asks the public API once (cached, best-effort) and self-heals the moment the map
// lands. A crawler that runs JS still sees the link once it is live; before then,
// correctly, there is nothing to link.

async function fetchGalaxiesLive(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/galaxies");

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as { galaxies?: unknown[] };

    return Array.isArray(body.galaxies) && body.galaxies.length > 0;
  } catch {
    // Network hiccup: stay dark rather than link a possibly-404 lens.
    return false;
  }
}

/** Whether the public `/galaxies` index is live (the map is fully named). */
export function useGalaxiesLive(): boolean {
  const { data } = useQuery({
    // The map changes rarely; one fetch per session is plenty.
    queryFn: fetchGalaxiesLive,
    queryKey: ["nav-galaxies-live"],
    staleTime: 5 * 60 * 1000,
  });

  return data ?? false;
}

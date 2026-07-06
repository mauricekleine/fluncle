// Worker-safe (HTTP-only) enrichment from Deezer, keyed by ISRC for determinism.
//
// Deezer's track-by-ISRC endpoint returns the album id and a 30s preview; the
// album endpoint then exposes the record label that Spotify's track API omits.
// Best-effort: any failure resolves to an empty result so it never blocks a
// publish. The backfill can retry later.

type DeezerTrack = {
  album?: { id?: number };
  error?: unknown;
  id?: number;
  preview?: string;
};

type DeezerAlbum = {
  error?: unknown;
  label?: string;
};

export type DeezerEnrichment = {
  label?: string;
  previewUrl?: string;
};

type DeezerSearchTrack = {
  duration?: number;
  id?: number;
};

type DeezerSearchResult = {
  data?: DeezerSearchTrack[];
  error?: unknown;
};

type DeezerTrackDetail = {
  error?: unknown;
  isrc?: string;
};

// Accept a search hit as "the same recording" only when its duration agrees
// with Spotify's within a few seconds; a wrong ISRC would seed a wrong (and
// permanent) Log ID, so a miss is better than a guess.
const DURATION_TOLERANCE_S = 4;

/**
 * Look up a recording's ISRC on Deezer when Spotify omits it (the track-add
 * ISRC fallback): search by artist + title, take the first
 * duration-confirmed hit, and read the ISRC from its track detail. Best-effort:
 * any failure resolves to undefined and the Log ID falls back to the Spotify id.
 */
export async function lookupIsrcFromDeezer(input: {
  artists: string[];
  durationMs: number;
  title: string;
}): Promise<string | undefined> {
  const artist = input.artists[0]?.trim();

  if (!artist || !input.title.trim()) {
    return undefined;
  }

  try {
    const query = `artist:"${artist}" track:"${input.title.trim()}"`;
    const searchResponse = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}`,
    );

    if (!searchResponse.ok) {
      return undefined;
    }

    const search = (await searchResponse.json()) as DeezerSearchResult;

    if (search.error || !Array.isArray(search.data)) {
      return undefined;
    }

    const expectedSeconds = input.durationMs / 1000;
    const match = search.data.find(
      (candidate) =>
        typeof candidate.id === "number" &&
        typeof candidate.duration === "number" &&
        Math.abs(candidate.duration - expectedSeconds) <= DURATION_TOLERANCE_S,
    );

    if (!match?.id) {
      return undefined;
    }

    const trackResponse = await fetch(`https://api.deezer.com/track/${match.id}`);

    if (!trackResponse.ok) {
      return undefined;
    }

    const detail = (await trackResponse.json()) as DeezerTrackDetail;

    if (detail.error || !detail.isrc?.trim()) {
      return undefined;
    }

    return detail.isrc.trim();
  } catch {
    return undefined;
  }
}

export async function enrichFromDeezer(isrc: string | null | undefined): Promise<DeezerEnrichment> {
  if (!isrc?.trim()) {
    return {};
  }

  try {
    const trackResponse = await fetch(
      `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc.trim())}`,
    );

    if (!trackResponse.ok) {
      return {};
    }

    const track = (await trackResponse.json()) as DeezerTrack;

    if (track.error || !track.id) {
      return {};
    }

    const previewUrl = track.preview?.trim() ? track.preview : undefined;
    let label: string | undefined;

    if (track.album?.id) {
      const albumResponse = await fetch(`https://api.deezer.com/album/${track.album.id}`);

      if (albumResponse.ok) {
        const album = (await albumResponse.json()) as DeezerAlbum;

        if (!album.error && album.label?.trim()) {
          label = album.label.trim();
        }
      }
    }

    return { label, previewUrl };
  } catch {
    return {};
  }
}

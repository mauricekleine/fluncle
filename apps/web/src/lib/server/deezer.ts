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

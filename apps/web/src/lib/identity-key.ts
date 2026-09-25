const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeIsrcKey(raw: string): string | undefined {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();

  return ISRC_PATTERN.test(compact) ? compact : undefined;
}

export function normalizeMbidKey(raw: string): string | undefined {
  const compact = raw.trim().toLowerCase().replace(/^mb_/, "");

  return MBID_PATTERN.test(compact) ? compact : undefined;
}

const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

const DEEZER_ID_PATTERN = /^\d{1,20}$/;

const SPOTIFY_URI_PATTERN = /^spotify:track:([A-Za-z0-9]+)$/i;

const DEEZER_URI_PATTERN = /^deezer:track:(\d+)$/i;

function trackIdFromUrl(raw: string, host: string): string | undefined {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname !== host && !hostname.endsWith(`.${host}`)) {
    return undefined;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.indexOf("track");

  return at === -1 ? undefined : segments[at + 1];
}

export function normalizeSpotifyKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  const uri = SPOTIFY_URI_PATTERN.exec(trimmed);
  const candidate = uri?.[1] ?? trackIdFromUrl(trimmed, "spotify.com") ?? trimmed;

  return SPOTIFY_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function normalizeDeezerKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  const uri = DEEZER_URI_PATTERN.exec(trimmed);
  const candidate = uri?.[1] ?? trackIdFromUrl(trimmed, "deezer.com") ?? trimmed;

  return DEEZER_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export type PlatformIdentityKey = { id: string; platform: "deezer" | "spotify" };

export function platformIdentityKey(raw: string): PlatformIdentityKey | undefined {
  const trimmed = raw.trim();
  const spotifyUri = SPOTIFY_URI_PATTERN.exec(trimmed)?.[1];

  if (spotifyUri && SPOTIFY_ID_PATTERN.test(spotifyUri)) {
    return { id: spotifyUri, platform: "spotify" };
  }

  const deezerUri = DEEZER_URI_PATTERN.exec(trimmed)?.[1];

  if (deezerUri && DEEZER_ID_PATTERN.test(deezerUri)) {
    return { id: deezerUri, platform: "deezer" };
  }

  const spotifyUrl = trackIdFromUrl(trimmed, "spotify.com");

  if (spotifyUrl && SPOTIFY_ID_PATTERN.test(spotifyUrl)) {
    return { id: spotifyUrl, platform: "spotify" };
  }

  const deezerUrl = trackIdFromUrl(trimmed, "deezer.com");

  if (deezerUrl && DEEZER_ID_PATTERN.test(deezerUrl)) {
    return { id: deezerUrl, platform: "deezer" };
  }

  return undefined;
}

export function canonicalIdentityKey(raw: string): string {
  const platform = platformIdentityKey(raw);

  return (
    normalizeIsrcKey(raw) ??
    normalizeMbidKey(raw) ??
    (platform ? `${platform.platform}:track:${platform.id}` : raw.trim())
  );
}

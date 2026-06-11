import { enrichFromDeezer } from "./deezer";

export type LivePreviewTrack = {
  artists: string[];
  isrc?: string;
  previewUrl?: string;
  title: string;
};

export async function fetchLivePreview(
  track: LivePreviewTrack,
  request: Request,
): Promise<Response | undefined> {
  const range = request.headers.get("range");
  const upstreamInit: RequestInit = range ? { headers: { range } } : {};

  const stored = await fetchUsablePreview(track.previewUrl, upstreamInit);

  if (stored) {
    return stored;
  }

  const refreshed = await enrichFromDeezer(track.isrc);
  const deezer = await fetchUsablePreview(
    refreshed.previewUrl && refreshed.previewUrl !== track.previewUrl
      ? refreshed.previewUrl
      : undefined,
    upstreamInit,
  );

  if (deezer) {
    return deezer;
  }

  const itunesUrl = await resolveItunesPreviewUrl(track).catch(() => undefined);

  return fetchUsablePreview(itunesUrl, upstreamInit);
}

async function fetchUsablePreview(
  url: string | undefined,
  init: RequestInit,
): Promise<Response | undefined> {
  if (!url) {
    return undefined;
  }

  const response = await fetch(url, init);

  return response.ok || response.status === 206 ? response : undefined;
}

type ItunesHit = {
  artistName?: string;
  previewUrl?: string;
  trackName?: string;
};

type ItunesResponse = {
  results?: ItunesHit[];
};

async function resolveItunesPreviewUrl(track: LivePreviewTrack): Promise<string | undefined> {
  const artist = track.artists[0]?.trim();

  if (!artist || !track.title.trim()) {
    return undefined;
  }

  const term = `${artist} ${track.title.trim()}`;
  const response = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=10`,
    { headers: { accept: "application/json" } },
  );

  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as ItunesResponse;
  let best: { score: number; url: string } | undefined;

  for (const hit of body.results ?? []) {
    if (!hit.previewUrl) {
      continue;
    }

    const score =
      0.6 * similarity(hit.trackName ?? "", track.title) +
      0.4 * similarity(hit.artistName ?? "", artist);

    if (score >= 0.6 && (!best || score > best.score)) {
      best = { score, url: hit.previewUrl };
    }
  }

  return best?.url;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Dice coefficient over bigrams; cheap fuzzy similarity in 0..1. */
function similarity(a: string, b: string): number {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);

  if (normalizedA.length === 0 || normalizedB.length === 0) {
    return 0;
  }

  if (normalizedA === normalizedB) {
    return 1;
  }

  const bigrams = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();

    for (let index = 0; index < value.length - 1; index++) {
      const gram = value.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }

    return counts;
  };
  const left = bigrams(normalizedA);
  const right = bigrams(normalizedB);
  let intersection = 0;

  for (const [gram, count] of left) {
    const other = right.get(gram);

    if (other) {
      intersection += Math.min(count, other);
    }
  }

  const total = normalizedA.length - 1 + (normalizedB.length - 1);

  return total > 0 ? (2 * intersection) / total : 0;
}

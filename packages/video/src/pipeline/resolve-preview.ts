// Resolve a 30s preview audio URL for a track, without ever touching YouTube.
// Deezer is tried first (exact-ish artist match -> high confidence); iTunes is
// the fuzzy fallback. Returns null when nothing clears the confidence floor.

type PreviewSource = "deezer" | "itunes";

export type ResolvedPreview = {
  source: PreviewSource;
  url: string;
  confidence: number;
};

const CONFIDENCE_FLOOR = 0.6;

type DeezerHit = {
  preview?: string;
  title?: string;
  artist?: { name?: string };
};

type DeezerResponse = { data?: DeezerHit[] };

type ItunesHit = {
  previewUrl?: string;
  trackName?: string;
  artistName?: string;
};

type ItunesResponse = { results?: ItunesHit[] };

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Dice coefficient over bigrams; cheap fuzzy similarity in 0..1. */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) {
    return 0;
  }
  if (na === nb) {
    return 1;
  }
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let intersection = 0;
  for (const [g, count] of ba) {
    const other = bb.get(g);
    if (other) {
      intersection += Math.min(count, other);
    }
  }
  const total = na.length - 1 + (nb.length - 1);
  return total > 0 ? (2 * intersection) / total : 0;
}

async function resolveDeezer(title: string, artist: string): Promise<ResolvedPreview | null> {
  const q = `artist:"${artist}" track:"${title}"`;
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as DeezerResponse;
  const hits = json.data ?? [];

  for (const hit of hits) {
    if (!hit.preview) {
      continue;
    }
    const artistMatch = normalize(hit.artist?.name ?? "") === normalize(artist);
    if (artistMatch) {
      return { confidence: 0.95, source: "deezer", url: hit.preview };
    }
  }

  // Looser fallback within Deezer: take the best fuzzy match if it clears the floor.
  let best: ResolvedPreview | null = null;
  for (const hit of hits) {
    if (!hit.preview) {
      continue;
    }
    const score =
      0.5 * similarity(hit.title ?? "", title) + 0.5 * similarity(hit.artist?.name ?? "", artist);
    if (score >= CONFIDENCE_FLOOR && (!best || score > best.confidence)) {
      best = { confidence: Number(score.toFixed(3)), source: "deezer", url: hit.preview };
    }
  }
  return best;
}

async function resolveItunes(title: string, artist: string): Promise<ResolvedPreview | null> {
  const term = `${artist} ${title}`;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=10`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as ItunesResponse;
  const hits = json.results ?? [];

  let best: ResolvedPreview | null = null;
  for (const hit of hits) {
    if (!hit.previewUrl) {
      continue;
    }
    const titleScore = similarity(hit.trackName ?? "", title);
    const artistScore = similarity(hit.artistName ?? "", artist);
    const score = 0.6 * titleScore + 0.4 * artistScore;
    if (score >= CONFIDENCE_FLOOR && (!best || score > best.confidence)) {
      best = { confidence: Number(score.toFixed(3)), source: "itunes", url: hit.previewUrl };
    }
  }
  return best;
}

/**
 * Resolve a preview URL for a track. Deezer first, iTunes fallback, never YouTube.
 * Returns null if no candidate reaches the confidence floor (0.6).
 */
export async function resolvePreview({
  title,
  artists,
}: {
  title: string;
  artists: string[];
}): Promise<ResolvedPreview | null> {
  const artist = artists[0] ?? "";

  const deezer = await resolveDeezer(title, artist).catch(() => null);
  if (deezer && deezer.confidence >= CONFIDENCE_FLOOR) {
    return deezer;
  }

  const itunes = await resolveItunes(title, artist).catch(() => null);
  if (itunes && itunes.confidence >= CONFIDENCE_FLOOR) {
    return itunes;
  }

  return null;
}

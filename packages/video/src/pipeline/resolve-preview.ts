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

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Any word that marks a track as a specific version rather than the bare title.
const VERSION_MARKER =
  /\b(mix|edit|version|remix|dub|vip|bootleg|rework|re-?edit|flip|refix|remaster(?:ed)?|instrumental)\b/i;
// A third-party / alternate REWORK (not the artist's own original/extended/radio
// cut), which would carry different musical content than the finding.
const REMIX_MARKER = /\b(remix|bootleg|vip|rework|re-?edit|flip|refix)\b/i;

/**
 * Strip a trailing version/mix descriptor so a Spotify title like
 * "Days Like These - Original Mix" matches Deezer's bare "Days Like These".
 * Dance-music titles almost always carry one ("- Original Mix", "- Radio Edit",
 * "- Extended Mix", "- <Artist> Remix"); Deezer's exact `track:` filter returns
 * zero hits when the suffix is included. Only strips a tail that actually names a
 * version, so an ordinary "A - B" title is left untouched.
 */
export function stripVersionSuffix(title: string): string {
  const parts = title.split(/\s+-\s+/);
  if (parts.length > 1 && VERSION_MARKER.test(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" - ").trim();
  }
  return title.trim();
}

function isRemix(title: string): boolean {
  return REMIX_MARKER.test(title);
}

/** Dice coefficient over bigrams; cheap fuzzy similarity in 0..1. */
export function similarity(a: string, b: string): number {
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
  // Query Deezer with the version suffix stripped — an exact `track:"… - Original
  // Mix"` returns nothing, while the bare title finds the release plus its remixes.
  const baseTitle = stripVersionSuffix(title);
  const q = `artist:"${artist}" track:"${baseTitle}"`;
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as DeezerResponse;
  const hits = json.data ?? [];

  // Among exact-artist hits, pick the recording that matches the FINDING — not the
  // first one Deezer returns (often a remix). The finding's "- Original Mix" is the
  // bare original, so prefer the non-remix whose base title is closest, and back
  // away from a third-party rework unless the finding itself is that rework.
  const targetBase = stripVersionSuffix(title);
  const targetIsRemix = isRemix(title);
  let exact: { score: number; preview: ResolvedPreview } | null = null;
  for (const hit of hits) {
    if (!hit.preview) {
      continue;
    }
    if (normalize(hit.artist?.name ?? "") !== normalize(artist)) {
      continue;
    }
    let score = similarity(stripVersionSuffix(hit.title ?? ""), targetBase);
    if (isRemix(hit.title ?? "")) {
      if (!targetIsRemix) {
        score -= 0.5;
      }
    } else {
      score += 0.05;
    }
    if (!exact || score > exact.score) {
      exact = { preview: { confidence: 0.92, source: "deezer", url: hit.preview }, score };
    }
  }
  if (exact) {
    return exact.preview;
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

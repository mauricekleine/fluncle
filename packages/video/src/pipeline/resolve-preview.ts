import { normalize, stripVersionSuffix, versionMatches } from "@fluncle/contracts/util";

export { isRemix, normalize, stripVersionSuffix, versionMatches } from "@fluncle/contracts/util";

type PreviewSource = "deezer" | "itunes" | "archive";

export type ResolvedPreview = {
  source: PreviewSource;
  url: string;
  confidence: number;

  headers?: Record<string, string>;
};

const CONFIDENCE_FLOOR = 0.6;

type DeezerHit = {
  preview?: string;
  title?: string;
  artist?: { name?: string };
};

type DeezerResponse = { data?: DeezerHit[] };

type DeezerIsrcTrack = { error?: unknown; preview?: string };

type ItunesHit = {
  previewUrl?: string;
  trackName?: string;
  artistName?: string;
};

type ItunesResponse = { results?: ItunesHit[] };

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

async function resolveDeezerByIsrc(isrc: string): Promise<ResolvedPreview | null> {
  const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc.trim())}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    return null;
  }
  const track = (await res.json()) as DeezerIsrcTrack;
  if (track.error || !track.preview?.trim()) {
    return null;
  }

  return { confidence: 0.99, source: "deezer", url: track.preview };
}

async function resolveDeezerSearch(title: string, artist: string): Promise<ResolvedPreview | null> {
  const baseTitle = stripVersionSuffix(title);
  const q = `artist:"${artist}" track:"${baseTitle}"`;
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as DeezerResponse;
  const hits = json.data ?? [];

  const targetBase = stripVersionSuffix(title);

  let exact: { score: number; preview: ResolvedPreview } | null = null;
  for (const hit of hits) {
    if (!hit.preview) {
      continue;
    }
    if (normalize(hit.artist?.name ?? "") !== normalize(artist)) {
      continue;
    }
    if (!versionMatches(title, hit.title ?? "")) {
      continue;
    }
    const score = similarity(stripVersionSuffix(hit.title ?? ""), targetBase);
    if (!exact || score > exact.score) {
      exact = { preview: { confidence: 0.92, source: "deezer", url: hit.preview }, score };
    }
  }
  if (exact) {
    return exact.preview;
  }

  let best: ResolvedPreview | null = null;
  for (const hit of hits) {
    if (!hit.preview) {
      continue;
    }
    if (!versionMatches(title, hit.title ?? "")) {
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
    if (!versionMatches(title, hit.trackName ?? "")) {
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

export async function resolvePreview({
  title,
  artists,
  isrc,
}: {
  title: string;
  artists: string[];
  isrc?: string;
}): Promise<ResolvedPreview | null> {
  const artist = artists[0] ?? "";

  if (isrc?.trim()) {
    const byIsrc = await resolveDeezerByIsrc(isrc).catch(() => null);
    if (byIsrc) {
      return byIsrc;
    }
  }

  const deezer = await resolveDeezerSearch(title, artist).catch(() => null);
  if (deezer && deezer.confidence >= CONFIDENCE_FLOOR) {
    return deezer;
  }

  const itunes = await resolveItunes(title, artist).catch(() => null);
  if (itunes && itunes.confidence >= CONFIDENCE_FLOOR) {
    return itunes;
  }

  return null;
}

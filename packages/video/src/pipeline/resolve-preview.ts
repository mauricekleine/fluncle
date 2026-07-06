// Resolve a 30s preview audio URL for a track, without ever touching YouTube.
//
// ISRC FIRST: a finding's ISRC uniquely identifies the EXACT recording (an
// original and its remix carry DIFFERENT ISRCs), so when we have it we resolve
// Deezer by `track/isrc:<isrc>` — exact, region-independent, never the wrong
// recording. Only when there is no ISRC (or the ISRC lookup yields no preview) do
// we fall back to an artist+title search, and that fallback is VERSION-AWARE: it
// requires the candidate's version descriptor to agree with the finding's (a remix
// finding resolves to the matching remix, never the bare original — see the
// version-match helpers in @fluncle/contracts/util, which mirror
// apps/web/src/lib/server/discogs.ts).
//
// iTunes is the last-resort fuzzy fallback. Returns null when nothing clears the
// confidence floor.

import { normalize, stripVersionSuffix, versionMatches } from "@fluncle/contracts/util";

export { isRemix, normalize, stripVersionSuffix, versionMatches } from "@fluncle/contracts/util";

type PreviewSource = "deezer" | "itunes" | "archive";

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

type DeezerIsrcTrack = { error?: unknown; preview?: string };

type ItunesHit = {
  previewUrl?: string;
  trackName?: string;
  artistName?: string;
};

type ItunesResponse = { results?: ItunesHit[] };

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

/**
 * EXACT path: Deezer by ISRC. `track/isrc:<isrc>` returns the one recording the
 * finding's ISRC names — original or remix, never the other — with its 30s
 * preview. This is the same endpoint the render's own caption.ts (fetchReleaseYear)
 * and apps/web's enrichFromDeezer already trust. Null when the ISRC has no Deezer
 * match or no preview, so the caller falls back to the version-aware name search.
 */
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
  // ISRC is exact-recording, so confidence is maximal among the live sources.
  return { confidence: 0.99, source: "deezer", url: track.preview };
}

async function resolveDeezerSearch(title: string, artist: string): Promise<ResolvedPreview | null> {
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

  const targetBase = stripVersionSuffix(title);

  // Among exact-artist hits, pick the recording whose VERSION matches the finding —
  // never the first one Deezer returns (often a remix), and never tip a remix to
  // the bare original. The version gate (versionMatches) is the kill-switch; among
  // version-matching candidates we then prefer the closest base title.
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

  // Looser fallback within Deezer: take the best fuzzy match if it clears the floor
  // AND its version still agrees with the finding (so the remix never falls through
  // to the original here either).
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

  // iTunes is the last-resort leg and exposes only a "trackName" without a clean
  // version field. We can't fully trust its descriptor, but we can at least refuse
  // an OBVIOUS mismatch: a remix finding must not take a non-remix hit (and an
  // original must not take a third-party remix). Version-aware, not blind.
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

/**
 * Resolve a preview URL for a track. ISRC-first (exact recording), then a
 * version-aware Deezer/iTunes name search, never YouTube. Returns null if no
 * candidate reaches the confidence floor (0.6).
 */
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

  // 1. Exact: Deezer by ISRC. The finding's ISRC IS the recording.
  if (isrc?.trim()) {
    const byIsrc = await resolveDeezerByIsrc(isrc).catch(() => null);
    if (byIsrc) {
      return byIsrc;
    }
  }

  // 2. Fallback: version-aware Deezer search.
  const deezer = await resolveDeezerSearch(title, artist).catch(() => null);
  if (deezer && deezer.confidence >= CONFIDENCE_FLOOR) {
    return deezer;
  }

  // 3. Last resort: version-aware iTunes search.
  const itunes = await resolveItunes(title, artist).catch(() => null);
  if (itunes && itunes.confidence >= CONFIDENCE_FLOOR) {
    return itunes;
  }

  return null;
}

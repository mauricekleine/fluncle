// Worker-safe (HTTP-only) enrichment from Deezer, keyed by ISRC for determinism.
//
// Deezer's track-by-ISRC endpoint returns the album id and a 30s preview; the
// album endpoint then exposes the record label that Spotify's track API omits.
// Best-effort: any failure resolves to an empty result so it never blocks a
// publish. The backfill can retry later.
//
// ── THE ISRC-RECOVERY RUNG (`searchDeezerCandidates`, verified live 2026-07-22) ──────────────────
// Deezer is a FREE, no-auth ISRC ORACLE. Its `GET /search/track?q=…` returns each hit already
// carrying the recording's real `isrc`, its `duration`, its `title`, and its billed `artist.name` —
// so ONE search request recovers the ISRC our own row lacks (the crawler's ISRC comes from
// MusicBrainz, whose ISRC coverage of underground DnB is sparse, so ~60% of catalogue rows arrive
// ISRC-less even though the track genuinely HAS one). No second by-id read is needed: the search hit
// is the whole answer. Deezer's search is FUZZY (it will happily return a remix for the original), so
// the CALLER re-verifies every hit against the row to the SAME bar the anchor gate uses — the folded
// artist-set + base-title identity (`matchKey`) AND a duration within the ratified ±2s window — before
// it trusts an ISRC (`anchor.ts`, the recovery step). A wrong ISRC seeds a wrong exact-ISRC anchor, so
// a miss is always preferred to a guess: this client just fetches and normalizes; anchor.ts rules.

import { logEvent } from "./log";

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
  artist?: { name?: string };
  duration?: number;
  id?: number;
  isrc?: string;
  title?: string;
};

type DeezerSearchResult = {
  data?: DeezerSearchTrack[];
  error?: unknown;
};

/**
 * One Deezer search hit, normalized to exactly the fields the anchor recovery step verifies against
 * a catalogue row. `artistName` is Deezer's BILLED string (e.g. `"Fred V & Grafix"`) — the caller
 * folds it into an artist SET via `matchKey`, so a combined billing splits correctly. `durationMs`
 * is Deezer's seconds promoted to ms so the ±2s anchor window compares in the same unit. `isrc` is
 * guaranteed non-blank (a hit without one is dropped).
 */
export type DeezerIsrcCandidate = {
  artistName: string;
  durationMs: number;
  isrc: string;
  title: string;
};

/** The identifiable User-Agent Fluncle presents across the web — one honest identity. */
const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

/**
 * Per-request wall-clock deadline. Deezer answers a title+artist search well under a second; anything
 * past this is a stalled socket, and a stall is just a miss (the row stays ISRC-less and falls to the
 * fuzzy anchor rung, exactly as before this rung existed). Bounded so the box sweep's per-row
 * `resolve_anchor` call can never wedge the tick.
 */
const DEEZER_TIMEOUT_MS = 10_000;

/**
 * How many search hits to consider. Deezer's fuzzy search can return a near-miss (a remix, a re-edit)
 * ahead of the exact recording, so we read a small handful and let the caller's fold+duration gate
 * pick the one that truly matches — never blindly the first.
 */
const DEEZER_SEARCH_LIMIT = 5;

/**
 * Recover ISRC CANDIDATES for a catalogue row from Deezer's free search — the pre-anchor ISRC-recovery
 * rung (`anchor.ts`). Queries Deezer's precise field syntax (`artist:"…" track:"…"`) and returns each
 * hit that carries a usable `isrc` + numeric `duration` + `title` + `artist.name`, normalized to
 * {@link DeezerIsrcCandidate}. It VERIFIES NOTHING — the caller re-runs the row against the same fold +
 * ±2s duration gate the anchor uses, and trusts an ISRC only on a hard match (a wrong ISRC would seed a
 * wrong exact-ISRC anchor). Best-effort and NEVER throws: a bad artist/title, a network error, a
 * timeout, a non-2xx, an error body, or a malformed shape all resolve to `[]` — an empty list is a
 * first-class, unremarkable "no recovery, fall to fuzzy".
 *
 * Politeness: IDENTIFIED (the honest Fluncle User-Agent) and BOUNDED (a per-request deadline). Like the
 * sibling ListenBrainz rung it carries NO module-level pacing gate: the anchor waterfall makes exactly
 * ONE Deezer search per `resolve_anchor` request and the box sweep issues those one-at-a-time down its
 * worklist, so the request cadence — never a burst — is what keeps us under Deezer's soft limit.
 */
export async function searchDeezerCandidates(input: {
  artists: string[];
  title: string;
}): Promise<DeezerIsrcCandidate[]> {
  const artist = input.artists[0]?.replaceAll('"', " ").trim();
  const title = input.title.replaceAll('"', " ").trim();

  if (!artist || !title) {
    return [];
  }

  let response: Response;

  try {
    const query = `artist:"${artist}" track:"${title}"`;
    response = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch (error) {
    // A network error OR a timeout abort — both mean this lookup yielded nothing.
    logEvent("warn", "deezer.search-threw", { error });

    return [];
  }

  if (!response.ok) {
    return [];
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "deezer.search-malformed-body", { error });

    return [];
  }

  const data = (body as DeezerSearchResult).data;

  if (!Array.isArray(data)) {
    return [];
  }

  const candidates: DeezerIsrcCandidate[] = [];

  for (const hit of data) {
    const isrc = hit.isrc?.trim() ?? "";
    const title = hit.title?.trim() ?? "";
    const artistName = hit.artist?.name?.trim() ?? "";

    if (!isrc || !title || !artistName || typeof hit.duration !== "number" || hit.duration <= 0) {
      continue;
    }

    candidates.push({ artistName, durationMs: Math.round(hit.duration * 1000), isrc, title });
  }

  return candidates;
}

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

// Worker-safe (HTTP-only), read-only Discogs enrichment: resolve a finding to its
// Discogs RELEASE id (+ the master that groups its versions) so the release
// metadata corroborates the finding and `discogs.com/release/{id}` becomes a
// per-finding `sameAs` for the track. No writes to Discogs — search + release
// lookup only. See docs/rfcs/lastfm-discogs-sync.md §2.
//
// Auth: a personal access token (single-user) sent as `Authorization: Discogs
// token=…`. The token lifts the rate limit to ~60 req/min (vs ~25 unauthenticated)
// and is the right path for a single account — OAuth 1.0a is overkill here. The
// lookup degrades gracefully without a token: it just no-ops (no anonymous calls,
// to keep the User-Agent + token discipline uniform).
//
// Discogs has no ISRC search, so matching is by `{artist, title}` (barcode when we
// have one, which we don't from Spotify today) — best-effort and fuzzy, exactly
// like the Deezer label lookup. A miss resolves to {} and never blocks the add.

import { readOptionalEnv } from "./env";

const API_ROOT = "https://api.discogs.com";
// Discogs REJECTS/limits generic User-Agents — an identifiable one is mandatory
// (verified via the Discogs developer docs, 2026-06-20). Same discipline as the
// Last.fm / Deezer lookups: Fluncle, the curation side-project.
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

export type DiscogsEnrichment = {
  masterId?: number;
  releaseId?: number;
};

// A Discogs `type=release` search hit. `id` is the release id; `master_id` is the
// master that groups its versions (0 when the release has no master).
type DiscogsSearchHit = {
  id?: number;
  master_id?: number;
};

type DiscogsSearchResult = {
  message?: string;
  results?: DiscogsSearchHit[];
};

/**
 * Resolve a finding to its Discogs release id (+ master id), best-effort. Searches
 * `type=release` by artist + track title (Discogs has no ISRC search), takes the
 * top release hit, and returns its ids. Authenticated with the personal token for
 * the higher rate limit; no-ops when the token isn't provisioned. Never throws —
 * any failure resolves to {} so the publish path is untouched (same side-channel
 * discipline as enrichFromDeezer / lastfmLove).
 */
export async function discogsResolveRelease(
  artist: string | undefined,
  title: string,
): Promise<DiscogsEnrichment> {
  const cleanArtist = artist?.trim();
  const cleanTitle = title.trim();

  if (!cleanArtist || !cleanTitle) {
    return {};
  }

  try {
    const token = await readOptionalEnv("DISCOGS_USER_TOKEN");

    if (!token) {
      // Not provisioned yet — silently skip (the columns stay inert until the
      // Worker secret is set). Keeps the User-Agent + token discipline uniform.
      return {};
    }

    const query = new URLSearchParams({
      artist: cleanArtist,
      per_page: "5",
      track: cleanTitle,
      type: "release",
    });

    const response = await fetch(`${API_ROOT}/database/search?${query.toString()}`, {
      headers: {
        Authorization: `Discogs token=${token}`,
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      // 429 (rate limited) or any other non-2xx: skip this one, the add continues.
      return {};
    }

    const json = (await response.json()) as DiscogsSearchResult;
    const hit = json.results?.find((candidate) => typeof candidate.id === "number");

    if (!hit?.id) {
      return {};
    }

    return {
      // master_id is 0 for a release with no master — normalize that to undefined.
      masterId: typeof hit.master_id === "number" && hit.master_id > 0 ? hit.master_id : undefined,
      releaseId: hit.id,
    };
  } catch (error) {
    // Side-channel: log and continue. The lookup is idempotent (read-only), so a
    // later backfill is harmless; the add must never fail on a Discogs miss.
    console.error(
      `Discogs resolve failed for "${artist} — ${title}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return {};
  }
}

/** The public `discogs.com/release/{id}` URL — the per-finding `sameAs` for a track. */
export function discogsReleaseUrl(releaseId: number): string {
  return `https://www.discogs.com/release/${releaseId}`;
}

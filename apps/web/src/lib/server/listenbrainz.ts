// THE LISTENBRAINZ CLIENT — the FREE first rung of the catalogue anchor waterfall.
//
// A catalogue track (a `tracks` row with no `findings` row) is resolved from MusicBrainz, so it
// carries a canonical MusicBrainz recording MBID (`mb_recording_id`) but often no Spotify anchor.
// ListenBrainz's sibling labs service exposes a recording-MBID → Spotify-track-id mapping built
// from the same open graph — so given the MBID Fluncle already holds, it hands back the Spotify
// track ids for that exact recording, for free and with no auth. That is the cheapest possible
// anchor candidate, tried BEFORE the metered Apify search (lib/server/anchor.ts `resolveAnchorFree`):
// a hit costs nothing, and Apify is only spent when this rung misses. When Apify is down (its budget
// or the actor), this rung still anchors its share — the waterfall's graceful-degradation half.
//
// ── THE ENDPOINT (verified live 2026-07-21) ──────────────────────────────────────────────────────
// `POST https://labs.api.listenbrainz.org/spotify-id-from-mbid/json`, body a JSON array of
// `{ recording_mbid }` objects. It answers with an array, one entry per input, each carrying
// `recording_mbid`, `artist_name`, `release_name`, `track_name`, and `spotify_track_ids` (an ARRAY —
// every market/pressing variant of the recording, most-canonical first). A recording it cannot map
// is simply ABSENT from the response array (a bogus MBID → `[]`). It carries NO ISRC and NO duration,
// so a returned id is only a CANDIDATE: the caller fetches its metadata and runs it through the SAME
// verification gate an Apify candidate clears (`anchorTrack`) — the box's verdict is never trusted,
// and neither is ListenBrainz's.
//
// ── POLITENESS, and why there is no module-level pacing gate here ─────────────────────────────────
// This is IDENTIFIED (the same `Fluncle/1.0 (+…)` User-Agent the MusicBrainz client sends — one
// honest identity across the MetaBrainz services) and BOUNDED (a per-request wall-clock deadline).
// It never throws: a network error, a timeout, a non-2xx, a malformed body, or a clean no-map all
// resolve to `null` — a miss is fine, and the caller falls through to the Apify rung.
//
// It deliberately does NOT carry the musicbrainz.ts serialized pacing gate, because that gate paces
// a LOOP of calls made WITHIN one request (the backfill sweep resolves 25 ISRCs per request), and it
// relies on module-level state that a Cloudflare isolate does not reliably carry between requests.
// The anchor waterfall makes exactly ONE ListenBrainz call per `resolve_anchor` request, and the box
// sweep issues those requests strictly one-at-a-time down its worklist (docs/agents/hermes/scripts/
// anchor-sweep.ts). So the request cadence — never a burst — is what paces this rung, and a
// within-request gate would only ever guard a loop that does not exist.

import { logEvent } from "./log";
import { MB_USER_AGENT } from "./musicbrainz";

/** The labs recording-MBID → Spotify-track-id mapping endpoint (the `/json` POST variant). */
const LISTENBRAINZ_MBID_ENDPOINT = "https://labs.api.listenbrainz.org/spotify-id-from-mbid/json";

/**
 * Per-request wall-clock deadline. The labs endpoint answers a single-MBID lookup well under a
 * second; anything past this is a stalled socket, and a stall is just a miss (the Apify rung is the
 * fallback). Bounded so the box sweep's per-row `resolve_anchor` call can never wedge the tick.
 */
const LISTENBRAINZ_TIMEOUT_MS = 10_000;

/** One item in the labs endpoint's response array — only the fields this client reads. */
type ListenBrainzResponseItem = {
  artist_name?: string;
  recording_mbid?: string;
  spotify_track_ids?: string[];
  track_name?: string;
};

/**
 * One recording's ListenBrainz → Spotify mapping. `spotifyTrackIds` is guaranteed NON-EMPTY (a
 * match with no usable id resolves to `null` instead), most-canonical first. `trackName`/`artistName`
 * are the labs echo, kept for logging/diagnostics — the anchor gate re-derives identity from the
 * Spotify candidate's own metadata, never from these strings.
 */
export type ListenBrainzMatch = {
  artistName: null | string;
  recordingMbid: string;
  spotifyTrackIds: string[];
  trackName: null | string;
};

/**
 * Resolve one MusicBrainz recording MBID to its Spotify track ids via ListenBrainz labs. Returns
 * `null` on ANY unsuccessful outcome — a bad MBID (absent from the response), an empty id list, a
 * network error, a timeout, a non-2xx, or a body that is not the expected array — because to the
 * anchor waterfall every one of those is the same thing: "no free candidate, try Apify". It never
 * throws; a miss is a first-class, unremarkable answer.
 */
export async function lookupSpotifyIdsByMbid(
  recordingMbid: string,
): Promise<ListenBrainzMatch | null> {
  const clean = recordingMbid.trim();

  if (!clean) {
    return null;
  }

  let response: Response;

  try {
    response = await fetch(LISTENBRAINZ_MBID_ENDPOINT, {
      body: JSON.stringify([{ recording_mbid: clean }]),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": MB_USER_AGENT,
      },
      method: "POST",
      signal: AbortSignal.timeout(LISTENBRAINZ_TIMEOUT_MS),
    });
  } catch (error) {
    // A network error OR a timeout abort — both mean this lookup yielded nothing.
    logEvent("warn", "listenbrainz.request-threw", { error, recordingMbid: clean });

    return null;
  }

  if (!response.ok) {
    logEvent("warn", "listenbrainz.request-failed", {
      recordingMbid: clean,
      status: response.status,
    });

    return null;
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "listenbrainz.malformed-body", { error, recordingMbid: clean });

    return null;
  }

  if (!Array.isArray(body)) {
    return null;
  }

  // The endpoint echoes one entry per input MBID; a recording it cannot map is simply absent, so an
  // empty array is a clean miss. Read the entry for OUR MBID (the response order matches the input,
  // but match on the id to be exact) and keep only real, non-blank Spotify ids.
  const item = (body as ListenBrainzResponseItem[]).find(
    (entry) => (entry.recording_mbid ?? clean) === clean,
  );
  const spotifyTrackIds = (item?.spotify_track_ids ?? [])
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (spotifyTrackIds.length === 0) {
    return null;
  }

  return {
    artistName: item?.artist_name ?? null,
    recordingMbid: clean,
    spotifyTrackIds,
    trackName: item?.track_name ?? null,
  };
}

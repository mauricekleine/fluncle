import { logEvent } from "./log";
import { MB_USER_AGENT } from "./musicbrainz";

const LISTENBRAINZ_MBID_ENDPOINT = "https://labs.api.listenbrainz.org/spotify-id-from-mbid/json";

const LISTENBRAINZ_TIMEOUT_MS = 10_000;

type ListenBrainzResponseItem = {
  artist_name?: string;
  recording_mbid?: string;
  spotify_track_ids?: string[];
  track_name?: string;
};

type ListenBrainzMatch = {
  artistName: null | string;
  recordingMbid: string;
  spotifyTrackIds: string[];
  trackName: null | string;
};

export type ListenBrainzLookupResult =
  | {
      match: ListenBrainzMatch;
      outcome: "match";
    }
  | {
      outcome:
        | "empty-ids"
        | "invalid-mbid"
        | "malformed-body"
        | "no-map"
        | "non-array-body"
        | "request-failed"
        | "request-threw";
    };

export async function lookupSpotifyIdsByMbid(
  recordingMbid: string,
): Promise<ListenBrainzLookupResult> {
  const clean = recordingMbid.trim();

  if (!clean) {
    return { outcome: "invalid-mbid" };
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
    logEvent("warn", "listenbrainz.request-threw", { error, recordingMbid: clean });

    return { outcome: "request-threw" };
  }

  if (!response.ok) {
    logEvent("warn", "listenbrainz.request-failed", {
      recordingMbid: clean,
      status: response.status,
    });

    return { outcome: "request-failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "listenbrainz.malformed-body", { error, recordingMbid: clean });

    return { outcome: "malformed-body" };
  }

  if (!Array.isArray(body)) {
    logEvent("warn", "listenbrainz.non-array-body", { recordingMbid: clean });

    return { outcome: "non-array-body" };
  }

  const item = body.find((entry): entry is ListenBrainzResponseItem => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }

    const candidate = entry as ListenBrainzResponseItem;

    return (candidate.recording_mbid ?? clean) === clean;
  });

  if (!item) {
    return { outcome: "no-map" };
  }

  const spotifyTrackIds = (Array.isArray(item.spotify_track_ids) ? item.spotify_track_ids : [])
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (spotifyTrackIds.length === 0) {
    return { outcome: "empty-ids" };
  }

  return {
    match: {
      artistName: item.artist_name ?? null,
      recordingMbid: clean,
      spotifyTrackIds,
      trackName: item.track_name ?? null,
    },
    outcome: "match",
  };
}

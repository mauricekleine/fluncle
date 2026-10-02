import { Data, Duration, Effect } from "effect";
import { runServerEffect } from "./effect/runtime";
import { MB_USER_AGENT } from "./musicbrainz";

const LISTENBRAINZ_MBID_ENDPOINT = "https://labs.api.listenbrainz.org/spotify-id-from-mbid/json";
const LISTENBRAINZ_METADATA_ENDPOINT =
  "https://labs.api.listenbrainz.org/spotify-id-from-metadata/json";

const LISTENBRAINZ_REQUEST_TIMEOUT = Duration.millis(10_000);

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

class ListenBrainzBodyFailed extends Data.TaggedError("ListenBrainzBodyFailed")<{
  cause: unknown;
}> {}

class ListenBrainzRejected extends Data.TaggedError("ListenBrainzRejected")<{ status: number }> {}

class ListenBrainzUnreachable extends Data.TaggedError("ListenBrainzUnreachable")<{
  cause: unknown;
}> {}

type ListenBrainzFailure = ListenBrainzBodyFailed | ListenBrainzRejected | ListenBrainzUnreachable;

function listenbrainzExchange(endpoint: string, payload: unknown) {
  let readingBody = false;
  const unreachable = (cause: unknown) =>
    readingBody ? new ListenBrainzBodyFailed({ cause }) : new ListenBrainzUnreachable({ cause });

  return Effect.tryPromise({
    catch: unreachable,
    try: async (signal) => {
      const response = await fetch(endpoint, {
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": MB_USER_AGENT,
        },
        method: "POST",
        signal,
      });

      if (!response.ok) {
        return { read: false as const, response };
      }

      readingBody = true;

      return { data: (await response.json()) as unknown, read: true as const, response };
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: LISTENBRAINZ_REQUEST_TIMEOUT,
      orElse: () => Effect.fail(unreachable(new Error("ListenBrainz request timed out"))),
    }),
  );
}

function listenbrainzMbidLookup(
  clean: string,
): Effect.Effect<ListenBrainzLookupResult, ListenBrainzFailure> {
  return Effect.gen(function* () {
    const exchange = yield* listenbrainzExchange(LISTENBRAINZ_MBID_ENDPOINT, [
      { recording_mbid: clean },
    ]);
    const { response } = exchange;

    if (!exchange.read) {
      return yield* new ListenBrainzRejected({ status: response.status });
    }

    const body = exchange.data;

    if (!Array.isArray(body)) {
      yield* Effect.logWarning("listenbrainz.non-array-body").pipe(
        Effect.annotateLogs({ recordingMbid: clean }),
      );

      return { outcome: "non-array-body" } satisfies ListenBrainzLookupResult;
    }

    const item = body.find((entry): entry is ListenBrainzResponseItem => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }

      const candidate = entry as ListenBrainzResponseItem;

      return (candidate.recording_mbid ?? clean) === clean;
    });

    if (!item) {
      return { outcome: "no-map" } satisfies ListenBrainzLookupResult;
    }

    const spotifyTrackIds = (Array.isArray(item.spotify_track_ids) ? item.spotify_track_ids : [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (spotifyTrackIds.length === 0) {
      return { outcome: "empty-ids" } satisfies ListenBrainzLookupResult;
    }

    return {
      match: {
        artistName: item.artist_name ?? null,
        recordingMbid: clean,
        spotifyTrackIds,
        trackName: item.track_name ?? null,
      },
      outcome: "match",
    } satisfies ListenBrainzLookupResult;
  });
}

export async function lookupSpotifyIdsByMbid(
  recordingMbid: string,
): Promise<ListenBrainzLookupResult> {
  const clean = recordingMbid.trim();

  if (!clean) {
    return { outcome: "invalid-mbid" };
  }

  return runServerEffect(
    listenbrainzMbidLookup(clean).pipe(
      Effect.catchTags({
        ListenBrainzBodyFailed: (error) =>
          Effect.logWarning("listenbrainz.malformed-body").pipe(
            Effect.annotateLogs({ error: error.cause, recordingMbid: clean }),
            Effect.as<ListenBrainzLookupResult>({ outcome: "malformed-body" }),
          ),
        ListenBrainzRejected: (error) =>
          Effect.logWarning("listenbrainz.request-failed").pipe(
            Effect.annotateLogs({ recordingMbid: clean, status: error.status }),
            Effect.as<ListenBrainzLookupResult>({ outcome: "request-failed" }),
          ),
        ListenBrainzUnreachable: (error) =>
          Effect.logWarning("listenbrainz.request-threw").pipe(
            Effect.annotateLogs({ error: error.cause, recordingMbid: clean }),
            Effect.as<ListenBrainzLookupResult>({ outcome: "request-threw" }),
          ),
      }),
    ),
  );
}

function listenbrainzMetadataLookup(
  artistName: string,
  releaseName: string,
  trackName: string,
): Effect.Effect<ListenBrainzLookupResult, ListenBrainzFailure> {
  return Effect.gen(function* () {
    const exchange = yield* listenbrainzExchange(LISTENBRAINZ_METADATA_ENDPOINT, [
      { artist_name: artistName, release_name: releaseName, track_name: trackName },
    ]);
    const { response } = exchange;

    if (!exchange.read) {
      return yield* new ListenBrainzRejected({ status: response.status });
    }

    const body = exchange.data;

    if (!Array.isArray(body)) {
      return { outcome: "non-array-body" } satisfies ListenBrainzLookupResult;
    }

    const item = body.find(
      (entry): entry is ListenBrainzResponseItem =>
        typeof entry === "object" && entry !== null && Array.isArray(entry.spotify_track_ids),
    );

    if (!item) {
      return { outcome: "no-map" } satisfies ListenBrainzLookupResult;
    }

    const spotifyTrackIds = (item.spotify_track_ids ?? [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean);

    if (spotifyTrackIds.length === 0) {
      return { outcome: "empty-ids" } satisfies ListenBrainzLookupResult;
    }

    return {
      match: {
        artistName: item.artist_name ?? null,
        recordingMbid: "",
        spotifyTrackIds,
        trackName: item.track_name ?? null,
      },
      outcome: "match",
    } satisfies ListenBrainzLookupResult;
  });
}

export async function lookupSpotifyIdsByMetadata(
  artistName: string,
  releaseName: string,
  trackName: string,
): Promise<ListenBrainzLookupResult> {
  if (!artistName.trim() || !trackName.trim()) {
    return { outcome: "no-map" };
  }

  return runServerEffect(
    listenbrainzMetadataLookup(artistName, releaseName, trackName).pipe(
      Effect.catchTags({
        ListenBrainzBodyFailed: () =>
          Effect.succeed<ListenBrainzLookupResult>({ outcome: "malformed-body" }),
        ListenBrainzRejected: () =>
          Effect.succeed<ListenBrainzLookupResult>({ outcome: "request-failed" }),
        ListenBrainzUnreachable: (error) =>
          Effect.logWarning("listenbrainz.metadata-request-threw").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<ListenBrainzLookupResult>({ outcome: "request-threw" }),
          ),
      }),
    ),
  );
}

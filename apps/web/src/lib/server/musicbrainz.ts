import { Duration, Effect, Schedule, Schema } from "effect";
import { runServerEffect } from "./effect/runtime";
import { makeSpacedQueue } from "./effect/spaced-queue";

export const MUSICBRAINZ_API_HOST = "musicbrainz.org";
const MUSICBRAINZ_API_ROOT = `https://${MUSICBRAINZ_API_HOST}/ws/2`;

export function musicbrainzUrl(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${MUSICBRAINZ_API_ROOT}${path}${separator}fmt=json`;
}

export const MB_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const MB_REQUEST_TIMEOUT = Duration.seconds(15);

let rateLimitIntervalMs = 1100;

export function setMusicbrainzRateLimitForTests(ms: number): void {
  rateLimitIntervalMs = ms;
}

const queue = makeSpacedQueue(() => rateLimitIntervalMs);

class MusicbrainzUnreachable extends Schema.TaggedError<MusicbrainzUnreachable>()(
  "MusicbrainzUnreachable",
  { cause: Schema.Defect() },
) {}

class MusicbrainzUnavailable extends Schema.TaggedError<MusicbrainzUnavailable>()(
  "MusicbrainzUnavailable",
  { retryAfterSeconds: Schema.Finite, status: Schema.Finite },
) {}

class MusicbrainzRejected extends Schema.TaggedError<MusicbrainzRejected>()("MusicbrainzRejected", {
  status: Schema.Finite,
  statusText: Schema.String,
}) {}

export type MbResult<T> = { data: T | null; rateLimited: boolean; status?: number };

export type MbRequestContext = {
  nodeKind: "artist" | "label" | "release";
  requestKind: "artist_browse" | "label_browse" | "rearm_probe" | "release_detail" | "seed_search";
};

const MAX_503_RETRIES = 2;

function mbRequest<T>(path: string, context?: MbRequestContext): Effect.Effect<MbResult<T>> {
  const url = musicbrainzUrl(path);
  const record = (outcome: string): Effect.Effect<void> =>
    context
      ? Effect.logInfo("crawl.musicbrainz-request").pipe(
          Effect.annotateLogs({ ...context, outcome, source: "worker" }),
        )
      : Effect.void;

  const attempt = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      catch: (cause) => new MusicbrainzUnreachable({ cause }),
      try: (signal) => fetch(url, { headers: { "User-Agent": MB_USER_AGENT }, signal }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: MB_REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new MusicbrainzUnreachable({ cause: "timeout" })),
      }),
    );

    if (response.status === 503) {
      return yield* new MusicbrainzUnavailable({
        retryAfterSeconds: Number(response.headers.get("Retry-After")) || 2,
        status: response.status,
      });
    }

    if (!response.ok) {
      return yield* new MusicbrainzRejected({
        status: response.status,
        statusText: response.statusText,
      });
    }

    const data = yield* Effect.tryPromise(() => response.json() as Promise<T>).pipe(
      Effect.tapError(() => record("invalid")),
      Effect.orDie,
    );
    yield* record("body");

    return { data, rateLimited: false, status: response.status } satisfies MbResult<T>;
  });

  const retryOn503 = Schedule.recurs(MAX_503_RETRIES).pipe(
    Schedule.setInputType<MusicbrainzUnavailable | MusicbrainzRejected | MusicbrainzUnreachable>(),
    Schedule.while(({ input }) => input._tag === "MusicbrainzUnavailable"),
    Schedule.modifyDelay(({ input }) =>
      Effect.succeed(
        rateLimitIntervalMs === 0 || input._tag !== "MusicbrainzUnavailable"
          ? Duration.zero
          : Duration.seconds(input.retryAfterSeconds),
      ),
    ),
    Schedule.tap(({ attempt: retry, input, now }) =>
      input._tag === "MusicbrainzUnavailable"
        ? Effect.gen(function* () {
            yield* record("retry_503");
            yield* Effect.logWarning("musicbrainz.retry").pipe(
              Effect.annotateLogs({
                attempt: retry,
                path,
                retryAfterSeconds: input.retryAfterSeconds,
                status: input.status,
              }),
            );

            if (rateLimitIntervalMs !== 0) {
              yield* queue.deferUntil(now + input.retryAfterSeconds * 1000);
            }
          })
        : Effect.void,
    ),
  );

  return queue.run(
    attempt.pipe(
      Effect.retry(retryOn503),
      Effect.catchTags({
        MusicbrainzRejected: (error) =>
          record(`http_${error.status}`).pipe(
            Effect.andThen(
              Effect.logWarning("musicbrainz.request-failed").pipe(
                Effect.annotateLogs({ path, status: error.status, statusText: error.statusText }),
              ),
            ),
            Effect.as<MbResult<T>>({ data: null, rateLimited: false, status: error.status }),
          ),
        MusicbrainzUnavailable: (error) =>
          record("throttled").pipe(
            Effect.as<MbResult<T>>({ data: null, rateLimited: true, status: error.status }),
          ),
        MusicbrainzUnreachable: (error) =>
          record("network_error").pipe(
            Effect.andThen(
              Effect.logWarning("musicbrainz.request-threw").pipe(
                Effect.annotateLogs({ error: error.cause, path }),
              ),
            ),
            Effect.as<MbResult<T>>({ data: null, rateLimited: false }),
          ),
      }),
    ),
  );
}

export function mbFetch<T>(path: string, context?: MbRequestContext): Promise<MbResult<T>> {
  return runServerEffect(mbRequest<T>(path, context));
}

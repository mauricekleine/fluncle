import { env } from "cloudflare:workers";
import { Data, Duration, Effect } from "effect";
import { videoPurgeUrls } from "../media";
import { clipPurgeUrls } from "../studio-clips";
import { runServerEffect } from "./effect/runtime";
import { keepAlive } from "./effect/wait-until";

const CLOUDFLARE_PURGE_MAX_FILES = 30;
const PURGE_TIMEOUT = Duration.seconds(15);

class VideoCachePurgeFailed extends Data.TaggedError("VideoCachePurgeFailed")<{
  cause: unknown;
}> {}

export function purgeVideoCache(
  logId: string | null | undefined,
  squared: boolean,
  version?: number,
): void {
  if (!logId?.trim()) {
    return;
  }

  void runServerEffect(
    keepAlive(
      "video-cache.purge-error",
      purgeFiles(logId.trim(), videoPurgeUrls(logId.trim(), { squared, version })),
    ),
  );
}

export function purgeClipCache(clipId: string | null | undefined, version?: number): void {
  if (!clipId?.trim()) {
    return;
  }

  void runServerEffect(
    keepAlive(
      "video-cache.purge-error",
      purgeFiles(clipId.trim(), clipPurgeUrls(clipId.trim(), version)),
    ),
  );
}

function purgeFiles(label: string, files: string[]): Effect.Effect<void> {
  return Effect.gen(function* () {
    const zoneId = readPurgeBinding("CF_CACHE_PURGE_ZONE_ID");
    const token = readPurgeBinding("CF_CACHE_PURGE_TOKEN");

    if (!zoneId || !token) {
      yield* Effect.logWarning("video-cache.purge-skipped-no-token").pipe(
        Effect.annotateLogs({ label }),
      );

      return;
    }

    for (let i = 0; i < files.length; i += CLOUDFLARE_PURGE_MAX_FILES) {
      const chunk = files.slice(i, i + CLOUDFLARE_PURGE_MAX_FILES);

      yield* Effect.tryPromise({
        catch: (cause) => new VideoCachePurgeFailed({ cause }),
        try: (signal) =>
          fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
            body: JSON.stringify({ files: chunk }),
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            method: "POST",
            signal,
          }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: PURGE_TIMEOUT,
          orElse: () => Effect.fail(new VideoCachePurgeFailed({ cause: "timeout" })),
        }),
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.logWarning("video-cache.purge-request-failed").pipe(
                Effect.annotateLogs({ label, status: response.status, urlCount: chunk.length }),
              ),
        ),
        Effect.catchTag("VideoCachePurgeFailed", (error) =>
          Effect.logWarning("video-cache.purge-error").pipe(
            Effect.annotateLogs({ error: error.cause, label }),
          ),
        ),
      );
    }
  });
}

function readPurgeBinding(
  key: "CF_CACHE_PURGE_ZONE_ID" | "CF_CACHE_PURGE_TOKEN",
): string | undefined {
  const value = (env as unknown as Record<string, string | undefined>)[key];

  return value?.trim() ? value : undefined;
}

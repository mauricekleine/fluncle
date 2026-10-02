import { Data, Duration, Effect } from "effect";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { type EntityCacheKind, entityPurgeUrl } from "./edge-cache";
import { getTrackEntityPurgeTargets } from "./entity-cache-purge";
import { runServerEffect } from "./effect/runtime";
import { keepAlive } from "./effect/wait-until";

export const INDEXNOW_KEY = "8337c1b41068549f248bf56f1fc465df";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

const INDEXNOW_TIMEOUT = Duration.seconds(15);

class IndexNowFailed extends Data.TaggedError("IndexNowFailed")<{
  cause: unknown;
}> {}

const INDEXNOW_HOST = new URL(siteUrl).host;

type IndexNowPayload = {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
};

export function buildIndexNowPayload(urlList: string[]): IndexNowPayload {
  return {
    host: INDEXNOW_HOST,
    key: INDEXNOW_KEY,
    keyLocation: `${siteUrl}/${INDEXNOW_KEY}.txt`,
    urlList,
  };
}

export function buildFindingIndexNowUrls(
  logId: string,
  entityTargets: { kind: EntityCacheKind; slug: string }[],
): string[] {
  return [
    ...new Set([
      logPageUrl(logId),
      ...entityTargets.map((target) => entityPurgeUrl(target.kind, target.slug)),
      `${siteUrl}/fresh`,
    ]),
  ];
}

export function submitFindingToIndexNow(logId?: string, trackId?: string): void {
  if (!logId?.trim()) {
    return;
  }

  const entityTargets = trackId?.trim()
    ? getTrackEntityPurgeTargets(trackId.trim())
    : Promise.resolve([]);

  void runServerEffect(
    keepAlive(
      "indexnow.submit-failed",
      Effect.tryPromise({
        catch: (cause) => new IndexNowFailed({ cause }),
        try: () => entityTargets,
      }).pipe(
        Effect.flatMap((targets) =>
          Effect.tryPromise({
            catch: (cause) => new IndexNowFailed({ cause }),
            try: (signal) =>
              fetch(INDEXNOW_ENDPOINT, {
                body: JSON.stringify(
                  buildIndexNowPayload(buildFindingIndexNowUrls(logId.trim(), targets)),
                ),
                headers: { "Content-Type": "application/json; charset=utf-8" },
                method: "POST",
                signal,
              }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: INDEXNOW_TIMEOUT,
              orElse: () => Effect.fail(new IndexNowFailed({ cause: "timeout" })),
            }),
            Effect.asVoid,
          ),
        ),
      ),
    ),
  );
}

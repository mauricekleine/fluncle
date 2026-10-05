import { Data, Duration, Effect } from "effect";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { type EntityCacheKind, entityPurgeUrl } from "./edge-cache";
import { getTrackEntityPurgeTargets } from "./entity-cache-purge";
import { runServerEffect } from "./effect/runtime";
import { keepAlive } from "./effect/wait-until";

export const INDEXNOW_KEY = "8337c1b41068549f248bf56f1fc465df";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

const INDEXNOW_TIMEOUT = Duration.seconds(15);

export class IndexNowFailed extends Data.TaggedError("IndexNowFailed")<{
  cause: unknown;
  due?: number;
  excerpt?: string;
  status?: number;
  submitted?: number;
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

async function responseExcerpt(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let remaining = 512;
  let excerpt = "";
  try {
    while (remaining > 0) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = chunk.value.subarray(0, remaining);
      excerpt += decoder.decode(bytes, { stream: true });
      remaining -= bytes.byteLength;
    }
    return (excerpt + decoder.decode()).replace(/\s+/g, " ").trim().slice(0, 512);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const requestIndexNow = Effect.fnUntraced(function* (urls: string[]) {
  let status: number | undefined;
  return yield* Effect.tryPromise({
    catch: (cause) => (cause instanceof IndexNowFailed ? cause : new IndexNowFailed({ cause })),
    try: async (signal) => {
      const response = await fetch(INDEXNOW_ENDPOINT, {
        body: JSON.stringify(buildIndexNowPayload(urls)),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
        signal,
      });
      status = response.status;
      if (response.status !== 200 && response.status !== 202) {
        const excerpt = await responseExcerpt(response).catch(() => "response body unavailable");
        throw new IndexNowFailed({
          cause: `IndexNow rejected submission: HTTP ${response.status} ${excerpt}`,
          excerpt,
          status: response.status,
        });
      }
      void response.body?.cancel().catch(() => {});
      return response.status;
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: INDEXNOW_TIMEOUT,
      orElse: () => Effect.fail(new IndexNowFailed({ cause: "timeout", status })),
    }),
  );
});

export function submitIndexNowUrls(urls: string[]): Promise<number> {
  return runServerEffect(requestIndexNow(urls));
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
          requestIndexNow(buildFindingIndexNowUrls(logId.trim(), targets)),
        ),
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logError("indexnow.submit-failed").pipe(
            Effect.annotateLogs({
              cause: String(error.cause),
              excerpt: error.excerpt ?? "",
              status: error.status ?? null,
            }),
          ),
        ),
      ),
    ),
  );
}

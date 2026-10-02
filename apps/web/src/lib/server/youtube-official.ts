import { Data, Effect } from "effect";
import { runServerEffect } from "./effect/runtime";
import { fold } from "./track-match";

export type YoutubeOfficialVerdict = 0 | 1 | null;

const TOPIC_CHANNEL_MARKER = /-\s*topic\s*$/i;

export function isTopicChannel(authorName: string): boolean {
  return TOPIC_CHANNEL_MARKER.test(authorName.trim());
}

export type RecordingNames = {
  artists: readonly string[];

  labels?: readonly string[];
};

export function isOfficialAuthor(authorName: string, names: RecordingNames): boolean {
  const author = authorName.trim();

  if (!author) {
    return false;
  }

  if (isTopicChannel(author)) {
    return true;
  }

  const foldedAuthor = fold(author);

  if (!foldedAuthor) {
    return false;
  }

  return [...names.artists, ...(names.labels ?? [])].some((name) => {
    const foldedName = fold(name);

    return foldedName.length > 0 && foldedName === foldedAuthor;
  });
}

type OEmbedResponse = { author_name?: unknown };

const OEMBED_TIMEOUT_MS = 5_000;

class YoutubeOfficialTimeout extends Data.TaggedError("YoutubeOfficialTimeout")<{}> {}

class YoutubeOfficialHttpError extends Data.TaggedError("YoutubeOfficialHttpError")<{
  status: number;
}> {}

class YoutubeOfficialParseError extends Data.TaggedError("YoutubeOfficialParseError")<{
  cause: unknown;
}> {}

class YoutubeOfficialNetworkError extends Data.TaggedError("YoutubeOfficialNetworkError")<{
  cause: unknown;
}> {}

export async function checkYoutubeOfficial(
  videoId: string,
  names: RecordingNames,

  fetchImpl: typeof fetch = fetch,
): Promise<YoutubeOfficialVerdict> {
  const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;

  let readingBody = false;

  return runServerEffect(
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof YoutubeOfficialHttpError || cause instanceof YoutubeOfficialParseError
          ? cause
          : readingBody
            ? new YoutubeOfficialParseError({ cause })
            : new YoutubeOfficialNetworkError({ cause }),
      try: async (signal): Promise<YoutubeOfficialVerdict> => {
        const response = await fetchImpl(url, { signal });

        if (!response.ok) {
          throw new YoutubeOfficialHttpError({ status: response.status });
        }

        readingBody = true;
        const body = (await response.json()) as OEmbedResponse | null | undefined;
        const authorName = typeof body?.author_name === "string" ? body.author_name : "";

        if (!authorName.trim()) {
          throw new YoutubeOfficialParseError({ cause: "missing author_name" });
        }

        return isOfficialAuthor(authorName, names) ? 1 : 0;
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: OEMBED_TIMEOUT_MS,
        orElse: () => Effect.fail(new YoutubeOfficialTimeout()),
      }),
      Effect.catch((error) =>
        Effect.logWarning("youtube.official-failed").pipe(
          Effect.annotateLogs({
            error: "cause" in error ? error.cause : error,
            failure: error._tag,
            ...(error._tag === "YoutubeOfficialHttpError" ? { status: error.status } : {}),
            videoId,
          }),
          Effect.as(null),
        ),
      ),
    ),
  );
}

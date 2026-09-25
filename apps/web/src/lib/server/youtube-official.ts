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

export async function checkYoutubeOfficial(
  videoId: string,
  names: RecordingNames,

  fetchImpl: typeof fetch = fetch,
): Promise<YoutubeOfficialVerdict> {
  const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as OEmbedResponse;
    const authorName = typeof body.author_name === "string" ? body.author_name : "";

    if (!authorName.trim()) {
      return null;
    }

    return isOfficialAuthor(authorName, names) ? 1 : 0;
  } catch {
    return null;
  }
}

import { Data, Effect } from "effect";
import { beatportSearchUrl } from "../beatport";
import { runServerEffect } from "./effect/runtime";
import { readOptionalEnv } from "./env";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const FIRECRAWL_TIMEOUT_MS = 45_000;

const MAX_CANDIDATES = 5;

export type BeatportResolveOutcome =
  | { configured: false }
  | { configured: true; ok: true; url: null | string }
  | { configured: true; error: string; ok: false };

type BeatportSearchTrack = { isrc?: null | string; track_id?: number | string };

class BeatportTimeout extends Data.TaggedError("BeatportTimeout")<{}> {}

class BeatportHttpError extends Data.TaggedError("BeatportHttpError")<{ status: number }> {}

class BeatportParseError extends Data.TaggedError("BeatportParseError")<{ cause: unknown }> {}

class BeatportNetworkError extends Data.TaggedError("BeatportNetworkError")<{ cause: unknown }> {}

function scrapeRawHtml(url: string, apiKey: string): Promise<null | string> {
  let readingBody = false;

  return runServerEffect(
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof BeatportHttpError || cause instanceof BeatportParseError
          ? cause
          : readingBody
            ? new BeatportParseError({ cause })
            : new BeatportNetworkError({ cause }),
      try: async (signal) => {
        const response = await fetch(FIRECRAWL_SCRAPE_URL, {
          body: JSON.stringify({ formats: ["rawHtml"], url }),
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          method: "POST",
          signal,
        });

        if (!response.ok) {
          throw new BeatportHttpError({ status: response.status });
        }

        readingBody = true;
        const payload = (await response.json()) as { data?: { rawHtml?: unknown } } | null;

        if (typeof payload?.data?.rawHtml !== "string") {
          throw new BeatportParseError({ cause: "missing rawHtml" });
        }

        return payload.data.rawHtml;
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: FIRECRAWL_TIMEOUT_MS,
        orElse: () => Effect.fail(new BeatportTimeout()),
      }),
      Effect.catch((error) =>
        Effect.logWarning(
          error._tag === "BeatportHttpError" ? "beatport.scrape-failed" : "beatport.scrape-error",
        ).pipe(
          Effect.annotateLogs(
            error._tag === "BeatportHttpError"
              ? { failure: error._tag, status: error.status }
              : { error: "cause" in error ? error.cause : error, failure: error._tag },
          ),
          Effect.as(null),
        ),
      ),
    ),
  );
}

export function parseSearchTracks(html: string): BeatportSearchTrack[] | null {
  const island = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);

  if (!island?.[1]) {
    return null;
  }

  try {
    const data = JSON.parse(island[1]) as {
      props?: { pageProps?: { dehydratedState?: { queries?: unknown[] } } };
    };
    const queries = data.props?.pageProps?.dehydratedState?.queries;

    if (!Array.isArray(queries)) {
      return null;
    }

    for (const query of queries) {
      const rows = (query as { state?: { data?: { tracks?: { data?: unknown } } } })?.state?.data
        ?.tracks?.data;

      if (Array.isArray(rows)) {
        return rows as BeatportSearchTrack[];
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function parseTrackLinks(html: string): Map<string, string> {
  const links = new Map<string, string>();
  const pattern = /href="(https:\/\/www\.beatport\.com\/track\/[a-z0-9%-]+\/(\d+))"/g;
  let match = pattern.exec(html);

  while (match) {
    const [, url, id] = match;

    if (url && id && !links.has(id)) {
      links.set(id, url);
    }

    match = pattern.exec(html);
  }

  return links;
}

export function pickBeatportUrl(
  html: string,
  isrc: string,
): { ok: false } | { ok: true; url: null | string } {
  const tracks = parseSearchTracks(html);

  if (tracks === null) {
    return { ok: false };
  }

  const wanted = isrc.trim().toUpperCase();

  if (!wanted) {
    return { ok: true, url: null };
  }

  const links = parseTrackLinks(html);
  const hits = tracks
    .filter((track) => (track.isrc ?? "").trim().toUpperCase() === wanted)
    .slice(0, MAX_CANDIDATES);

  for (const hit of hits) {
    const url = links.get(String(hit.track_id ?? ""));

    if (url) {
      return { ok: true, url };
    }
  }

  return { ok: true, url: null };
}

export async function resolveBeatportUrl(input: {
  artists: string[];
  isrc: string;
  title: string;
}): Promise<BeatportResolveOutcome> {
  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return { configured: false };
  }

  const isrc = input.isrc.trim();

  if (!isrc) {
    return { configured: true, ok: true, url: null };
  }

  const html = await scrapeRawHtml(beatportSearchUrl(input.artists, input.title), apiKey);

  if (html === null) {
    return { configured: true, error: "beatport search scrape failed", ok: false };
  }

  const picked = pickBeatportUrl(html, isrc);

  if (!picked.ok) {
    await runServerEffect(
      Effect.logWarning("beatport.scrape-error").pipe(
        Effect.annotateLogs({
          error: new BeatportParseError({ cause: "beatport search page shape not recognised" }),
          failure: "BeatportParseError",
        }),
      ),
    );

    return { configured: true, error: "beatport search page shape not recognised", ok: false };
  }

  return { configured: true, ok: true, url: picked.url };
}

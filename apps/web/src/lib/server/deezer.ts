import { DEEZER_CANDIDATE_LIMIT } from "@fluncle/contracts/orpc";
import { Data, Duration, Effect, Schedule } from "effect";

import { ApiError } from "./api-error";
import { runServerEffect } from "./effect/runtime";
import { canonicalizeSearchTitle, matchKey } from "./track-match";

type DeezerTrack = {
  album?: { id?: number };

  duration?: number;
  error?: unknown;
  id?: number;
  preview?: string;
  title?: string;
};

type DeezerAlbum = {
  error?: unknown;
  label?: string;
};

export type DeezerEnrichment = {
  deezerTrackId?: string;
  label?: string;
  previewUrl?: string;
};

type DeezerSearchTrack = {
  artist?: { name?: string };
  duration?: number;
  id?: number;
  isrc?: string;
  title?: string;
};

type DeezerSearchResult = {
  data?: DeezerSearchTrack[];
  error?: unknown;
};

export type DeezerIsrcCandidate = {
  artistName: string;

  deezerTrackId?: string;
  durationMs: number;
  isrc: string;
  title: string;
};

export const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const DEEZER_REQUEST_TIMEOUT = Duration.millis(10_000);
const DEEZER_SUBMISSION_SEARCH_TIMEOUT = Duration.millis(2_500);

const DEEZER_SEARCH_LIMIT = DEEZER_CANDIDATE_LIMIT;

export const DEEZER_QUOTA_ERROR_CODE = 4;

export const DEEZER_DATA_EXCEPTION_CODE = 800;

const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

class DeezerApiFailed extends Data.TaggedError("DeezerApiFailed")<{
  code: unknown;
  error: unknown;
}> {}

class DeezerBodyFailed extends Data.TaggedError("DeezerBodyFailed")<{ cause: unknown }> {}

class DeezerQuota extends Data.TaggedError("DeezerQuota")<{ error: unknown }> {}

class DeezerRejected extends Data.TaggedError("DeezerRejected")<{ status: number }> {}

class DeezerUnexpected extends Data.TaggedError("DeezerUnexpected")<{ body: unknown }> {}

class DeezerUnreachable extends Data.TaggedError("DeezerUnreachable")<{ cause: unknown }> {}

type DeezerFailure =
  | DeezerApiFailed
  | DeezerBodyFailed
  | DeezerQuota
  | DeezerRejected
  | DeezerUnexpected
  | DeezerUnreachable;

function deezerExchange(url: string, timeout: Duration.Duration) {
  let readingBody = false;
  const unreachable = (cause: unknown) =>
    readingBody ? new DeezerBodyFailed({ cause }) : new DeezerUnreachable({ cause });

  return Effect.tryPromise({
    catch: unreachable,
    try: async (signal) => {
      const response = await fetch(url, {
        headers: { "User-Agent": DEEZER_USER_AGENT },
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
      duration: timeout,
      orElse: () => Effect.fail(unreachable(new Error("Deezer request timed out"))),
    }),
  );
}

export function deezerSearchQuery(artists: string[], title: string): string | undefined {
  const collapse = (text: string) => text.replaceAll('"', " ").replace(/\s+/g, " ").trim();
  const names = artists.map(collapse).filter((artist) => artist.length > 0);
  const canonical = collapse(canonicalizeSearchTitle(title));

  if (names.length === 0 || !canonical) {
    return undefined;
  }

  return [...names, canonical].join(" ");
}

function deezerSearchCandidates(
  query: string,
): Effect.Effect<DeezerIsrcCandidate[], DeezerFailure> {
  const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`;

  return Effect.gen(function* () {
    const exchange = yield* deezerExchange(url, DEEZER_REQUEST_TIMEOUT);
    const { response } = exchange;

    if (!exchange.read) {
      return yield* new DeezerRejected({ status: response.status });
    }

    const error = (exchange.data as DeezerSearchResult).error;

    if (error) {
      const code = (error as { code?: unknown }).code;

      if (code === DEEZER_QUOTA_ERROR_CODE) {
        return yield* new DeezerQuota({ error });
      }

      return yield* new DeezerApiFailed({ code, error });
    }

    const data = (exchange.data as DeezerSearchResult).data;

    if (!Array.isArray(data)) {
      return yield* new DeezerUnexpected({ body: exchange.data });
    }

    const candidates: DeezerIsrcCandidate[] = [];

    for (const hit of data) {
      const isrc = hit.isrc?.trim() ?? "";
      const hitTitle = hit.title?.trim() ?? "";
      const artistName = hit.artist?.name?.trim() ?? "";

      if (
        !isrc ||
        !hitTitle ||
        !artistName ||
        typeof hit.duration !== "number" ||
        hit.duration <= 0
      ) {
        continue;
      }

      candidates.push({
        artistName,

        ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
        durationMs: Math.round(hit.duration * 1000),
        isrc,
        title: hitTitle,
      });
    }

    return candidates;
  });
}

function quotaRetrySchedule(retryDelaysMs: number[]) {
  const delayMs = (attempt: number) => retryDelaysMs[attempt - 1] ?? 0;

  return Schedule.recurs(retryDelaysMs.length).pipe(
    Schedule.setInputType<DeezerFailure>(),
    Schedule.while(({ input }) => input._tag === "DeezerQuota"),
    Schedule.modifyDelay(({ attempt }) => Effect.succeed(Duration.millis(delayMs(attempt)))),
  );
}

export async function searchDeezerCandidates(
  input: {
    artists: string[];
    title: string;
  },
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerIsrcCandidate[]> {
  const query = deezerSearchQuery(input.artists, input.title);

  if (!query) {
    return [];
  }

  return runServerEffect(
    deezerSearchCandidates(query).pipe(
      Effect.retry(quotaRetrySchedule(retryDelaysMs)),
      Effect.catchTags({
        DeezerApiFailed: (error) =>
          Effect.logWarning("deezer.search-api-error").pipe(
            Effect.annotateLogs({ error: error.error }),
            Effect.as<DeezerIsrcCandidate[]>([]),
          ),
        DeezerBodyFailed: (error) =>
          Effect.logWarning("deezer.search-malformed-body").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<DeezerIsrcCandidate[]>([]),
          ),
        DeezerQuota: () =>
          Effect.logWarning("deezer.search-quota-exhausted").pipe(
            Effect.annotateLogs({ attempts: retryDelaysMs.length + 1, query }),
            Effect.as<DeezerIsrcCandidate[]>([]),
          ),
        DeezerRejected: (error) =>
          Effect.logWarning("deezer.search-http-error").pipe(
            Effect.annotateLogs({ status: error.status }),
            Effect.as<DeezerIsrcCandidate[]>([]),
          ),
        DeezerUnexpected: () =>
          Effect.logWarning("deezer.search-unexpected-shape").pipe(
            Effect.as<DeezerIsrcCandidate[]>([]),
          ),
        DeezerUnreachable: (error) =>
          Effect.logWarning("deezer.search-threw").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<DeezerIsrcCandidate[]>([]),
          ),
      }),
    ),
  );
}

type DeezerTrackDetail = {
  artist?: { name?: string };
  duration?: number;
  error?: unknown;
  id?: number;
  isrc?: string;
  title?: string;
};

export type DeezerSubmissionCandidate = {
  album?: string;
  artists: string[];
  artworkUrl?: string;
  durationMs?: number;
  externalUrl: string;
  id: string;
  isrc: string;
  provider: "deezer";
  spotifyUrl: string;
  title: string;
};

function deezerSubmissionSearch(
  query: string,
  limit: number,
): Effect.Effect<DeezerSubmissionCandidate[], DeezerFailure> {
  const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${limit}`;

  return Effect.gen(function* () {
    const exchange = yield* deezerExchange(url, DEEZER_SUBMISSION_SEARCH_TIMEOUT);
    const { response } = exchange;

    if (!exchange.read) {
      return yield* new DeezerRejected({ status: response.status });
    }

    const parsed = exchange.data as {
      data?: Array<{
        album?: { cover_medium?: string; title?: string };
        artist?: { name?: string };
        duration?: number;
        id?: number;
        isrc?: string;
        link?: string;
        title?: string;
      }>;
      error?: unknown;
    } | null;

    if (!parsed || typeof parsed !== "object") {
      return yield* new DeezerUnexpected({ body: exchange.data });
    }

    if (parsed.error) {
      const code = (parsed.error as { code?: unknown }).code;

      if (code === DEEZER_QUOTA_ERROR_CODE) {
        return yield* new DeezerQuota({ error: parsed.error });
      }

      return yield* new DeezerApiFailed({ code, error: parsed.error });
    }

    if (!Array.isArray(parsed.data)) {
      return yield* new DeezerUnexpected({ body: exchange.data });
    }

    return parsed.data.flatMap((track) => {
      if (!track || typeof track !== "object") {
        return [];
      }

      const artist = track.artist?.name?.trim();
      const title = track.title?.trim();

      if (
        !Number.isSafeInteger(track.id) ||
        (track.id ?? 0) <= 0 ||
        !artist ||
        !title ||
        !track.isrc?.trim() ||
        typeof track.duration !== "number" ||
        track.duration <= 0
      ) {
        return [];
      }

      const id = String(track.id);

      return [
        {
          album: track.album?.title?.trim() || undefined,
          artists: [artist],
          artworkUrl: track.album?.cover_medium?.trim() || undefined,
          durationMs: Math.round(track.duration * 1000),
          externalUrl: track.link?.trim() || `https://www.deezer.com/track/${id}`,
          id,
          isrc: track.isrc.trim(),
          provider: "deezer" as const,
          spotifyUrl: "",
          title,
        },
      ];
    });
  });
}

export async function searchDeezerSubmissionTracks(
  query: string,
  limit: number,
): Promise<DeezerSubmissionCandidate[]> {
  return runServerEffect(
    deezerSubmissionSearch(query, limit).pipe(
      Effect.catchTags({
        DeezerApiFailed: (error) =>
          Effect.logWarning("deezer.submit-search-api-error").pipe(
            Effect.annotateLogs({ error: error.error }),
            Effect.as<DeezerSubmissionCandidate[]>([]),
          ),
        DeezerBodyFailed: (error) =>
          Effect.logWarning("deezer.submit-search-malformed-body").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<DeezerSubmissionCandidate[]>([]),
          ),
        DeezerQuota: (error) =>
          Effect.logWarning("deezer.search-quota-exhausted").pipe(
            Effect.annotateLogs({ error: error.error }),
            Effect.as<DeezerSubmissionCandidate[]>([]),
          ),
        DeezerRejected: (error) =>
          Effect.logWarning("deezer.submit-search-http-error").pipe(
            Effect.annotateLogs({ status: error.status }),
            Effect.as<DeezerSubmissionCandidate[]>([]),
          ),
        DeezerUnexpected: () =>
          Effect.logWarning("deezer.submit-search-unexpected-shape").pipe(
            Effect.as<DeezerSubmissionCandidate[]>([]),
          ),
        DeezerUnreachable: (error) =>
          Effect.logWarning("deezer.submit-search-threw").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<DeezerSubmissionCandidate[]>([]),
          ),
      }),
    ),
  );
}

function deezerSubmissionTrack(id: string) {
  const url = `https://api.deezer.com/track/${id}`;

  return Effect.gen(function* () {
    const exchange = yield* deezerExchange(url, DEEZER_REQUEST_TIMEOUT);
    const { response } = exchange;

    if (!exchange.read) {
      return yield* new DeezerRejected({ status: response.status });
    }

    const track = exchange.data as DeezerTrackDetail;

    if (!track || typeof track !== "object") {
      return yield* new DeezerUnexpected({ body: exchange.data });
    }

    if ((track.error as { code?: unknown } | undefined)?.code === DEEZER_QUOTA_ERROR_CODE) {
      return yield* new DeezerQuota({ error: track.error });
    }

    if (track.error) {
      return yield* new DeezerApiFailed({
        code: (track.error as { code?: unknown }).code,
        error: track.error,
      });
    }

    if (
      track.id !== Number(id) ||
      !track.isrc?.trim() ||
      !track.title?.trim() ||
      !track.artist?.name?.trim() ||
      typeof track.duration !== "number" ||
      track.duration <= 0
    ) {
      return undefined;
    }

    return {
      artists: [track.artist.name.trim()],
      durationMs: Math.round(track.duration * 1000),
      isrc: track.isrc.trim(),
      title: track.title.trim(),
    };
  });
}

function submissionUnavailable(): Effect.Effect<never, ApiError> {
  return Effect.fail(
    new ApiError("submission_unavailable", "I can't check Deezer right now. Try again later.", 503),
  );
}

export async function getDeezerSubmissionTrack(id: string): Promise<
  | {
      artists: string[];
      durationMs: number;
      isrc: string;
      title: string;
    }
  | undefined
> {
  if (!/^[1-9]\d*$/.test(id)) {
    return undefined;
  }

  return runServerEffect(
    deezerSubmissionTrack(id).pipe(
      Effect.catchTags({
        DeezerApiFailed: (error) =>
          Effect.logWarning("deezer.submit-track-api-error").pipe(
            Effect.annotateLogs({ error: error.error }),
            Effect.andThen(submissionUnavailable()),
          ),
        DeezerBodyFailed: (error) =>
          Effect.logWarning("deezer.submit-track-malformed-body").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.andThen(submissionUnavailable()),
          ),
        DeezerQuota: () =>
          Effect.logWarning("deezer.search-quota-exhausted").pipe(
            Effect.annotateLogs({ trackId: id }),
            Effect.andThen(submissionUnavailable()),
          ),
        DeezerRejected: (error) =>
          Effect.logWarning("deezer.submit-track-http-error").pipe(
            Effect.annotateLogs({ status: error.status }),
            Effect.andThen(submissionUnavailable()),
          ),
        DeezerUnexpected: () =>
          Effect.logWarning("deezer.submit-track-unexpected-shape").pipe(
            Effect.andThen(submissionUnavailable()),
          ),
        DeezerUnreachable: (error) =>
          Effect.logWarning("deezer.submit-track-threw").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.andThen(submissionUnavailable()),
          ),
      }),
    ),
  );
}

const DURATION_TOLERANCE_S = 4;

export async function lookupIsrcFromDeezer(input: {
  artists: string[];
  durationMs: number;
  title: string;
}): Promise<DeezerIsrcCandidate | undefined> {
  const query = deezerSearchQuery(input.artists, input.title);

  if (!query) {
    return undefined;
  }

  return runServerEffect(
    Effect.gen(function* () {
      const exchange = yield* deezerExchange(
        `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}`,
        DEEZER_REQUEST_TIMEOUT,
      );

      if (!exchange.read) {
        return yield* new DeezerRejected({ status: exchange.response.status });
      }

      const search = exchange.data as DeezerSearchResult;

      if (!search || typeof search !== "object") {
        return yield* new DeezerUnexpected({ body: exchange.data });
      }

      if (search.error) {
        return yield* new DeezerApiFailed({
          code: (search.error as { code?: unknown }).code,
          error: search.error,
        });
      }

      if (!Array.isArray(search.data)) {
        return yield* new DeezerUnexpected({ body: exchange.data });
      }

      const expectedSeconds = input.durationMs / 1000;
      const rowKey = matchKey(input.artists, input.title);
      const match = yield* Effect.try({
        catch: (body) => new DeezerUnexpected({ body }),
        try: () =>
          search.data?.find(
            (candidate) =>
              typeof candidate.id === "number" &&
              typeof candidate.duration === "number" &&
              Math.abs(candidate.duration - expectedSeconds) <= DURATION_TOLERANCE_S &&
              matchKey([candidate.artist?.name ?? ""], candidate.title ?? "") === rowKey,
          ),
      });

      if (!match?.id) {
        return undefined;
      }

      const detailExchange = yield* deezerExchange(
        `https://api.deezer.com/track/${match.id}`,
        DEEZER_REQUEST_TIMEOUT,
      );

      if (!detailExchange.read) {
        return yield* new DeezerRejected({ status: detailExchange.response.status });
      }

      const detail = detailExchange.data as DeezerTrackDetail;

      if (!detail || typeof detail !== "object") {
        return yield* new DeezerUnexpected({ body: detailExchange.data });
      }

      if (detail.error) {
        return yield* new DeezerApiFailed({
          code: (detail.error as { code?: unknown }).code,
          error: detail.error,
        });
      }

      if (typeof detail.isrc !== "string" || !detail.isrc.trim()) {
        return undefined;
      }

      return {
        artistName: match.artist?.name?.trim() ?? "",
        deezerTrackId: String(match.id),
        durationMs: Math.round((match.duration ?? 0) * 1000),
        isrc: detail.isrc.trim(),
        title: match.title?.trim() ?? "",
      };
    }).pipe(Effect.orElseSucceed(() => undefined)),
  );
}

export async function enrichFromDeezer(
  isrc: string | null | undefined,
  expectedDurationMs?: number,
): Promise<DeezerEnrichment> {
  if (!isrc?.trim()) {
    return {};
  }

  return runServerEffect(
    Effect.gen(function* () {
      const exchange = yield* deezerExchange(
        `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc.trim())}`,
        DEEZER_REQUEST_TIMEOUT,
      );

      if (!exchange.read) {
        return yield* new DeezerRejected({ status: exchange.response.status });
      }

      const track = exchange.data as DeezerTrack;

      if (!track || typeof track !== "object") {
        return yield* new DeezerUnexpected({ body: exchange.data });
      }

      if (track.error) {
        return yield* new DeezerApiFailed({
          code: (track.error as { code?: unknown }).code,
          error: track.error,
        });
      }

      if (!track.id) {
        return {};
      }

      const previewUrl = yield* Effect.try({
        catch: (body) => new DeezerUnexpected({ body }),
        try: () => (track.preview?.trim() ? track.preview : undefined),
      });
      const durationConfirmed =
        typeof expectedDurationMs === "number" &&
        expectedDurationMs > 0 &&
        typeof track.duration === "number" &&
        Math.abs(track.duration - expectedDurationMs / 1000) <= DURATION_TOLERANCE_S;
      let label: string | undefined;

      if (track.album?.id) {
        const albumExchange = yield* deezerExchange(
          `https://api.deezer.com/album/${track.album.id}`,
          DEEZER_REQUEST_TIMEOUT,
        );

        if (albumExchange.read) {
          const album = albumExchange.data as DeezerAlbum;

          if (!album || typeof album !== "object") {
            return yield* new DeezerUnexpected({ body: albumExchange.data });
          }

          label = yield* Effect.try({
            catch: (body) => new DeezerUnexpected({ body }),
            try: () => (!album.error && album.label?.trim() ? album.label.trim() : undefined),
          });
        }
      }

      return {
        ...(durationConfirmed ? { deezerTrackId: String(track.id) } : {}),
        label,
        previewUrl,
      };
    }).pipe(Effect.orElseSucceed((): DeezerEnrichment => ({}))),
  );
}

export type DeezerIsrcLookup =
  | { deezerTrackId: string; outcome: "matched" }
  | { error: string; outcome: "failed" }
  | { outcome: "absent" }
  | { outcome: "quota" }
  | { outcome: "unvouchable" };

type DeezerIsrcVerdict =
  | { deezerTrackId: string; outcome: "matched" }
  | { outcome: "absent" }
  | { outcome: "unvouchable" };

function deezerIsrcLookup(
  trimmed: string,
  expectedDurationMs: number,
): Effect.Effect<DeezerIsrcVerdict, DeezerFailure> {
  const url = `https://api.deezer.com/track/isrc:${encodeURIComponent(trimmed)}`;

  return Effect.gen(function* () {
    const exchange = yield* deezerExchange(url, DEEZER_REQUEST_TIMEOUT);
    const { response } = exchange;

    if (!exchange.read) {
      return yield* new DeezerRejected({ status: response.status });
    }

    const track = exchange.data as DeezerTrack;
    const error = track.error;

    if (error) {
      const code = (error as { code?: unknown }).code;

      if (code === DEEZER_QUOTA_ERROR_CODE) {
        return yield* new DeezerQuota({ error });
      }

      if (code === DEEZER_DATA_EXCEPTION_CODE) {
        return { outcome: "absent" } satisfies DeezerIsrcVerdict;
      }

      return yield* new DeezerApiFailed({ code, error });
    }

    if (typeof track.id !== "number") {
      return yield* new DeezerUnexpected({ body: exchange.data });
    }

    const durationConfirmed =
      typeof track.duration === "number" &&
      track.duration > 0 &&
      Math.abs(track.duration - expectedDurationMs / 1000) <= DURATION_TOLERANCE_S;

    if (!durationConfirmed) {
      return { outcome: "unvouchable" } satisfies DeezerIsrcVerdict;
    }

    return { deezerTrackId: String(track.id), outcome: "matched" } satisfies DeezerIsrcVerdict;
  });
}

export async function lookupDeezerTrackByIsrc(
  isrc: string,
  expectedDurationMs: number,
): Promise<DeezerIsrcLookup> {
  const trimmed = isrc.trim();

  if (!trimmed || !(expectedDurationMs > 0)) {
    return { outcome: "unvouchable" };
  }

  return runServerEffect(
    deezerIsrcLookup(trimmed, expectedDurationMs).pipe(
      Effect.catchTags({
        DeezerApiFailed: (error) =>
          Effect.logWarning("deezer.isrc-lookup-api-error").pipe(
            Effect.annotateLogs({ error: error.error }),
            Effect.as<DeezerIsrcLookup>({
              error: `Deezer error code ${String(error.code)}`,
              outcome: "failed",
            }),
          ),
        DeezerBodyFailed: (error) =>
          Effect.logWarning("deezer.isrc-lookup-malformed-body").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<DeezerIsrcLookup>({
              error: "Deezer sent an unparseable body",
              outcome: "failed",
            }),
          ),
        DeezerQuota: () => Effect.succeed<DeezerIsrcLookup>({ outcome: "quota" }),
        DeezerRejected: (error) =>
          Effect.logWarning("deezer.isrc-lookup-http-error").pipe(
            Effect.annotateLogs({ status: error.status }),
            Effect.as<DeezerIsrcLookup>({
              error: `Deezer answered HTTP ${error.status}`,
              outcome: "failed",
            }),
          ),
        DeezerUnexpected: () =>
          Effect.logWarning("deezer.isrc-lookup-unexpected-shape").pipe(
            Effect.as<DeezerIsrcLookup>({
              error: "Deezer sent no track id",
              outcome: "failed",
            }),
          ),
        DeezerUnreachable: (error) =>
          Effect.logWarning("deezer.isrc-lookup-threw").pipe(
            Effect.annotateLogs({ error: error.cause }),
            Effect.as<DeezerIsrcLookup>({
              error: error.cause instanceof Error ? error.cause.message : String(error.cause),
              outcome: "failed",
            }),
          ),
      }),
    ),
  );
}

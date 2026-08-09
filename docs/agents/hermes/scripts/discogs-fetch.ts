// Paced Discogs reads for the Hermes box. This module performs vendor I/O only: every candidate
// remains untrusted evidence until an agent-tier Worker operation re-reads the DB row, applies the
// existing match gate, and owns the write. It is self-contained because deployed box scripts do
// not import the monorepo workspace.

const DISCOGS_API_ROOT = "https://api.discogs.com";
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";
const MIN_REQUEST_INTERVAL_MS = 1_100;
const RELEASE_WORK_LIMIT = 3;
const SEARCH_QUERY_LIMIT = 3;
const SEARCH_RESULTS_PER_QUERY = 4;
const RELEASES_PER_TRACK_LIMIT = 12;
const FACTS_WORK_LIMIT = 25;
const LABEL_WORK_LIMIT = 4;
const TEXT_MAX = 500;
const URI_MAX = 2_048;
const QUERY_MAX = 2_048;
const IMAGE_BYTES_MAX = 5_000_000;

type DiscogsReleaseEvidence = {
  artists: Array<{ name?: string }>;
  formats: Array<{ name?: string }>;
  id: number;
  labels: Array<{ catno?: string; name?: string }>;
  masterId?: number;
  searchMasterId?: number;
  styles: string[];
  title?: string;
  tracklist: Array<{ title?: string }>;
  year?: number;
};

export type DiscogsReleaseWork = { queries: string[]; trackId: string };
export type DiscogsReleaseCandidate = { releases: DiscogsReleaseEvidence[]; trackId: string };
export type DiscogsFactsWork = { releaseId: number; slug: string };
export type DiscogsFactsCandidate = { release: DiscogsReleaseEvidence; slug: string };
export type DiscogsLabelWork = { discogsLabelId: number; slug: string };
export type DiscogsLabelCandidate = {
  detail: {
    id: number;
    images: Array<{ type?: "primary" | "secondary"; uri?: string }>;
  };
  discogsLabelId: number;
  image?: { bytesBase64: string; mime: string; uri: string };
  slug: string;
};

export type DiscogsBatchResult<T> =
  | { candidates: T[]; ok: true; rateLimited: false }
  | { candidates: []; error: string; ok: false; rateLimited: boolean };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DiscogsFetcherOptions = {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type AgentPostOptions = {
  baseUrl?: string;
  body?: unknown;
  fetch?: FetchLike;
  query?: Record<string, boolean | number | string | undefined>;
};

type RequestResult<T> =
  | { kind: "ok"; value: T }
  | { error: string; kind: "failed" }
  | { error: string; kind: "rate-limited" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function boundedText(value: unknown, max = TEXT_MAX): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function records(value: unknown, limit: number): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, limit) : [];
}

function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, limit)
        .map((entry) => entry.slice(0, TEXT_MAX))
    : [];
}

function normalizeRelease(
  value: unknown,
  searchMasterId?: number,
): DiscogsReleaseEvidence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = positiveId(value.id);

  if (id === undefined) {
    return undefined;
  }

  const masterId = positiveId(value.master_id);
  const title = boundedText(value.title);
  const year =
    typeof value.year === "number" &&
    Number.isInteger(value.year) &&
    value.year >= 1_000 &&
    value.year <= 9_999
      ? value.year
      : undefined;

  return {
    artists: records(value.artists, 20).map((artist) => {
      const name = boundedText(artist.name);
      return name === undefined ? {} : { name };
    }),
    formats: records(value.formats, 20).map((format) => {
      const name = boundedText(format.name);
      return name === undefined ? {} : { name };
    }),
    id,
    labels: records(value.labels, 20).map((label) => {
      const catno = boundedText(label.catno);
      const name = boundedText(label.name);
      return {
        ...(catno === undefined ? {} : { catno }),
        ...(name === undefined ? {} : { name }),
      };
    }),
    ...(masterId === undefined ? {} : { masterId }),
    ...(searchMasterId === undefined ? {} : { searchMasterId }),
    styles: strings(value.styles, 50),
    ...(title === undefined ? {} : { title }),
    tracklist: records(value.tracklist, 500).map((track) => {
      const trackTitle = boundedText(track.title);
      return trackTitle === undefined ? {} : { title: trackTitle };
    }),
    ...(year === undefined ? {} : { year }),
  };
}

function normalizeLabelDetail(
  value: unknown,
  expectedId: number,
): DiscogsLabelCandidate["detail"] | undefined {
  if (!isRecord(value) || positiveId(value.id) !== expectedId) {
    return undefined;
  }

  const images = records(value.images, 20).map((entry) => {
    const type = entry.type === "primary" || entry.type === "secondary" ? entry.type : undefined;
    const uri = boundedText(entry.uri, URI_MAX);
    return {
      ...(type === undefined ? {} : { type }),
      ...(uri === undefined ? {} : { uri }),
    };
  });

  return { id: expectedId, images };
}

function isDiscogsImageUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "discogs.com" || url.hostname.endsWith(".discogs.com"))
    );
  } catch {
    return false;
  }
}

function failure<T>(result: Exclude<RequestResult<T>, { kind: "ok" }>): DiscogsBatchResult<never> {
  return {
    candidates: [],
    error: result.error,
    ok: false,
    rateLimited: result.kind === "rate-limited",
  };
}

/** Call an existing agent-tier operation directly; the baked CLI need not know the new body. */
export async function postDiscogsAgentOperation<T>(
  path: string,
  apiToken: string,
  options: AgentPostOptions = {},
): Promise<T> {
  if (!apiToken.trim()) {
    throw new Error("FLUNCLE_API_TOKEN is required");
  }

  const url = new URL(
    `/api/v1${path.startsWith("/") ? path : `/${path}`}`,
    options.baseUrl ?? "https://www.fluncle.com",
  );

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await (options.fetch ?? globalThis.fetch)(url, {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method: "POST",
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Fluncle ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`Fluncle ${path} returned invalid JSON`);
  }
}

export function createDiscogsFetcher(token: string, options: DiscogsFetcherOptions = {}) {
  if (!token.trim()) {
    throw new Error("DISCOGS_USER_TOKEN is required");
  }

  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  let lastRequestAt: number | undefined;
  let stopped = false;

  async function request(pathOrUrl: string): Promise<RequestResult<Response>> {
    if (stopped) {
      return { error: "Discogs fetcher is stopped", kind: "rate-limited" };
    }

    if (lastRequestAt !== undefined) {
      const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now() - lastRequestAt));

      if (wait > 0) {
        await sleep(wait);
      }
    }

    lastRequestAt = now();

    let response: Response;

    try {
      response = await fetchFn(
        pathOrUrl.startsWith("https://") ? pathOrUrl : `${DISCOGS_API_ROOT}${pathOrUrl}`,
        {
          headers: {
            Authorization: `Discogs token=${token}`,
            "User-Agent": USER_AGENT,
          },
        },
      );
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        kind: "failed",
      };
    }

    const remainingHeader = response.headers.get("X-Discogs-Ratelimit-Remaining");
    const remaining = remainingHeader === null ? undefined : Number(remainingHeader);

    if (
      response.status === 429 ||
      (remaining !== undefined && Number.isFinite(remaining) && remaining <= 1)
    ) {
      stopped = true;
      return { error: "Discogs rate limit reached", kind: "rate-limited" };
    }

    if (!response.ok) {
      return { error: `Discogs returned HTTP ${response.status}`, kind: "failed" };
    }

    return { kind: "ok", value: response };
  }

  async function requestJson(path: string): Promise<RequestResult<unknown>> {
    const result = await request(path);

    if (result.kind !== "ok") {
      return result;
    }

    try {
      return { kind: "ok", value: await result.value.json() };
    } catch {
      return { error: "Discogs returned invalid JSON", kind: "failed" };
    }
  }

  async function fetchReleaseCandidates(
    work: DiscogsReleaseWork[],
  ): Promise<DiscogsBatchResult<DiscogsReleaseCandidate>> {
    if (work.length > RELEASE_WORK_LIMIT) {
      return {
        candidates: [],
        error: "Discogs release work exceeds its cap",
        ok: false,
        rateLimited: false,
      };
    }

    const candidates: DiscogsReleaseCandidate[] = [];

    for (const row of work) {
      if (
        !row.trackId ||
        row.trackId.length > TEXT_MAX ||
        row.queries.length > SEARCH_QUERY_LIMIT
      ) {
        return {
          candidates: [],
          error: "Invalid Discogs release work",
          ok: false,
          rateLimited: false,
        };
      }

      const releaseIds = new Map<number, number | undefined>();

      for (const query of row.queries) {
        if (!query || query.length > QUERY_MAX) {
          return {
            candidates: [],
            error: "Invalid Discogs search query",
            ok: false,
            rateLimited: false,
          };
        }

        const result = await requestJson(`/database/search?${query}`);

        if (result.kind !== "ok") {
          return failure(result);
        }

        const hits = isRecord(result.value)
          ? records(result.value.results, SEARCH_RESULTS_PER_QUERY)
          : [];

        for (const hit of hits) {
          const id = positiveId(hit.id);

          if (
            id !== undefined &&
            !releaseIds.has(id) &&
            releaseIds.size < RELEASES_PER_TRACK_LIMIT
          ) {
            releaseIds.set(id, positiveId(hit.master_id));
          }
        }
      }

      const releases: DiscogsReleaseEvidence[] = [];

      for (const [releaseId, searchMasterId] of releaseIds) {
        const result = await requestJson(`/releases/${releaseId}`);

        if (result.kind !== "ok") {
          return failure(result);
        }

        const release = normalizeRelease(result.value, searchMasterId);

        if (release !== undefined) {
          releases.push(release);
        }
      }

      // Empty is deliberately explicit: it proves this row completed cleanly. A failed batch
      // returns no candidates at all, so the Worker cannot confuse an interrupted fetch with zero.
      candidates.push({ releases, trackId: row.trackId });
    }

    return { candidates, ok: true, rateLimited: false };
  }

  async function fetchFactsCandidates(
    work: DiscogsFactsWork[],
  ): Promise<DiscogsBatchResult<DiscogsFactsCandidate>> {
    if (work.length > FACTS_WORK_LIMIT) {
      return {
        candidates: [],
        error: "Discogs facts work exceeds its cap",
        ok: false,
        rateLimited: false,
      };
    }

    const candidates: DiscogsFactsCandidate[] = [];

    for (const row of work) {
      if (!row.slug || row.slug.length > TEXT_MAX || positiveId(row.releaseId) === undefined) {
        return {
          candidates: [],
          error: "Invalid Discogs facts work",
          ok: false,
          rateLimited: false,
        };
      }

      const result = await requestJson(`/releases/${row.releaseId}`);

      if (result.kind !== "ok") {
        return failure(result);
      }

      const release = normalizeRelease(result.value);

      if (release === undefined) {
        return {
          candidates: [],
          error: "Discogs returned an invalid release",
          ok: false,
          rateLimited: false,
        };
      }

      candidates.push({ release, slug: row.slug });
    }

    return { candidates, ok: true, rateLimited: false };
  }

  async function fetchLabelCandidates(
    work: DiscogsLabelWork[],
  ): Promise<DiscogsBatchResult<DiscogsLabelCandidate>> {
    if (work.length > LABEL_WORK_LIMIT) {
      return {
        candidates: [],
        error: "Discogs label work exceeds its cap",
        ok: false,
        rateLimited: false,
      };
    }

    const candidates: DiscogsLabelCandidate[] = [];

    for (const row of work) {
      if (!row.slug || row.slug.length > TEXT_MAX || positiveId(row.discogsLabelId) === undefined) {
        return {
          candidates: [],
          error: "Invalid Discogs label work",
          ok: false,
          rateLimited: false,
        };
      }

      const detailResult = await requestJson(`/labels/${row.discogsLabelId}`);

      if (detailResult.kind !== "ok") {
        return failure(detailResult);
      }

      const detail = normalizeLabelDetail(detailResult.value, row.discogsLabelId);

      if (detail === undefined) {
        return {
          candidates: [],
          error: "Discogs returned an invalid label",
          ok: false,
          rateLimited: false,
        };
      }

      const selected =
        detail.images.find((image) => image.type === "primary" && image.uri)?.uri ??
        detail.images.find((image) => image.uri)?.uri;
      let image: DiscogsLabelCandidate["image"];

      if (selected !== undefined) {
        if (!isDiscogsImageUri(selected)) {
          return {
            candidates: [],
            error: "Discogs returned an invalid image URI",
            ok: false,
            rateLimited: false,
          };
        }

        const imageResult = await request(selected);

        if (imageResult.kind !== "ok") {
          return failure(imageResult);
        }

        const mime = imageResult.value.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        const declaredLength = Number(imageResult.value.headers.get("content-length"));

        if (!mime?.startsWith("image/")) {
          return {
            candidates: [],
            error: "Discogs image response was not an image",
            ok: false,
            rateLimited: false,
          };
        }

        if (Number.isFinite(declaredLength) && declaredLength > IMAGE_BYTES_MAX) {
          return {
            candidates: [],
            error: "Discogs image exceeds 5 MB",
            ok: false,
            rateLimited: false,
          };
        }

        const bytes = new Uint8Array(await imageResult.value.arrayBuffer());

        if (bytes.length === 0 || bytes.length > IMAGE_BYTES_MAX) {
          return {
            candidates: [],
            error: "Discogs image exceeds the allowed byte range",
            ok: false,
            rateLimited: false,
          };
        }

        image = { bytesBase64: Buffer.from(bytes).toString("base64"), mime, uri: selected };
      }

      candidates.push({
        detail,
        discogsLabelId: row.discogsLabelId,
        ...(image === undefined ? {} : { image }),
        slug: row.slug,
      });
    }

    return { candidates, ok: true, rateLimited: false };
  }

  return { fetchFactsCandidates, fetchLabelCandidates, fetchReleaseCandidates };
}

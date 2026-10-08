import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Schedule } from "effect";
import { deadlineSignal, noteProgress } from "./deadline";

export type EvidenceSource = "apple" | "beatport" | "discogs" | "musicbrainz";

export type SourcePolicy = {
  attempts: number;
  intervalMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
};

export const SOURCE_POLICIES: Record<EvidenceSource, SourcePolicy> = {
  apple: { attempts: 3, intervalMs: 3_000, maxBackoffMs: 30_000, timeoutMs: 10_000 },
  beatport: { attempts: 2, intervalMs: 1_000, maxBackoffMs: 30_000, timeoutMs: 75_000 },
  discogs: { attempts: 3, intervalMs: 2_500, maxBackoffMs: 30_000, timeoutMs: 15_000 },
  musicbrainz: { attempts: 4, intervalMs: 1_100, maxBackoffMs: 30_000, timeoutMs: 20_000 },
};

export const EVIDENCE_USER_AGENT = "FluncleLabelTriage/1.0 ( https://www.fluncle.com )";

export type EvidenceFailureKind =
  | "http"
  | "invalid"
  | "network"
  | "not_found"
  | "rate_limited"
  | "timeout";

export class EvidenceFetchError extends Data.TaggedError("EvidenceFetchError")<{
  attempts: number;
  kind: EvidenceFailureKind;
  message: string;
  status?: number;
}> {
  constructor(kind: EvidenceFailureKind, message: string, attempts: number, status?: number) {
    super({ attempts, kind, message, status });
    this.name = "EvidenceFetchError";
  }
}

class EvidenceRetryable extends Data.TaggedError("EvidenceRetryable")<{
  failure: EvidenceFetchError;
  retryAfterMs: null | number;
}> {}

class EvidencePerformError extends Data.TaggedError("EvidencePerformError")<{
  cause: unknown;
}> {}

export type RawResponse = {
  headers: { get(name: string): null | string };
  status: number;
  text: string;
};

export type EvidenceFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Perform = (signal: AbortSignal) => Promise<RawResponse>;

export type EvidenceHttp = {
  cacheDir: string;
  cacheTtlMs: number;
  deadline: null | number;
  fetch: EvidenceFetch;
  now: () => number;
  policies: Record<EvidenceSource, SourcePolicy>;
  progress: (note: string) => void;
  random: () => number;
  refresh: boolean;
  sleep: (ms: number) => Promise<void>;
  stats: { cacheHits: number; requests: number };
};

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");

  return join(base, "fluncle", "label-evidence");
}

export function createEvidenceHttp(overrides: Partial<EvidenceHttp> = {}): EvidenceHttp {
  return {
    cacheDir: defaultCacheDir(),
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    deadline: null,
    fetch: (url, init) => globalThis.fetch(url, init),
    now: () => Date.now(),
    policies: SOURCE_POLICIES,
    progress: noteProgress,
    random: Math.random,
    refresh: false,
    sleep: (ms) => Effect.runPromise(Effect.sleep(ms)),
    stats: { cacheHits: 0, requests: 0 },
    ...overrides,
  };
}

function cachePath(http: EvidenceHttp, source: EvidenceSource, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");

  return join(http.cacheDir, source, `${digest}.json`);
}

async function readCache(
  http: EvidenceHttp,
  source: EvidenceSource,
  key: string,
): Promise<null | string> {
  if (http.refresh) {
    return null;
  }

  try {
    const entry = JSON.parse(await readFile(cachePath(http, source, key), "utf8")) as {
      fetchedAt: number;
      key: string;
      text: string;
    };

    if (entry.key !== key || http.now() - entry.fetchedAt > http.cacheTtlMs) {
      return null;
    }

    return entry.text;
  } catch {
    return null;
  }
}

async function writeCache(
  http: EvidenceHttp,
  source: EvidenceSource,
  key: string,
  text: string,
): Promise<void> {
  const path = cachePath(http, source, key);
  const temp = `${path}.${process.pid}.${Math.floor(http.random() * 1e9)}.tmp`;

  try {
    await mkdir(join(http.cacheDir, source), { recursive: true });
    await writeFile(temp, JSON.stringify({ fetchedAt: http.now(), key, text }));
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

const LOCK_STALE_MS = 10_000;

async function withSlotLock<T>(
  http: EvidenceHttp,
  source: EvidenceSource,
  critical: (slotFile: string) => Promise<T>,
): Promise<T> {
  const dir = join(http.cacheDir, "slots");
  await mkdir(dir, { recursive: true });
  const lock = join(dir, `${source}.lock`);

  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const held = await stat(lock).catch(() => null);

      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        const evicted = `${lock}.stale.${process.pid}.${Math.floor(Math.random() * 1e9)}`;
        const won = await rename(lock, evicted).then(
          () => true,
          () => false,
        );

        if (won) {
          await rm(evicted, { force: true, recursive: true });
        }

        continue;
      }

      await Effect.runPromise(Effect.sleep(15 + Math.floor(Math.random() * 35)));
    }
  }

  try {
    return await critical(join(dir, `${source}.next`));
  } finally {
    await rm(lock, { force: true, recursive: true });
  }
}

async function readNextSlot(slotFile: string): Promise<number> {
  const raw = await readFile(slotFile, "utf8").catch(() => "0");
  const value = Number(raw);

  return Number.isFinite(value) ? value : 0;
}

function seconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

export async function reserveSlot(http: EvidenceHttp, source: EvidenceSource): Promise<void> {
  const interval = http.policies[source].intervalMs;
  const slotAt = await withSlotLock(http, source, async (slotFile) => {
    const now = http.now();
    const slot = Math.max(now, await readNextSlot(slotFile));

    if (http.deadline !== null && slot >= http.deadline) {
      return new EvidenceFetchError(
        "timeout",
        `${source} queue is ${seconds(slot - now)} s long, past the deadline ${seconds(http.deadline - now)} s away; fetched responses are cached, so a later run resumes`,
        0,
      );
    }

    await writeFile(slotFile, String(slot + interval));

    return slot;
  });

  if (slotAt instanceof EvidenceFetchError) {
    throw slotAt;
  }

  const wait = slotAt - http.now();

  if (wait > 0) {
    http.progress(
      `waiting ${seconds(wait)} s for a ${source} slot behind other callers on this machine (${http.stats.requests} requests sent so far; fetched responses are cached, so a later run resumes)`,
    );
    await http.sleep(wait);
  }
}

async function pushSlotBack(
  http: EvidenceHttp,
  source: EvidenceSource,
  until: number,
): Promise<void> {
  await withSlotLock(http, source, async (slotFile) => {
    if ((await readNextSlot(slotFile)) < until) {
      await writeFile(slotFile, String(until));
    }
  });
}

export function parseRetryAfter(value: null | string, now: number): null | number {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const at = Date.parse(value);

  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

function failureKind(status: number): EvidenceFailureKind {
  if (status === 404) {
    return "not_found";
  }

  return status === 429 || status === 503 ? "rate_limited" : "http";
}

export type AcceptBody = (text: string) => boolean;

export async function fetchEvidenceText(
  http: EvidenceHttp,
  source: EvidenceSource,
  cacheKey: string,
  perform: Perform,
  accept: AcceptBody = () => true,
): Promise<{ cached: boolean; text: string }> {
  const hit = await readCache(http, source, cacheKey);

  if (hit !== null && accept(hit)) {
    http.stats.cacheHits += 1;

    return { cached: true, text: hit };
  }

  const policy = http.policies[source];
  let attempt = 0;
  const request = Effect.gen(function* () {
    attempt += 1;
    yield* Effect.tryPromise({
      catch: (error) =>
        error instanceof EvidenceFetchError ? error : new EvidencePerformError({ cause: error }),
      try: () => reserveSlot(http, source),
    });
    http.stats.requests += 1;
    http.progress(`${source} request ${http.stats.requests} in flight`);
    let returned = false;
    const response = yield* Effect.tryPromise({
      catch: (error) => {
        if (!returned) {
          return new EvidencePerformError({ cause: error });
        }

        const reason = error instanceof Error ? error.message : String(error);

        return new EvidenceRetryable({
          failure: new EvidenceFetchError(
            "network",
            `${source} request failed: ${reason}`,
            attempt,
          ),
          retryAfterMs: null,
        });
      },
      try: (signal) => {
        const pending = perform(signal);
        returned = true;

        return pending;
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: policy.timeoutMs,
        orElse: () =>
          Effect.fail(
            new EvidenceRetryable({
              failure: new EvidenceFetchError(
                "timeout",
                `${source} did not answer within ${policy.timeoutMs} ms`,
                attempt,
              ),
              retryAfterMs: null,
            }),
          ),
      }),
    );
    const success = response.status >= 200 && response.status < 300;

    if (success && accept(response.text)) {
      yield* Effect.promise(() => writeCache(http, source, cacheKey, response.text));

      return { cached: false, text: response.text };
    }

    const failure = new EvidenceFetchError(
      success ? "invalid" : failureKind(response.status),
      success
        ? `${source} answered HTTP ${response.status} with a body that is not the expected data`
        : `${source} answered HTTP ${response.status}`,
      attempt,
      response.status,
    );

    if (!success && !isRetryableStatus(response.status)) {
      return yield* failure;
    }

    const retryAfterMs = success
      ? null
      : parseRetryAfter(response.headers.get("retry-after"), http.now());

    if (retryAfterMs !== null) {
      yield* Effect.promise(() =>
        pushSlotBack(http, source, http.now() + Math.min(retryAfterMs, policy.maxBackoffMs)),
      );
    }

    if (retryAfterMs !== null && retryAfterMs > policy.maxBackoffMs) {
      return yield* new EvidenceFetchError(
        "rate_limited",
        `${source} asked to wait ${Math.ceil(retryAfterMs / 1000)} s, past the ${policy.maxBackoffMs / 1000} s limit`,
        attempt,
        response.status,
      );
    }

    return yield* new EvidenceRetryable({ failure, retryAfterMs });
  });
  const retry = Schedule.recurs(policy.attempts - 1).pipe(
    Schedule.setInputType<EvidenceFetchError | EvidencePerformError | EvidenceRetryable>(),
    Schedule.while(({ input }) => input._tag === "EvidenceRetryable"),
    Schedule.tap(({ input }) => {
      if (input._tag !== "EvidenceRetryable") {
        return Effect.void;
      }

      const backoff = Math.min(
        policy.maxBackoffMs,
        Math.max(input.retryAfterMs ?? 0, policy.intervalMs * 2 ** input.failure.attempts) +
          Math.floor(http.random() * 250),
      );

      return Effect.promise(() => http.sleep(backoff));
    }),
  );
  const exhausted = (last?: EvidenceFetchError) =>
    new EvidenceFetchError(
      last?.kind ?? "network",
      `${last?.message ?? `${source} request failed`} (gave up after ${policy.attempts} attempts)`,
      policy.attempts,
      last?.status,
    );

  return Effect.runPromise(
    policy.attempts <= 0
      ? Effect.fail(exhausted())
      : request.pipe(
          Effect.retry(retry),
          Effect.mapError((error) => {
            if (error._tag === "EvidencePerformError") {
              return error.cause;
            }

            return error._tag === "EvidenceRetryable" ? exhausted(error.failure) : error;
          }),
        ),
  );
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
}

export async function fetchEvidenceJson<T>(
  http: EvidenceHttp,
  source: EvidenceSource,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ cached: boolean; data: T }> {
  const { cached, text } = await fetchEvidenceText(
    http,
    source,
    `GET ${url}`,
    async (signal) => {
      const response = await http.fetch(url, {
        headers: { Accept: "application/json", "User-Agent": EVIDENCE_USER_AGENT, ...headers },
        signal: AbortSignal.any([signal, deadlineSignal()]),
      });

      return { headers: response.headers, status: response.status, text: await response.text() };
    },
    isJson,
  );

  return { cached, data: JSON.parse(text) as T };
}

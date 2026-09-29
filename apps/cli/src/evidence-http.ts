import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export type EvidenceFailureKind = "http" | "network" | "not_found" | "rate_limited" | "timeout";

export class EvidenceFetchError extends Error {
  readonly attempts: number;
  readonly kind: EvidenceFailureKind;
  readonly status?: number;

  constructor(kind: EvidenceFailureKind, message: string, attempts: number, status?: number) {
    super(message);
    this.name = "EvidenceFetchError";
    this.kind = kind;
    this.attempts = attempts;
    this.status = status;
  }
}

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
  fetch: EvidenceFetch;
  now: () => number;
  policies: Record<EvidenceSource, SourcePolicy>;
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
    fetch: (url, init) => globalThis.fetch(url, init),
    now: () => Date.now(),
    policies: SOURCE_POLICIES,
    random: Math.random,
    refresh: false,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
        await rm(lock, { force: true, recursive: true });
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 35)));
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

export async function reserveSlot(http: EvidenceHttp, source: EvidenceSource): Promise<void> {
  const interval = http.policies[source].intervalMs;
  const slotAt = await withSlotLock(http, source, async (slotFile) => {
    const now = http.now();
    const slot = Math.max(now, await readNextSlot(slotFile));
    await writeFile(slotFile, String(slot + interval));

    return slot;
  });
  const wait = slotAt - http.now();

  if (wait > 0) {
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

async function performWithTimeout(
  perform: Perform,
  timeoutMs: number,
): Promise<{ response: RawResponse } | { timedOut: true } | { error: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      perform(controller.signal).then(
        (response) => ({ response }),
        (error: unknown) => (controller.signal.aborted ? { timedOut: true as const } : { error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchEvidenceText(
  http: EvidenceHttp,
  source: EvidenceSource,
  cacheKey: string,
  perform: Perform,
): Promise<{ cached: boolean; text: string }> {
  const hit = await readCache(http, source, cacheKey);

  if (hit !== null) {
    http.stats.cacheHits += 1;

    return { cached: true, text: hit };
  }

  const policy = http.policies[source];
  let last: EvidenceFetchError | undefined;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    await reserveSlot(http, source);
    http.stats.requests += 1;
    const outcome = await performWithTimeout(perform, policy.timeoutMs);
    let retryAfterMs: null | number = null;

    if ("response" in outcome) {
      const { response } = outcome;

      if (response.status >= 200 && response.status < 300) {
        await writeCache(http, source, cacheKey, response.text);

        return { cached: false, text: response.text };
      }

      last = new EvidenceFetchError(
        failureKind(response.status),
        `${source} answered HTTP ${response.status}`,
        attempt,
        response.status,
      );

      if (!isRetryableStatus(response.status)) {
        throw last;
      }

      retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), http.now());
    } else if ("timedOut" in outcome) {
      last = new EvidenceFetchError(
        "timeout",
        `${source} did not answer within ${policy.timeoutMs} ms`,
        attempt,
      );
    } else {
      const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      last = new EvidenceFetchError("network", `${source} request failed: ${reason}`, attempt);
    }

    if (attempt === policy.attempts) {
      break;
    }

    const exponential = policy.intervalMs * 2 ** attempt;
    const backoff = Math.min(
      policy.maxBackoffMs,
      Math.max(retryAfterMs ?? 0, exponential) + Math.floor(http.random() * 250),
    );

    if (retryAfterMs !== null) {
      await pushSlotBack(http, source, http.now() + retryAfterMs);
    }

    await http.sleep(backoff);
  }

  throw new EvidenceFetchError(
    last?.kind ?? "network",
    `${last?.message ?? `${source} request failed`} (gave up after ${policy.attempts} attempts)`,
    policy.attempts,
    last?.status,
  );
}

export async function fetchEvidenceJson<T>(
  http: EvidenceHttp,
  source: EvidenceSource,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ cached: boolean; data: T }> {
  const { cached, text } = await fetchEvidenceText(http, source, `GET ${url}`, async (signal) => {
    const response = await http.fetch(url, {
      headers: { Accept: "application/json", "User-Agent": EVIDENCE_USER_AGENT, ...headers },
      signal,
    });

    return { headers: response.headers, status: response.status, text: await response.text() };
  });

  return { cached, data: JSON.parse(text) as T };
}

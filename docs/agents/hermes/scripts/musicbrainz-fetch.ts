import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MB_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

export const MB_HOST = "musicbrainz.org";

export const MB_MIN_REQUEST_INTERVAL_MS = 1_100;

const MB_REQUEST_TIMEOUT_MS = 15_000;

const MB_ATTEMPTS = 3;

export const MB_MAX_BODY_BYTES = 2 * 1024 * 1024;

const LOCK_STALE_MS = 15_000;

const LOCK_WAIT_MS = 10_000;

const MAX_RETRY_AFTER_MS = 60_000;

export function musicbrainzStateDir(): string {
  return process.env.FLUNCLE_MUSICBRAINZ_STATE_DIR ?? join(homedir(), ".musicbrainz");
}

function budgetPath(stateDir: string): string {
  return join(stateDir, "budget.json");
}

function lockPath(stateDir: string): string {
  return join(stateDir, "budget.lock");
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

async function acquireLock(stateDir: string): Promise<number> {
  const path = lockPath(stateDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(path);
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error("the MusicBrainz budget lock is held");
      }
      await sleep(10 + Math.floor(Math.random() * 40));
    }
  }
}

function releaseLock(stateDir: string, handle: number): void {
  try {
    closeSync(handle);
  } finally {
    try {
      unlinkSync(lockPath(stateDir));
    } catch {}
  }
}

function readNextAllowedAt(stateDir: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(budgetPath(stateDir), "utf8"));
    const next = (parsed as { nextAllowedAtMs?: unknown }).nextAllowedAtMs;
    return typeof next === "number" && Number.isFinite(next) ? next : 0;
  } catch {
    return 0;
  }
}

async function withBudget<T>(
  stateDir: string,
  mutate: (nextAllowedAtMs: number, now: number) => { nextAllowedAtMs: number; value: T },
): Promise<T> {
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  const handle = await acquireLock(stateDir);
  try {
    const result = mutate(readNextAllowedAt(stateDir), Date.now());
    writeFileSync(
      budgetPath(stateDir),
      JSON.stringify({ nextAllowedAtMs: result.nextAllowedAtMs }),
      {
        mode: 0o600,
      },
    );
    return result.value;
  } finally {
    releaseLock(stateDir, handle);
  }
}

export async function reserveMusicbrainzSlot(
  stateDir: string = musicbrainzStateDir(),
  intervalMs: number = MB_MIN_REQUEST_INTERVAL_MS,
): Promise<number> {
  const slotAt = await withBudget(stateDir, (next, now) => {
    const slot = Math.max(now, next);
    return { nextAllowedAtMs: slot + intervalMs, value: slot };
  });
  await sleep(slotAt - Date.now());
  return slotAt;
}

export async function deferMusicbrainzBudget(
  cooldownMs: number,
  stateDir: string = musicbrainzStateDir(),
): Promise<void> {
  await withBudget(stateDir, (next, now) => ({
    nextAllowedAtMs: Math.max(next, now + cooldownMs),
    value: undefined,
  }));
}

export type MusicbrainzFetchResult = {
  body?: unknown;
  outcome: "body" | "empty" | "invalid" | "oversize" | "throttled";
  url: string;
};

export type MusicbrainzFetchOptions = {
  fetch?: typeof globalThis.fetch;
  intervalMs?: number;
  onAttempt?: (attempt: { outcome: string; url: string }) => void;
  stateDir?: string;
};

function retryAfterMs(header: null | string): number {
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export async function fetchMusicbrainz(
  url: string,
  options: MusicbrainzFetchOptions = {},
): Promise<MusicbrainzFetchResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== MB_HOST) {
    throw new Error("refusing to fetch a url outside MusicBrainz");
  }
  const stateDir = options.stateDir ?? musicbrainzStateDir();
  const intervalMs = options.intervalMs ?? MB_MIN_REQUEST_INTERVAL_MS;
  const fetchFn = options.fetch ?? globalThis.fetch;

  for (let attempt = 0; attempt < MB_ATTEMPTS; attempt += 1) {
    await reserveMusicbrainzSlot(stateDir, intervalMs);
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { "User-Agent": MB_USER_AGENT },

        redirect: "manual",
        signal: AbortSignal.timeout(MB_REQUEST_TIMEOUT_MS),
      });
    } catch {
      options.onAttempt?.({ outcome: "network_error", url });
      return { outcome: "empty", url };
    }

    if (response.status >= 300 && response.status < 400) {
      options.onAttempt?.({ outcome: `http_${response.status}`, url });
      return { outcome: "empty", url };
    }

    if (response.status === 503) {
      options.onAttempt?.({
        outcome: attempt === MB_ATTEMPTS - 1 ? "throttled" : "retry_503",
        url,
      });
      if (attempt === MB_ATTEMPTS - 1) {
        return { outcome: "throttled", url };
      }
      const cooldownMs = retryAfterMs(response.headers.get("Retry-After"));

      await deferMusicbrainzBudget(cooldownMs, stateDir);
      await sleep(cooldownMs);
      continue;
    }

    if (!response.ok) {
      options.onAttempt?.({ outcome: `http_${response.status}`, url });
      return { outcome: "empty", url };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      options.onAttempt?.({ outcome: "network_error", url });
      return { outcome: "empty", url };
    }
    if (Buffer.byteLength(text, "utf8") > MB_MAX_BODY_BYTES) {
      options.onAttempt?.({ outcome: "oversize", url });
      return { outcome: "oversize", url };
    }
    try {
      const body: unknown = JSON.parse(text);
      options.onAttempt?.({ outcome: "body", url });
      return { body, outcome: "body", url };
    } catch {
      options.onAttempt?.({ outcome: "invalid", url });
      return { outcome: "invalid", url };
    }
  }

  return { outcome: "throttled", url };
}

export type CrawlFetchPlan =
  | { kind: "none" }
  | { kind: "single"; url: string }
  | {
      countField: "release-count";
      kind: "tail";
      pageSize: number;
      pageUrlTemplate: string;
      probeUrl: string;
    };

export const CRAWL_FETCH_OFFSET_SLOT = "{offset}";

function countOf(body: unknown, field: string): number {
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function runCrawlFetchPlan(
  plan: CrawlFetchPlan,
  options: MusicbrainzFetchOptions = {},
): Promise<MusicbrainzFetchResult[]> {
  if (plan.kind === "none") {
    return [];
  }
  if (plan.kind === "single") {
    return [await fetchMusicbrainz(plan.url, options)];
  }
  const probe = await fetchMusicbrainz(plan.probeUrl, options);
  if (probe.outcome !== "body") {
    return [probe];
  }
  const total = countOf(probe.body, plan.countField);
  if (total <= 0) {
    return [probe];
  }
  const offset = Math.max(0, total - plan.pageSize);
  const pageUrl = plan.pageUrlTemplate.replace(CRAWL_FETCH_OFFSET_SLOT, String(offset));
  return [probe, await fetchMusicbrainz(pageUrl, options)];
}

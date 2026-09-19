// THE BOX'S ONE MUSICBRAINZ BUDGET — a cross-process 1 req/s token bucket, and the paced fetcher
// that draws on it.
//
// MusicBrainz rate-limits per SOURCE IP. A Cloudflare Worker's egress address is shared with
// strangers and its pacing gate lives in an isolate, so a gate that spaces requests perfectly still
// sits behind an address whose real request rate nobody can see. The box has one stable address and
// runs every sweep that reads MusicBrainz, so it is the only place a single honest budget can
// exist — but only if every caller draws on the SAME one, and each sweep is its own process.
//
// So the budget is a file, not a variable. A lock file serializes the read-modify-write, the next
// allowed instant is durable, and a `Retry-After` pushes that instant forward FOR EVERYONE: one
// sweep meeting the wall slows its siblings down too, which is exactly the behaviour the Worker's
// module-level gate gave callers inside one isolate and could never give across processes.
//
// This module performs vendor I/O only. Every body it returns is untrusted evidence: the Worker
// binds it to a claim by url, parses it with the parser the Worker's own fetch feeds, and owns the
// write. It is self-contained because deployed box scripts do not import the monorepo workspace —
// the same rule `discogs-fetch.ts` states.
//
// The crawl is the first tenant. The siblings listed in docs/catalogue-crawler.md can adopt it
// without changing anything here: the budget is per host, not per sweep.

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

/**
 * The identifiable User-Agent MusicBrainz requires. A generic agent is rejected outright, so this is
 * not decoration — it is auth. It is the SAME string the Worker sends (`MB_USER_AGENT` in
 * apps/web/src/lib/server/musicbrainz.ts); `musicbrainz-fetch.test.ts` reads that file and fails if
 * the two ever drift, because one client identifying itself two ways is two clients to the vendor.
 */
export const MB_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

/** The one host these reads may reach. */
export const MB_HOST = "musicbrainz.org";

/** The pacing floor between two MusicBrainz requests from this machine, across every process. */
export const MB_MIN_REQUEST_INTERVAL_MS = 1_100;

/** A healthy paced call answers well inside this; past it the socket is stalled, not slow. */
const MB_REQUEST_TIMEOUT_MS = 15_000;

/** Attempts one read makes before it reports the vendor's throttle to its caller. */
const MB_ATTEMPTS = 3;

/** The provider envelope the Worker signs is bounded at 2 MiB; a body past it can never be used. */
export const MB_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** How long a lock may be held before a later process treats its holder as dead and breaks it. */
const LOCK_STALE_MS = 15_000;

/** How long a caller waits for the lock before it gives up rather than wedging its sweep. */
const LOCK_WAIT_MS = 10_000;

/** A `Retry-After` is honoured, but a hostile or absurd one may not park the whole box. */
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
      // A holder that died mid-slot would otherwise park every MusicBrainz caller on this box
      // forever. Only the process that both sees the stale age and wins the unlink proceeds; the
      // create after it is still exclusive, so breaking the lock cannot hand it to two callers.
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(path);
        }
      } catch {
        // Someone else broke or released it first. Fall through and try to create it.
      }
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
    } catch {
      // Already broken by a stale-lock sweep; the budget file is still authoritative.
    }
  }
}

function readNextAllowedAt(stateDir: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(budgetPath(stateDir), "utf8"));
    const next = (parsed as { nextAllowedAtMs?: unknown }).nextAllowedAtMs;
    return typeof next === "number" && Number.isFinite(next) ? next : 0;
  } catch {
    // No budget yet, or one a crash left unreadable. Zero means "the next slot is now", which is
    // the honest answer: this process is about to write a real one.
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

/**
 * Take this machine's next MusicBrainz slot and wait for it. The reservation and the wait are
 * separate on purpose: the slot is allocated under the lock and the WAIT happens outside it, so a
 * queue of callers spaces out without any of them holding the lock while it sleeps.
 */
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

/** Push every caller's next slot past a cooldown the vendor asked for. */
export async function deferMusicbrainzBudget(
  cooldownMs: number,
  stateDir: string = musicbrainzStateDir(),
): Promise<void> {
  await withBudget(stateDir, (next, now) => ({
    nextAllowedAtMs: Math.max(next, now + cooldownMs),
    value: undefined,
  }));
}

/**
 * What one box-side MusicBrainz read came back as. The vocabulary is the Worker transport's, one for
 * one, so the node settles identically whichever side fetched it: `throttled` is backpressure that
 * keeps the node's turn, and everything else is that node's own outcome.
 */
export type MusicbrainzFetchResult = {
  body?: unknown;
  outcome: "body" | "empty" | "invalid" | "oversize" | "throttled";
  url: string;
};

export type MusicbrainzFetchOptions = {
  fetch?: typeof globalThis.fetch;
  intervalMs?: number;
  stateDir?: string;
};

function retryAfterMs(header: null | string): number {
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** One paced, identified, `Retry-After`-honouring MusicBrainz read from this machine's own IP. */
export async function fetchMusicbrainz(
  url: string,
  options: MusicbrainzFetchOptions = {},
): Promise<MusicbrainzFetchResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== MB_HOST) {
    // The box never composes a MusicBrainz url — it fetches one the Worker issued — so this is a
    // guard against a drifted caller, not against the vendor.
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
        // NEVER follow a redirect. The host guard above is checked once, on the url the Worker
        // issued, and a followed 3xx would walk straight past it — off-host, and from a machine
        // whose network reach is not the public internet's. A redirect is therefore not a hop to
        // take but an answer this read did not get.
        redirect: "manual",
        signal: AbortSignal.timeout(MB_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A network error or a stalled socket yielded nothing. That is an empty answer, never a
      // throttle: a stall says nothing about the vendor's mood.
      return { outcome: "empty", url };
    }

    if (response.status >= 300 && response.status < 400) {
      return { outcome: "empty", url };
    }

    if (response.status === 503) {
      if (attempt === MB_ATTEMPTS - 1) {
        return { outcome: "throttled", url };
      }
      const cooldownMs = retryAfterMs(response.headers.get("Retry-After"));
      // The cooldown is the BOX's, not this sweep's: every sibling process holds off too.
      await deferMusicbrainzBudget(cooldownMs, stateDir);
      await sleep(cooldownMs);
      continue;
    }

    if (!response.ok) {
      return { outcome: "empty", url };
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MB_MAX_BODY_BYTES) {
      return { outcome: "oversize", url };
    }
    try {
      return { body: JSON.parse(text), outcome: "body", url };
    } catch {
      return { outcome: "invalid", url };
    }
  }

  return { outcome: "throttled", url };
}

/**
 * What the Worker issued for one claimed node. The box never builds these strings; `tail`'s offset
 * slot is the single derived value, and the Worker recomputes it from the probe body before it will
 * read the page, so a wrong guess costs one Worker request rather than a wrong answer.
 */
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

/** The literal the tail template's offset slot is spelled with, on both sides of the wire. */
export const CRAWL_FETCH_OFFSET_SLOT = "{offset}";

function countOf(body: unknown, field: string): number {
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Fetch everything one claimed node's plan allows, in order, and hand the bodies back untouched. */
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
    // An empty browse list ends the read here, exactly as the Worker's own leg ends it.
    return [probe];
  }
  const offset = Math.max(0, total - plan.pageSize);
  const pageUrl = plan.pageUrlTemplate.replace(CRAWL_FETCH_OFFSET_SLOT, String(offset));
  return [probe, await fetchMusicbrainz(pageUrl, options)];
}

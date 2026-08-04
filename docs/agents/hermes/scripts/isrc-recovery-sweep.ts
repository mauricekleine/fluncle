#!/usr/bin/env bun
// isrc-recovery-sweep.ts — the free Deezer-only ISRC-recovery pass.
//
// STANDING CONSTRAINT: this sweep NEVER calls `anchor_track` and NEVER runs Apify. It asks Deezer
// once per work row, then offers those candidates to the Worker's existing `resolve_anchor` gate
// with `spotifySearch: false`. The Worker alone verifies and writes an ISRC. A recovery moves the row
// into the ordinary anchor head, where the billed sweep can use the high-precision exact-ISRC rung.
//
// stdout: exactly one JSON summary line. Diagnostics go to stderr.

const DEFAULT_API_BASE_URL = "https://www.fluncle.com";
const DEFAULT_BATCH = 100;
const MAX_WORK_LIMIT = 200;
export const ISRC_RECOVERY_EXPECTED_INTERVAL_MS = 60 * 60 * 1000;
export const ISRC_RECOVERY_PACE_MS = 1_100;

/** Must follow the contract-owned `DEEZER_CANDIDATE_LIMIT`. The baked script cannot import workspace code. */
export const DEEZER_CANDIDATE_LIMIT = 5;
const DEEZER_QUOTA_ERROR_CODE = 4;
const DEEZER_TIMEOUT_MS = 10_000;
const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";
const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

/** Three exhausted searches are enough evidence that the IP, rather than the rows, is blocked. */
export const DEEZER_QUOTA_ABORT_STREAK = 3;

export type IsrcRecoveryWorkItem = {
  deezerQuery?: string;
  trackId?: string;
};

export type DeezerCandidatePayload = {
  artistName: string;
  deezerTrackId?: string;
  durationMs: number;
  isrc: string;
  title: string;
};

export type IsrcRecoveryQueue = {
  queueDepth: number;
  rows: IsrcRecoveryWorkItem[];
};

export type ResolveAnchorVerdict = {
  anchored: boolean;
  isrcRecoveredByDeezer: boolean;
};

export type DeezerSearchOutcome =
  | { candidates: DeezerCandidatePayload[]; droppedIncomplete: number; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "transport-failed" };

export type IsrcRecoverySummary = {
  checked: number;
  deezerEmpty: number;
  /** Deezer hits withheld because they lacked one of the four fields the Worker gate requires. */
  deezerHitsDroppedIncomplete: number;
  errors: number;
  expectedIntervalMs: number;
  /** Per-row dependency or work-item failures; `errors` is reserved for a failed tick. */
  failed: number;
  gateRefused: number;
  ok: boolean;
  produced: number;
  /**
   * Rows still eligible after the tick. Every successful resolver call settles the dedicated
   * recovery ledger and leaves the current queue, including clean-empty and incomplete-hit results.
   * Quota and Deezer transport outcomes remain eligible. Resolver transport is not deducted because
   * the Worker may have committed before the response was lost; settlement stays unknown until the
   * next queue read. Null means the queue read itself failed.
   */
  queueDepth: number | null;
  /**
   * Rows blocked by quota, including each exhausted quota search plus every uninspected remainder
   * after the third consecutive quota outcome aborts the tick.
   */
  quotaBlocked: number;
  recovered: number;
  /** Malformed work rows that could not be attempted. */
  skipped: number;
  transportFailed: number;
};

export type IsrcRecoveryDeps = {
  fetchQueue: (limit: number) => Promise<IsrcRecoveryQueue>;
  log: (message: string) => void;
  resolveAnchor: (
    trackId: string,
    candidates: DeezerCandidatePayload[],
  ) => Promise<ResolveAnchorVerdict>;
  searchDeezer: (query: string) => Promise<DeezerSearchOutcome>;
  sleep: (ms: number) => Promise<void>;
};

export type RuntimeEffects = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (message: string) => void;
  output: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

function emptySummary(): IsrcRecoverySummary {
  return {
    checked: 0,
    deezerEmpty: 0,
    deezerHitsDroppedIncomplete: 0,
    errors: 0,
    expectedIntervalMs: ISRC_RECOVERY_EXPECTED_INTERVAL_MS,
    failed: 0,
    gateRefused: 0,
    ok: true,
    produced: 0,
    queueDepth: null,
    quotaBlocked: 0,
    recovered: 0,
    skipped: 0,
    transportFailed: 0,
  };
}

function settleQueueRow(summary: IsrcRecoverySummary): void {
  if (summary.queueDepth !== null && summary.queueDepth > 0) {
    summary.queueDepth -= 1;
  }
}

/** Run one bounded tick. Deezer searches are serial and paced between rows. */
export async function runIsrcRecoverySweep(
  limit: number,
  deps: IsrcRecoveryDeps,
): Promise<IsrcRecoverySummary> {
  const summary = emptySummary();
  let queue: IsrcRecoveryQueue;

  try {
    queue = await deps.fetchQueue(limit);
  } catch (error) {
    summary.errors = 1;
    summary.ok = false;
    deps.log(error instanceof Error ? error.message : String(error));
    return summary;
  }

  summary.queueDepth = queue.queueDepth;
  let consecutiveQuota = 0;

  for (let index = 0; index < queue.rows.length; index += 1) {
    const row = queue.rows[index];
    summary.checked += 1;

    const trackId = row?.trackId?.trim() ?? "";
    const deezerQuery = row?.deezerQuery?.trim() ?? "";

    if (!trackId || !deezerQuery) {
      summary.failed += 1;
      summary.skipped += 1;
      consecutiveQuota = 0;
      deps.log(`${trackId || "unknown-track"}: work row omitted trackId or deezerQuery`);
    } else {
      const search = await deps.searchDeezer(deezerQuery);

      if (search.outcome === "quota") {
        summary.quotaBlocked += 1;
        consecutiveQuota += 1;

        if (consecutiveQuota >= DEEZER_QUOTA_ABORT_STREAK) {
          // The remainder was not searched because the quota streak made its outcome predictable.
          summary.quotaBlocked += queue.rows.length - index - 1;
          deps.log(`aborting after ${consecutiveQuota} consecutive Deezer quota outcomes`);
          break;
        }
      } else if (search.outcome === "transport-failed") {
        summary.failed += 1;
        summary.transportFailed += 1;
        consecutiveQuota = 0;
      } else {
        consecutiveQuota = 0;
        summary.deezerHitsDroppedIncomplete += search.droppedIncomplete;

        try {
          const verdict = await deps.resolveAnchor(
            trackId,
            search.candidates.slice(0, DEEZER_CANDIDATE_LIMIT),
          );

          if (verdict.isrcRecoveredByDeezer) {
            summary.recovered += 1;
            summary.produced += 1;
          } else if (search.candidates.length > 0) {
            summary.gateRefused += 1;
          } else {
            // Only a truly empty result set is a Deezer miss. A non-empty response whose hits were
            // all incomplete is reported by `deezerHitsDroppedIncomplete`, never collapsed into it.
            if (search.droppedIncomplete === 0) {
              summary.deezerEmpty += 1;
            }
          }

          // Every successful resolver call settles exactly one row through the dedicated recovery
          // ledger, whether Deezer recovered, the gate refused, the clean response was empty (or
          // incomplete), or the free ListenBrainz rung anchored it. Quota and Deezer transport never
          // reach the resolver. Resolver transport leaves settlement unknown — the Worker may have
          // committed before the response was lost — so queue depth waits for the next queue read.
          settleQueueRow(summary);
        } catch (error) {
          summary.failed += 1;
          summary.transportFailed += 1;
          deps.log(`${trackId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (index < queue.rows.length - 1) {
      await deps.sleep(ISRC_RECOVERY_PACE_MS);
    }
  }

  return summary;
}

type DeezerAttempt =
  | { candidates: DeezerCandidatePayload[]; droppedIncomplete: number; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "transport-failed" };

/**
 * One Deezer request. This duplicates the Worker client's classification because the production
 * image bakes only this scripts directory, so importing `apps/web` would leave an unresolved module
 * on the box. In particular, Deezer quota is HTTP 200 + error code 4; every other error body is a
 * failed search, and only a valid empty `data` array is an honest miss.
 */
async function attemptDeezerSearch(query: string, request: typeof fetch): Promise<DeezerAttempt> {
  let response: Response;

  try {
    response = await request(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_CANDIDATE_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch {
    return { outcome: "transport-failed" };
  }

  if (!response.ok) {
    return { outcome: "transport-failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return { outcome: "transport-failed" };
  }

  const parsed = body as {
    data?: {
      artist?: { name?: string };
      duration?: number;
      id?: number;
      isrc?: string;
      title?: string;
    }[];
    error?: { code?: unknown };
  };

  if (parsed.error) {
    if (parsed.error.code === DEEZER_QUOTA_ERROR_CODE) {
      return { outcome: "quota" };
    }
    return { outcome: "transport-failed" };
  }

  if (!Array.isArray(parsed.data)) {
    return { outcome: "transport-failed" };
  }

  const candidates: DeezerCandidatePayload[] = [];
  let droppedIncomplete = 0;

  for (const hit of parsed.data.slice(0, DEEZER_CANDIDATE_LIMIT)) {
    const artistName = hit.artist?.name?.trim() ?? "";
    const isrc = hit.isrc?.trim() ?? "";
    const title = hit.title?.trim() ?? "";

    if (!artistName || !isrc || !title || typeof hit.duration !== "number" || hit.duration <= 0) {
      droppedIncomplete += 1;
      continue;
    }

    candidates.push({
      artistName,
      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title,
    });
  }

  return { candidates, droppedIncomplete, outcome: "ok" };
}

/** Search with bounded retries only for Deezer's explicit quota outcome. */
export async function searchDeezerCandidates(
  query: string,
  effects: Pick<RuntimeEffects, "fetch" | "sleep">,
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerSearchOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query, effects.fetch);

    if (result.outcome !== "quota") {
      return result;
    }

    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      return { outcome: "quota" };
    }
    await effects.sleep(delay);
  }
}

function parseLimit(args: string[], configured: string | undefined): number {
  const fromArgs = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  const flagIndex = args.indexOf("--limit");
  const raw = fromArgs ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined) ?? configured;
  const parsed = Number(raw ?? DEFAULT_BATCH);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH;
  }
  return Math.min(Math.trunc(parsed), MAX_WORK_LIMIT);
}

function productionDeps(effects: RuntimeEffects): IsrcRecoveryDeps {
  const baseUrl = effects.env.FLUNCLE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const token = effects.env.FLUNCLE_API_TOKEN ?? "";

  return {
    fetchQueue: async (limit) => {
      const response = await effects.fetch(
        `${baseUrl}/api/v1/admin/tracks/work?kind=isrc-recovery&limit=${limit}&count=true`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!response.ok) {
        throw new Error(
          `isrc-recovery queue read failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
        );
      }

      const body = (await response.json()) as { queued?: unknown; tracks?: unknown };
      if (!Array.isArray(body.tracks)) {
        throw new Error("isrc-recovery queue read returned a non-array tracks body");
      }
      if (
        typeof body.queued !== "number" ||
        !Number.isInteger(body.queued) ||
        body.queued < body.tracks.length
      ) {
        throw new Error("isrc-recovery queue read returned an invalid whole-queue count");
      }

      return { queueDepth: body.queued, rows: body.tracks as IsrcRecoveryWorkItem[] };
    },
    log: effects.log,
    resolveAnchor: async (trackId, deezerCandidates) => {
      const response = await effects.fetch(`${baseUrl}/api/v1/admin/catalogue/anchor/resolve`, {
        body: JSON.stringify({ deezerCandidates, spotifySearch: false, trackId }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(
          `resolve_anchor ${trackId} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
        );
      }

      const body = (await response.json()) as {
        anchored?: unknown;
        isrcRecoveredByDeezer?: unknown;
      };
      return {
        anchored: body.anchored === true,
        isrcRecoveredByDeezer: body.isrcRecoveredByDeezer === true,
      };
    },
    searchDeezer: (query) => searchDeezerCandidates(query, effects),
    sleep: effects.sleep,
  };
}

/** CLI entry with all side effects injectable: tests inspect the complete HTTP and stdout contract. */
export async function runIsrcRecoveryCli(
  args: string[],
  effects: RuntimeEffects,
): Promise<{ exitCode: number; summary: IsrcRecoverySummary }> {
  let summary: IsrcRecoverySummary;

  if (!(effects.env.FLUNCLE_API_TOKEN ?? "").trim()) {
    summary = { ...emptySummary(), errors: 1, ok: false };
  } else {
    const limit = parseLimit(args, effects.env.FLUNCLE_ISRC_RECOVERY_BATCH);
    summary = await runIsrcRecoverySweep(limit, productionDeps(effects));
  }

  effects.output(JSON.stringify(summary));
  return { exitCode: summary.ok ? 0 : 1, summary };
}

if (import.meta.main) {
  const effects: RuntimeEffects = {
    env: process.env,
    fetch: globalThis.fetch,
    log: (message) => console.error(`[isrc-recovery-sweep] ${message}`),
    output: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  runIsrcRecoveryCli(process.argv.slice(2), effects)
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      effects.log(message);
      effects.output(JSON.stringify({ ...emptySummary(), errors: 1, ok: false }));
      process.exitCode = 1;
    });
}

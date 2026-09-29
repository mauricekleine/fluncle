#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhaseAsync,
} from "./database-admission-phase";

import {
  createDiscogsFetcher,
  type DiscogsBatchResult,
  type DiscogsFactsCandidate,
  type DiscogsFactsWork,
  type DiscogsReleaseCandidate,
  type DiscogsReleaseWork,
  postDiscogsAgentOperation,
} from "./discogs-fetch";
import {
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_LIMIT ?? "3");

const CATALOGUE_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_CATALOGUE_LIMIT ?? "100");

const BEATPORT_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_BEATPORT_LIMIT ?? "10");

const DISCOGS_FACTS_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_DISCOGS_FACTS_LIMIT ?? "10");

const DEEZER_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_DEEZER_LIMIT ?? "25");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const ADMISSION_OWNER = "fluncle-backfill";

export const BACKFILL_PHASE_YIELD_RETRIES = 0;

const WALL_BUDGET_MS = Number(process.env.FLUNCLE_BACKFILL_WALL_BUDGET_MS ?? "360000");

const WORKER_PHASE_TIMEOUT_MS = 120_000;

const WORKER_PHASE_PATH_PREFIX = "/api/v1/admin/backfill/";

const log = (message: string) => console.error(`[backfill-sweep] ${message}`);

type DiscogsSummary = {
  discogsWork?: DiscogsReleaseWork[];
  ok?: boolean;

  rateLimited?: boolean;
  rateLimitedBy?: "discogs" | "musicbrainz" | null;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type LastfmSummary = {
  failedCount?: number;
  lovedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  skippedCount?: number;
};

type AppleMusicSummary = {
  configured?: boolean;
  failedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type AppleCatalogueSummary = {
  albumFactsWritten?: number;

  breakerTripped?: boolean;

  configured?: boolean;
  failedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;

  unresolvedCount?: number;
};

type BeatportSummary = {
  catalogueFailedCount?: number;
  catalogueResolvedCount?: number;
  catalogueUnresolvedCount?: number;

  configured?: boolean;

  failedCount?: number;
  ok?: boolean;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type DeezerSummary = {
  failedCount?: number;
  ok?: boolean;

  rateLimited?: boolean;
  resolvedCount?: number;

  unresolvedCount?: number;

  unvouchableCount?: number;
};

type DiscogsFactsSummary = {
  configured?: boolean;
  discogsWork?: DiscogsFactsWork[];

  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
};

type BackfillEnvironment = {
  DISCOGS_USER_TOKEN?: string;
  FLUNCLE_ADMISSION_RUNNER_PID?: string;
  FLUNCLE_API_BASE_URL?: string;
  FLUNCLE_API_TOKEN?: string;
};

export type BackfillCliResult = {
  status: number;
  stderr: string;
  stdout: string;
};

export type BackfillAdmissionMode = "inherited-lease" | "phased";

export type BackfillDatabaseWindows = {
  cli: (args: string[]) => Promise<BackfillCliResult>;
  mode: BackfillAdmissionMode;
  worker: typeof globalThis.fetch;
};

export class BackfillAdmissionYieldError extends Error {
  constructor(readonly yieldReason: null | string) {
    super("backfill database admission yielded");
    this.name = "BackfillAdmissionYieldError";
  }
}

type BackfillPhaseState =
  | { args: string[]; kind: "cli" }
  | { body?: string; kind: "worker"; url: string };

type BackfillPhaseEnvelope =
  | { kind: "cli"; status: number; stderr: string; stdout: string }
  | { body: string; kind: "worker"; status: number }
  | { error: string; kind: "failed" };

type BackfillDiscogsFetcher = {
  fetchFactsCandidates: (
    work: DiscogsFactsWork[],
  ) => Promise<DiscogsBatchResult<DiscogsFactsCandidate>>;
  fetchReleaseCandidates: (
    work: DiscogsReleaseWork[],
  ) => Promise<DiscogsBatchResult<DiscogsReleaseCandidate>>;
};

export type BackfillSweepEffects = {
  createFetcher?: (
    token: string,
    options: { fetch?: typeof globalThis.fetch },
  ) => BackfillDiscogsFetcher;
  env?: BackfillEnvironment;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  windows?: BackfillDatabaseWindows;
};

function spawnFluncle(args: string[]): BackfillCliResult {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  return { status: result.status ?? 1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

export function parseFluncleResult<T>(args: string[], result: BackfillCliResult): T {
  const code = result.status;
  const stdout = result.stdout;

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${result.stderr.trim()}`);
    }

    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);

  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }

  return parsed as T;
}

export function fluncleJson<T>(args: string[]): T {
  return parseFluncleResult<T>(args, spawnFluncle(args));
}

export function inheritedLeaseWindows(
  workerFetch?: typeof globalThis.fetch,
): BackfillDatabaseWindows {
  return {
    cli: (args) => Promise.resolve(spawnFluncle(args)),
    mode: "inherited-lease",
    worker: workerFetch ?? globalThis.fetch,
  };
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function runBackfillPhase(state: BackfillPhaseState): Promise<BackfillPhaseEnvelope> {
  const directory = mkdtempSync(join(tmpdir(), "fluncle-backfill-phase-"));
  const statePath = join(directory, "phase.json");

  try {
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const phase = await runDatabaseAdmissionPhaseAsync({
      command: [process.execPath, import.meta.filename, "--admission-phase", statePath],
      owner: ADMISSION_OWNER,
      yieldRetries: BACKFILL_PHASE_YIELD_RETRIES,
    });

    if (phase.kind === "yielded") {
      throw new BackfillAdmissionYieldError(phase.yieldReason);
    }

    const envelope = JSON.parse(phase.stdout) as BackfillPhaseEnvelope;

    if (envelope.kind === "failed") {
      throw new Error(envelope.error);
    }

    if (envelope.kind !== state.kind) {
      throw new Error("backfill admission phase returned an invalid envelope");
    }

    return envelope;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function admittedWindows(): BackfillDatabaseWindows {
  return {
    cli: async (args) => {
      const envelope = await runBackfillPhase({ args, kind: "cli" });

      if (envelope.kind !== "cli") {
        throw new Error("backfill CLI phase returned an invalid envelope");
      }

      return { status: envelope.status, stderr: envelope.stderr, stdout: envelope.stdout };
    },
    mode: "phased",
    worker: (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== undefined && init.method !== "POST") {
        throw new Error("backfill worker phases only carry POST requests");
      }

      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("backfill worker phases only carry JSON string bodies");
      }

      const envelope = await runBackfillPhase({
        ...(init?.body === undefined ? {} : { body: init.body }),
        kind: "worker",
        url: requestUrl(input),
      });

      if (envelope.kind !== "worker") {
        throw new Error("backfill worker phase returned an invalid envelope");
      }

      return new Response(envelope.body, { status: envelope.status });
    }) as typeof globalThis.fetch,
  };
}

function validPhaseState(value: unknown): value is BackfillPhaseState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const state = value as { args?: unknown; body?: unknown; kind?: unknown; url?: unknown };

  if (state.kind === "cli") {
    return (
      Array.isArray(state.args) &&
      state.args.every((arg) => typeof arg === "string") &&
      state.args[0] === "admin" &&
      state.args[1] === "backfills"
    );
  }

  return (
    state.kind === "worker" &&
    typeof state.url === "string" &&
    (state.body === undefined || typeof state.body === "string")
  );
}

export async function runBackfillPhaseChild(
  statePath: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BackfillPhaseEnvelope> {
  try {
    const state: unknown =
      statePath === undefined ? undefined : JSON.parse(readFileSync(statePath, "utf8"));

    if (!validPhaseState(state)) {
      return { error: "invalid backfill admission phase request", kind: "failed" };
    }

    if (state.kind === "cli") {
      return { ...spawnFluncle(state.args), kind: "cli" };
    }

    const base = new URL(env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com");
    const url = new URL(state.url);

    if (url.origin !== base.origin || !url.pathname.startsWith(WORKER_PHASE_PATH_PREFIX)) {
      return { error: "invalid backfill admission phase request", kind: "failed" };
    }

    const response = await fetch(url, {
      ...(state.body === undefined ? {} : { body: state.body }),
      headers: {
        Authorization: `Bearer ${env.FLUNCLE_API_TOKEN ?? ""}`,
        ...(state.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method: "POST",
      signal: AbortSignal.timeout(WORKER_PHASE_TIMEOUT_MS),
    });

    return { body: await response.text(), kind: "worker", status: response.status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export async function runBackfillSweep(effects: BackfillSweepEffects = {}) {
  const env = effects.env ?? process.env;
  const apiToken = env.FLUNCLE_API_TOKEN ?? "";
  const discogsToken = env.DISCOGS_USER_TOKEN ?? "";
  const agentBaseUrl = env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
  const windows =
    effects.windows ??
    (env.FLUNCLE_ADMISSION_RUNNER_PID ? inheritedLeaseWindows(effects.fetch) : admittedWindows());
  const now = effects.now ?? Date.now;
  const startedAt = now();
  let discogsFetcher: BackfillDiscogsFetcher | undefined;
  const getDiscogsFetcher = (): BackfillDiscogsFetcher => {
    discogsFetcher ??= (effects.createFetcher ?? createDiscogsFetcher)(discogsToken, {
      fetch: windows.mode === "inherited-lease" ? effects.fetch : undefined,
    });
    return discogsFetcher;
  };
  const summary = {
    "apple-catalogue": {
      albumFacts: 0,
      breakerTripped: false,
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
    },
    "apple-music": {
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      throttled: false,
      unresolved: 0,
    },
    beatport: {
      catalogueFailed: 0,
      catalogueResolved: 0,
      catalogueUnresolved: 0,
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      unresolved: 0,
    },
    checked: 0,
    deezer: {
      error: null as string | null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
      unvouchable: 0,
    },
    discogs: {
      error: null as string | null,
      resolved: 0,
      skipped: 0,
      throttled: false,
      unresolved: 0,
    },
    "discogs-facts": {
      configured: false,
      error: null as string | null,
      failed: 0,
      none: 0,
      resolved: 0,
      throttled: false,
    },
    errors: 0,
    failed: 0,
    lastfm: { error: null as string | null, failed: 0, loved: 0, skipped: 0, throttled: false },
    musicbrainz: { throttled: false },
    ok: true,
    produced: 0,
  };
  const cliJson = async <T>(args: string[]): Promise<T> =>
    parseFluncleResult<T>(args, await windows.cli(args));

  const limit = ["--limit", String(BATCH_LIMIT)];

  const repairPendingLegs: string[] = [];
  const deferredLeg = (leg: string, error: unknown): boolean => {
    if (error instanceof BackfillAdmissionYieldError) {
      throw error;
    }

    if (!isDueWorkRepairPending(error)) {
      return false;
    }

    repairPendingLegs.push(leg);
    log(error.message);

    return true;
  };

  const runDiscogs = async (): Promise<void> => {
    try {
      const addDiscogsPass = (pass: DiscogsSummary): void => {
        summary.discogs.resolved += pass.resolvedCount ?? 0;
        summary.discogs.unresolved += pass.unresolvedCount ?? 0;
        summary.discogs.skipped += pass.skippedCount ?? 0;
        summary.discogs.throttled ||= pass.rateLimited === true && pass.rateLimitedBy === "discogs";
        summary.musicbrainz.throttled ||=
          pass.rateLimited === true && pass.rateLimitedBy === "musicbrainz";
        summary.ok &&= pass.ok !== false;
      };
      const common = {
        baseUrl: agentBaseUrl,
        fetch: windows.worker,
        query: { boxFetch: true, limit: BATCH_LIMIT },
      };
      const prepared = await postDiscogsAgentOperation<DiscogsSummary>(
        "/admin/backfill/discogs",
        apiToken,
        common,
      );
      addDiscogsPass(prepared);
      const work = prepared.rateLimited ? [] : (prepared.discogsWork ?? []);

      if (work.length > 0) {
        const fetched = await getDiscogsFetcher().fetchReleaseCandidates(work);

        if (!fetched.ok) {
          summary.discogs.throttled = fetched.rateLimited;

          if (!fetched.rateLimited) {
            summary.ok = false;
            summary.errors += 1;
            summary.discogs.error = fetched.error;
          }
        } else {
          const decided = await postDiscogsAgentOperation<DiscogsSummary>(
            "/admin/backfill/discogs",
            apiToken,
            { ...common, body: { discogsCandidates: fetched.candidates } },
          );
          addDiscogsPass(decided);
        }
      }

      summary.checked += summary.discogs.resolved + summary.discogs.unresolved;
      summary.produced += summary.discogs.resolved;
    } catch (error) {
      if (deferredLeg("discogs", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary.discogs.error = error instanceof Error ? error.message : String(error);
      log(`discogs backfill failed: ${summary.discogs.error}`);
    }
  };

  const runLastfm = async (): Promise<void> => {
    try {
      const lastfm = await cliJson<LastfmSummary>(["admin", "backfills", "lastfm", ...limit]);
      summary.lastfm.loved = lastfm.lovedCount ?? 0;
      summary.lastfm.failed = lastfm.failedCount ?? 0;
      summary.lastfm.skipped = lastfm.skippedCount ?? 0;
      summary.lastfm.throttled = lastfm.rateLimited ?? false;
      summary.checked += summary.lastfm.loved + summary.lastfm.failed;
      summary.produced += summary.lastfm.loved;
      summary.failed += summary.lastfm.failed;

      if (lastfm.ok === false) {
        summary.ok = false;

        log(`lastfm backfill partial: ${summary.lastfm.failed} item(s) failed this tick`);
      }
    } catch (error) {
      if (deferredLeg("lastfm", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary.lastfm.error = error instanceof Error ? error.message : String(error);
      log(`lastfm backfill failed: ${summary.lastfm.error}`);
    }
  };

  const runAppleMusic = async (): Promise<void> => {
    try {
      const apple = await cliJson<AppleMusicSummary>([
        "admin",
        "backfills",
        "apple-music",
        ...limit,
      ]);
      summary["apple-music"].configured = apple.configured ?? false;
      summary["apple-music"].resolved = apple.resolvedCount ?? 0;
      summary["apple-music"].unresolved = apple.unresolvedCount ?? 0;
      summary["apple-music"].failed = apple.failedCount ?? 0;
      summary["apple-music"].skipped = apple.skippedCount ?? 0;
      summary["apple-music"].throttled = apple.rateLimited ?? false;
      summary.checked +=
        summary["apple-music"].resolved +
        summary["apple-music"].unresolved +
        summary["apple-music"].failed;
      summary.produced += summary["apple-music"].resolved;
      summary.failed += summary["apple-music"].failed;

      if (apple.ok === false) {
        summary.ok = false;

        log(
          `apple-music backfill partial: ${summary["apple-music"].failed} item(s) failed this tick`,
        );
      }
    } catch (error) {
      if (deferredLeg("apple-music", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary["apple-music"].error = error instanceof Error ? error.message : String(error);
      log(`apple-music backfill failed: ${summary["apple-music"].error}`);
    }
  };

  const runAppleCatalogue = async (): Promise<void> => {
    try {
      const catalogue = await cliJson<AppleCatalogueSummary>([
        "admin",
        "backfills",
        "apple-catalogue",
        "--limit",
        String(CATALOGUE_BATCH_LIMIT),
      ]);
      summary["apple-catalogue"].configured = catalogue.configured ?? false;
      summary["apple-catalogue"].resolved = catalogue.resolvedCount ?? 0;
      summary["apple-catalogue"].unresolved = catalogue.unresolvedCount ?? 0;
      summary["apple-catalogue"].failed = catalogue.failedCount ?? 0;
      summary["apple-catalogue"].albumFacts = catalogue.albumFactsWritten ?? 0;
      summary["apple-catalogue"].throttled = catalogue.rateLimited ?? false;
      summary["apple-catalogue"].breakerTripped = catalogue.breakerTripped ?? false;
      summary.checked +=
        summary["apple-catalogue"].resolved +
        summary["apple-catalogue"].unresolved +
        summary["apple-catalogue"].failed;
      summary.produced += summary["apple-catalogue"].resolved;
      summary.failed += summary["apple-catalogue"].failed;

      if (catalogue.ok === false) {
        summary.ok = false;

        log(
          `apple-catalogue backfill partial: ${summary["apple-catalogue"].failed} row(s) failed this tick`,
        );
      }

      if (summary["apple-catalogue"].breakerTripped) {
        log("apple-catalogue backfill yielded: the shared Apple breaker/budget stopped the pass");
      }
    } catch (error) {
      if (deferredLeg("apple-catalogue", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary["apple-catalogue"].error = error instanceof Error ? error.message : String(error);
      log(`apple-catalogue backfill failed: ${summary["apple-catalogue"].error}`);
    }
  };

  const runBeatport = async (): Promise<void> => {
    try {
      const beatport = await cliJson<BeatportSummary>([
        "admin",
        "backfills",
        "beatport",
        "--limit",
        String(BEATPORT_BATCH_LIMIT),
      ]);
      summary.beatport.configured = beatport.configured ?? false;
      summary.beatport.resolved = beatport.resolvedCount ?? 0;
      summary.beatport.unresolved = beatport.unresolvedCount ?? 0;
      summary.beatport.failed = beatport.failedCount ?? 0;
      summary.beatport.skipped = beatport.skippedCount ?? 0;
      summary.beatport.catalogueResolved = beatport.catalogueResolvedCount ?? 0;
      summary.beatport.catalogueUnresolved = beatport.catalogueUnresolvedCount ?? 0;
      summary.beatport.catalogueFailed = beatport.catalogueFailedCount ?? 0;

      summary.checked +=
        summary.beatport.resolved +
        summary.beatport.unresolved +
        summary.beatport.failed +
        summary.beatport.catalogueResolved +
        summary.beatport.catalogueUnresolved +
        summary.beatport.catalogueFailed;
      summary.produced += summary.beatport.resolved + summary.beatport.catalogueResolved;
      summary.failed += summary.beatport.failed + summary.beatport.catalogueFailed;

      if (beatport.ok === false) {
        summary.ok = false;

        log(`beatport backfill partial: ${summary.beatport.failed} finding(s) failed this tick`);
      }
    } catch (error) {
      if (deferredLeg("beatport", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary.beatport.error = error instanceof Error ? error.message : String(error);
      log(`beatport backfill failed: ${summary.beatport.error}`);
    }
  };

  const runDiscogsFacts = async (): Promise<void> => {
    try {
      const addFactsPass = (pass: DiscogsFactsSummary): void => {
        const resolved = pass.resolvedCount ?? 0;
        const none = pass.noneCount ?? 0;
        const failed = pass.failedCount ?? 0;

        summary["discogs-facts"].configured ||= pass.configured ?? false;
        summary["discogs-facts"].resolved += resolved;
        summary["discogs-facts"].none += none;
        summary["discogs-facts"].failed += failed;
        summary["discogs-facts"].throttled ||= pass.rateLimited ?? false;

        summary.checked += resolved + none + failed;
        summary.produced += resolved;
        summary.failed += failed;

        summary.ok &&= pass.ok !== false && failed === 0;
      };
      const common = {
        baseUrl: agentBaseUrl,
        fetch: windows.worker,
        query: { boxFetch: true, limit: DISCOGS_FACTS_BATCH_LIMIT },
      };
      const prepared = await postDiscogsAgentOperation<DiscogsFactsSummary>(
        "/admin/backfill/discogs-facts",
        apiToken,
        common,
      );
      addFactsPass(prepared);
      const work = prepared.rateLimited ? [] : (prepared.discogsWork ?? []);

      if (work.length > 0) {
        const fetched = await getDiscogsFetcher().fetchFactsCandidates(work);

        if (!fetched.ok) {
          summary["discogs-facts"].throttled = fetched.rateLimited;

          if (!fetched.rateLimited) {
            summary.ok = false;
            summary.errors += 1;
            summary["discogs-facts"].error = fetched.error;
          }
        } else {
          const decided = await postDiscogsAgentOperation<DiscogsFactsSummary>(
            "/admin/backfill/discogs-facts",
            apiToken,
            { ...common, body: { discogsCandidates: fetched.candidates } },
          );
          addFactsPass(decided);
        }
      }
    } catch (error) {
      if (deferredLeg("discogs-facts", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary["discogs-facts"].error = error instanceof Error ? error.message : String(error);
      log(`discogs-facts backfill failed: ${summary["discogs-facts"].error}`);
    }
  };

  const runDeezer = async (): Promise<void> => {
    try {
      const deezer = await cliJson<DeezerSummary>([
        "admin",
        "backfills",
        "deezer",
        "--limit",
        String(DEEZER_BATCH_LIMIT),
      ]);
      summary.deezer.resolved = deezer.resolvedCount ?? 0;
      summary.deezer.unresolved = deezer.unresolvedCount ?? 0;
      summary.deezer.unvouchable = deezer.unvouchableCount ?? 0;
      summary.deezer.failed = deezer.failedCount ?? 0;
      summary.deezer.throttled = deezer.rateLimited ?? false;

      summary.checked +=
        summary.deezer.resolved + summary.deezer.unresolved + summary.deezer.failed;
      summary.produced += summary.deezer.resolved;
      summary.failed += summary.deezer.failed;

      if (deezer.ok === false) {
        summary.ok = false;

        log(`deezer backfill partial: ${summary.deezer.failed} row(s) failed this tick`);
      }

      if (summary.deezer.throttled) {
        log("deezer backfill yielded: Deezer answered its quota limit, nothing was stamped");
      }
    } catch (error) {
      if (deferredLeg("deezer", error)) {
        return;
      }

      summary.ok = false;
      summary.errors += 1;
      summary.deezer.error = error instanceof Error ? error.message : String(error);
      log(`deezer backfill failed: ${summary.deezer.error}`);
    }
  };

  const legs: [string, () => Promise<void>][] = [
    ["discogs", runDiscogs],
    ["lastfm", runLastfm],
    ["apple-music", runAppleMusic],
    ["apple-catalogue", runAppleCatalogue],
    ["beatport", runBeatport],
    ["discogs-facts", runDiscogsFacts],
    ["deezer", runDeezer],
  ];
  const deferredLegs: string[] = [];
  let yielded: BackfillAdmissionYieldError | undefined;
  let wallBudgetSpent = false;

  for (const [leg, run] of legs) {
    if (yielded !== undefined || wallBudgetSpent) {
      deferredLegs.push(leg);
      continue;
    }

    if (windows.mode === "phased" && now() - startedAt >= WALL_BUDGET_MS) {
      wallBudgetSpent = true;
      deferredLegs.push(leg);
      log(`wall budget spent; ${leg} and every later leg wait for the next tick`);
      continue;
    }

    try {
      await run();
    } catch (error) {
      if (!(error instanceof BackfillAdmissionYieldError)) {
        throw error;
      }

      yielded = error;
      deferredLegs.push(leg);
      log(`database admission yielded during ${leg} (${error.yieldReason ?? "unknown"})`);
    }
  }

  const admission = {
    admissionMode: windows.mode,
    ...(deferredLegs.length === 0 ? {} : { deferredLegs }),
  };
  const gated =
    repairPendingLegs.length === 0
      ? { ...summary, ...admission }
      : { ...summary, ...admission, ...dueWorkRepairPendingGate(summary), repairPendingLegs };

  if (yielded !== undefined) {
    return {
      ...gated,
      ...databaseAdmissionYieldSummary(
        yielded.yieldReason === null ? {} : { admissionYieldReason: yielded.yieldReason },
      ),
      errors: gated.errors,
      ok: gated.ok,
      produced: gated.produced,
    };
  }

  if (wallBudgetSpent) {
    return { ...gated, gateState: "paused", reason: "wall_budget", throttled: true };
  }

  return gated;
}

export function backfillSweepExitCode(summary: { ok: boolean }): 0 | 1 {
  return summary.ok ? 0 : 1;
}

if (import.meta.main && process.argv[2] === "--admission-phase") {
  console.log(JSON.stringify(await runBackfillPhaseChild(process.argv[3])));
} else if (import.meta.main) {
  const summary = await runBackfillSweep();
  console.log(JSON.stringify(summary));
  process.exitCode = backfillSweepExitCode(summary);
}

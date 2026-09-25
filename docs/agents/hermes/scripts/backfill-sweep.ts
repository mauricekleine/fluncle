#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

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
  FLUNCLE_API_BASE_URL?: string;
  FLUNCLE_API_TOKEN?: string;
};

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
};

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
    }

    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);

  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }

  return parsed as T;
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
  let discogsFetcher: BackfillDiscogsFetcher | undefined;
  const getDiscogsFetcher = (): BackfillDiscogsFetcher => {
    discogsFetcher ??= (effects.createFetcher ?? createDiscogsFetcher)(discogsToken, {
      fetch: effects.fetch,
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

  const limit = ["--limit", String(BATCH_LIMIT)];

  const repairPendingLegs: string[] = [];
  const deferredLeg = (leg: string, error: unknown): boolean => {
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
        fetch: effects.fetch,
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

  const runLastfm = (): void => {
    try {
      const lastfm = fluncleJson<LastfmSummary>(["admin", "backfills", "lastfm", ...limit]);
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

  const runAppleMusic = (): void => {
    try {
      const apple = fluncleJson<AppleMusicSummary>(["admin", "backfills", "apple-music", ...limit]);
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

  const runAppleCatalogue = (): void => {
    try {
      const catalogue = fluncleJson<AppleCatalogueSummary>([
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

  const runBeatport = (): void => {
    try {
      const beatport = fluncleJson<BeatportSummary>([
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
        fetch: effects.fetch,
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

  const runDeezer = (): void => {
    try {
      const deezer = fluncleJson<DeezerSummary>([
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

  await runDiscogs();
  runLastfm();
  runAppleMusic();
  runAppleCatalogue();
  runBeatport();
  await runDiscogsFacts();
  runDeezer();

  return repairPendingLegs.length === 0
    ? summary
    : { ...summary, ...dueWorkRepairPendingGate(summary), repairPendingLegs };
}

export function backfillSweepExitCode(summary: { ok: boolean }): 0 | 1 {
  return summary.ok ? 0 : 1;
}

if (import.meta.main) {
  const summary = await runBackfillSweep();
  console.log(JSON.stringify(summary));
  process.exitCode = backfillSweepExitCode(summary);
}

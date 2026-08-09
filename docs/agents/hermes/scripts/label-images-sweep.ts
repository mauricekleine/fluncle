#!/usr/bin/env bun
// Box driver for the label-logo resolver. The Worker prepares trusted label identities, this box
// performs only paced Discogs reads, and the same Worker operation re-verifies the returned evidence
// before any R2 or DB write. MusicBrainz, Wikidata fallback, matching, and persistence never move.

import {
  createDiscogsFetcher,
  type DiscogsBatchResult,
  type DiscogsLabelCandidate,
  type DiscogsLabelWork,
  postDiscogsAgentOperation,
} from "./discogs-fetch";

const BATCH_LIMIT = Number(process.env.FLUNCLE_LABEL_IMAGES_LIMIT ?? "4");
const OPERATION_PATH = "/admin/backfill/label-images";

const log = (message: string) => console.error(`[label-images-sweep] ${message}`);

type LabelImagesPass = {
  discogsWork?: DiscogsLabelWork[];
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
};

type SweepEnvironment = {
  DISCOGS_USER_TOKEN?: string;
  FLUNCLE_API_BASE_URL?: string;
  FLUNCLE_API_TOKEN?: string;
};

export type LabelImagesSweepEffects = {
  createFetcher?: (
    token: string,
    options: { fetch?: typeof globalThis.fetch },
  ) => {
    fetchLabelCandidates: (
      work: DiscogsLabelWork[],
    ) => Promise<DiscogsBatchResult<DiscogsLabelCandidate>>;
  };
  env?: SweepEnvironment;
  fetch?: typeof globalThis.fetch;
};

function addPass(summary: ReturnType<typeof emptySummary>, pass: LabelImagesPass): void {
  summary.resolved += pass.resolvedCount ?? 0;
  summary.none += pass.noneCount ?? 0;
  summary.failed += pass.failedCount ?? 0;
  summary.throttled ||= pass.rateLimited ?? false;
  summary.ok &&= pass.ok !== false && (pass.failedCount ?? 0) === 0;
}

function emptySummary() {
  return {
    checked: 0,
    error: null as string | null,
    errors: 0,
    failed: 0,
    none: 0,
    ok: true,
    produced: 0,
    resolved: 0,
    resolvedCount: 0,
    throttled: false,
  };
}

/** Run one bounded prepare → vendor fetch → Worker verdict pass. */
export async function runLabelImagesSweep(effects: LabelImagesSweepEffects = {}) {
  const summary = emptySummary();
  const env = effects.env ?? process.env;
  const apiToken = env.FLUNCLE_API_TOKEN ?? "";
  const discogsToken = env.DISCOGS_USER_TOKEN ?? "";
  const common = {
    baseUrl: env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com",
    fetch: effects.fetch,
    query: { boxFetch: true, limit: BATCH_LIMIT },
  };

  try {
    const prepared = await postDiscogsAgentOperation<LabelImagesPass>(
      OPERATION_PATH,
      apiToken,
      common,
    );
    addPass(summary, prepared);

    const work = prepared.discogsWork ?? [];

    if (work.length > 0) {
      const fetcher = (effects.createFetcher ?? createDiscogsFetcher)(discogsToken, {
        fetch: effects.fetch,
      });
      const fetched = await fetcher.fetchLabelCandidates(work);

      if (!fetched.ok) {
        summary.throttled = fetched.rateLimited;

        if (fetched.rateLimited) {
          log("Discogs throttled the pass — no partial candidate batch was submitted");
        } else {
          summary.ok = false;
          summary.errors = 1;
          summary.error = fetched.error;
          log(`Discogs label fetch failed: ${fetched.error}`);
        }
      } else {
        const decided = await postDiscogsAgentOperation<LabelImagesPass>(OPERATION_PATH, apiToken, {
          ...common,
          body: { discogsCandidates: fetched.candidates satisfies DiscogsLabelCandidate[] },
        });
        addPass(summary, decided);
      }
    }
  } catch (error) {
    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`label-image resolve pass failed: ${summary.error}`);
  }

  summary.checked = summary.resolved + summary.none + summary.failed;
  summary.produced = summary.resolved + summary.none;
  summary.resolvedCount = summary.resolved;
  return summary;
}

export async function main(): Promise<void> {
  const summary = await runLabelImagesSweep();
  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}

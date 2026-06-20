// Spinup agent registry + triggers. Each Spinup agent has its OWN scoped runtime
// key (sk_agent_…) and id; this maps each purpose to its env vars so adding an
// agent is a one-line change. The runtime keys must carry the `runs:create`
// permission (PR #105 made async runs the canonical path, renaming the old
// `exec:invoke`). See docs/track-lifecycle.md (Phase 2) + the spinup memory.
//
// ADMIN-GATED, WORKER-ONLY: server code; every Spinup trigger runs solely from an
// admin-authenticated route (the add endpoint today; future re-enrich).
// The Worker is the sole Spinup-trigger authority — the sk_agent_… keys are Worker
// secrets, never held by the CLI or Raycast (which reach Spinup via the admin API).

import { createSpinupClient } from "@getspinup/sdk";
import { type EnvKey, readEnvs } from "./env";
import { listTracks } from "./tracks";
import { updateTrack } from "./track-update";

const AGENTS = {
  enrich: { idVar: "SPINUP_ENRICH_AGENT_ID", keyVar: "SPINUP_ENRICH_AGENT_KEY" },
} as const satisfies Record<string, { idVar: EnvKey; keyVar: EnvKey }>;

export type SpinupAgent = keyof typeof AGENTS;

// Lazy by design: a Worker exposes bindings per request (nothing at module
// scope), and the SDK does not read env itself — so resolve the id/key and build
// the client on each call.
export async function spinupAgent(purpose: SpinupAgent): Promise<{
  agentId: string;
  client: ReturnType<typeof createSpinupClient>;
}> {
  const { idVar, keyVar } = AGENTS[purpose];
  const env = await readEnvs([idVar, keyVar]);

  return {
    agentId: env[idVar],
    client: createSpinupClient({ apiKey: env[keyVar] }),
  };
}

// Kick off async track enrichment after a track is added. Inline-awaited from the
// add handler: `runs.create` is a fast ENQUEUE (the work runs durably on Spinup's
// queue), so the Worker is held only for the brief POST, never the multi-minute
// enrichment. NEVER throws — the track is already added + published, so a Spinup
// hiccup must not fail the add; it just leaves enrichmentStatus "pending" for a
// later retry/sweep. On a successful enqueue we mark "processing"; the agent
// flips it to "done"/"failed" via `fluncle admin track update` when it finishes.
export async function triggerEnrichment(trackId: string, logId: string): Promise<void> {
  try {
    const { agentId, client } = await spinupAgent("enrich");
    const created = await client.agents.runs.create({
      agentId,
      idempotencyKey: `enrich:${logId}`,
      input: `Enrich track ${logId}`,
    });
    await updateTrack(trackId, { enrichmentStatus: "processing" });
    console.log(`[enrich] queued run ${created.run.id} for ${logId}`);
  } catch (error) {
    console.error(`[enrich] failed to queue enrichment for ${logId}:`, error);
  }
}

export type EnrichSweepEntry = {
  logId: string;
  status: string;
  trackId: string;
};

export type EnrichSweepResult = {
  /** The findings re-triggered this run (status they were picked up in). */
  reEnriched: EnrichSweepEntry[];
  /** Queued findings with no Log ID yet (can't enrich without the R2 key). */
  skipped: EnrichSweepEntry[];
};

// The self-healing sweep: query the enrich-queue (pending ∪ failed ∪ stale
// processing, oldest first) and re-fire enrichment for each finding. Because
// triggerEnrichment keys every run by `enrich:${logId}`, re-sweeping an
// in-flight track de-dupes on Spinup's side rather than spawning a duplicate
// run — so a cron can call this on a fixed interval safely. Worker-only and
// admin-gated (its route carries the auth); the CLI/Raycast reach it via that
// admin endpoint, never holding the sk_agent_… key. NEVER throws per track —
// one bad finding must not abort the rest of the sweep.
export async function sweepEnrichmentQueue(limit: number): Promise<EnrichSweepResult> {
  const { tracks } = await listTracks({ limit, order: "asc", status: "queue" });
  const reEnriched: EnrichSweepEntry[] = [];
  const skipped: EnrichSweepEntry[] = [];

  for (const track of tracks) {
    if (track.type !== "finding") {
      continue;
    }

    const entry: EnrichSweepEntry = {
      logId: track.logId ?? "",
      status: track.enrichmentStatus,
      trackId: track.trackId,
    };

    if (!track.logId) {
      skipped.push(entry);
      continue;
    }

    await triggerEnrichment(track.trackId, track.logId);
    reEnriched.push(entry);
  }

  return { reEnriched, skipped };
}

// Spinup agent registry + triggers. Each Spinup agent has its OWN scoped runtime
// key (sk_agent_…) and id; this maps each purpose to its env vars so adding an
// agent is a one-line change. The runtime keys must carry the `runs:create`
// permission (PR #105 made async runs the canonical path, renaming the old
// `exec:invoke`). See docs/track-lifecycle.md (Phase 2) + the spinup memory.
//
// ADMIN-GATED, WORKER-ONLY: server code; every Spinup trigger runs solely from an
// admin-authenticated route (the add endpoint today; future re-enrich/classify).
// The Worker is the sole Spinup-trigger authority — the sk_agent_… keys are Worker
// secrets, never held by the CLI or Raycast (which reach Spinup via the admin API).

import { createSpinupClient } from "@getspinup/sdk";
import { type EnvKey, readEnvs } from "./env";
import { updateTrack } from "./track-update";

const AGENTS = {
  // Vibe-placement classifier — dormant until that agent exists (the registry
  // shape is here so wiring it later is one call).
  classify: { idVar: "SPINUP_CLASSIFY_AGENT_ID", keyVar: "SPINUP_CLASSIFY_AGENT_KEY" },
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

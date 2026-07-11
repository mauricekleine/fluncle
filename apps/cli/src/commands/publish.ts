// The render → publish AUTO-ADVANCE — the operator's handle on the chain that closes the
// last gap in the pipeline (docs/track-lifecycle.md § Phase 3).
//
// A freshly-rendered, READY finding advances into the publish push on its own: YouTube as
// a hands-off public Short, TikTok as the inbox draft the operator finishes in-app. The
// on-box `fluncle-publish-advance` cron ticks it; these commands are the same three moves
// by hand — run a tick, and the KILL SWITCH either side of it.
//
// The box holds no Postiz key: every command here is a thin HTTP call to the Worker, which
// owns the key and every safety gate (the claim, the bundle check, the caps). See
// apps/web/src/lib/server/publish-advance.ts.

import { type PublishAdvanceResponse, type PublishAdvanceStateResponse } from "@fluncle/contracts";
import { adminApiPost, adminApiPut } from "../api";

/** Run ONE bounded tick of the auto-advance (admin tier — the box's agent token drives the
 *  cron form of this). Returns the tick's report: what it pushed, held, and why. */
export async function publishAdvanceCommand(): Promise<PublishAdvanceResponse> {
  return adminApiPost<PublishAdvanceResponse>("/api/admin/social/publish/advance", {});
}

/** Pause or resume the whole auto-advance — the kill switch (operator tier). Pausing halts
 *  every future auto-publish within one tick; nothing else about a finding changes. */
export async function publishAdvancePauseCommand(paused: boolean): Promise<boolean> {
  const response = await adminApiPut<PublishAdvanceStateResponse>(
    "/api/admin/social/publish/advance/state",
    { paused },
  );

  return response.paused;
}

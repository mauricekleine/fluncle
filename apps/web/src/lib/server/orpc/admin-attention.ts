// The `admin-attention` domain router module — the read behind the `/admin`
// attention queue, exposed off the Worker so the operator's CLI (`fluncle admin
// queue`) and its Raycast menu-bar sibling read the same snapshot the web
// dashboard renders.
//
//   - `get_attention` — GET /admin/attention on `adminAuth` ONLY (no
//     `operatorGuard`): admin tier, like every other admin read
//     (`list_recordings`/`get_track_admin`). It composes those same reads via
//     `readAttentionSnapshot` and folds them into the menu-bar digest
//     (`deriveAttentionDigest`) plus the render-queue pulse. Publishes nothing,
//     fully reversible, so the box's + operator's agent token drives it.
//
// The snapshot's counts are the RAW due/backlog truth by design — snooze/won't-do
// is client localStorage the server never sees.

import { deriveAttentionDigest } from "../../attention";
import { readAttentionSnapshot } from "../attention";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-attention` domain's handlers. */
export function adminAttentionHandlers(os: Implementer) {
  // GET /admin/attention — admin tier (agent-allowed read). Read one snapshot, fold
  // it into the digest + the render-queue pulse, and ack `{ ok, attention }`.
  const getAttentionHandler = os.get_attention.use(adminAuth).handler(async () => {
    try {
      const now = Date.now();
      const snapshot = await readAttentionSnapshot(now);

      return {
        attention: {
          ...deriveAttentionDigest(snapshot.items, now),
          renderQueueDepth: snapshot.renderQueueDepth,
        },
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_attention: getAttentionHandler,
  };
}

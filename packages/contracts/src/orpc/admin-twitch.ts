// The `admin-twitch` domain contract module — the agent-tier WRITE behind the
// live-set callout ("Fluncle is on the decks right now"). The on-box `fluncle-live`
// poller holds the Twitch credentials, polls Helix every minute, and POSTs the raw
// live state here; every surface reads what this op persisted (the `live_state`
// row), and the Worker owns the transition side-effects (the crew Telegram callout).
//
//   - `record_live_state` — AGENT tier (`adminAuth`, NOT `operatorGuard`): the box's
//     agent token drives the poller, exactly like `record_health`. It writes the
//     internal single-row `live_state` table only — no publish, fully reversible — so
//     an operator token is not required.
//
// The body is the raw Twitch read: a wall-clock `at` (ISO, the staleness anchor),
// the `live` boolean (Helix `data[]` non-empty), and the nullable public `title` /
// `startedAt`. The Worker compares against the stored row to detect the off→on /
// on→off transition. The output is the bare `{ ok: true }` ack.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `record_live_state` → `POST /admin/twitch/live` (operationId `recordLiveState`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`): the box's agent-token live poller
 * drives it, the `record_health` precedent. Upserts the single `live_state` row,
 * detects the transition against the stored row, and on a flip fires the crew
 * Telegram callout (off→on: post + pin; on→off: unpin). Internal write only (no
 * public lastmod moves). Returns the bare `{ ok: true }`.
 */
export const recordLiveState = oc
  .route({
    method: "POST",
    operationId: "recordLiveState",
    path: "/admin/twitch/live",
    summary: "Record the current Twitch live state for the cross-surface live callout",
    tags: ["Admin"],
  })
  .input(
    z.object({
      at: z.string().min(1),
      live: z.boolean(),
      startedAt: z.string().nullable(),
      title: z.string().nullable(),
    }),
  )
  .output(z.object({ ok: z.literal(true) }));

/** The `admin-twitch` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTwitchContract = {
  record_live_state: recordLiveState,
};

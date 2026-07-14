// The `admin-observations` domain contract — the SPOKEN sibling of `admin-notes`, plus the
// authoring read the on-box observation sweep needs.
//
// The observations were the worst-measured generated family Fluncle has and the only written
// family with NO anti-sameness rail (docs/planning/homogenisation-evidence.md, 2026-07-14).
// This domain ports the notes' proven mechanism to them:
//
//   - `list_observation_neighbours` — AGENT tier read: the sonic neighbourhood's stored
//     observation scripts (the SPENT moves the box author must route around, and the corpus
//     the echo gate re-reads on the wire). One definition of "the neighbourhood" on both sides.
//   - `list_observation_rejections` — admin tier (agent-allowed read): the scripts the echo gate
//     held back, each with the neighbour it echoed, that neighbour's script, the lifted phrase,
//     the score, and the thresholds in force. Also the gate's current dials.
//   - `resolve_observation_rejection` — OPERATOR tier: the ruling. `accepted` RENDERS the held
//     script onto the finding (overruling the gate; a Cartesia render, so publish-class);
//     `discarded` agrees with the gate.
//   - `update_observation_gate` — OPERATOR tier: retune the dials, a flip not a deploy (the
//     `settings` KV).
//
// The gate is NOT weakened here. `observe_track` still rejects exactly what it rejected before;
// these ops exist so the rejection is READABLE and REVERSIBLE instead of silent.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The observation echo gate's two dials, as they currently stand (the KV values, or defaults). */
export const ObservationGateSchema = z
  .object({
    // Content-word Jaccard at or above this reads as the same script wearing a new coat.
    maxOverlap: z.number(),
    // A run of consecutive shared words this long (carrying a content word) is a lift.
    minPhraseWords: z.number(),
  })
  .meta({ id: "ObservationGate" });

/** One sonic neighbour's stored observation script — the author's spent-move fuel + the gate's corpus. */
export const ObservationNeighbourSchema = z
  .object({
    logId: z.string(),
    script: z.string(),
  })
  .meta({ id: "ObservationNeighbour" });

/**
 * One held observation — a script the echo gate refused to RENDER, kept whole with the reason.
 * `minPhraseWords`/`maxOverlap` are the thresholds that were in force AT REJECTION TIME,
 * snapshotted so a later retune cannot silently rewrite the meaning of a past rejection.
 */
export const ObservationRejectionSchema = z
  .object({
    artUrl: z.string().optional(),
    artists: z.array(z.string()),
    // How many times this finding's observation has bounced while this rejection stayed open.
    attempts: z.number(),
    createdAt: z.string(),
    id: z.string(),
    logId: z.string().optional(),
    maxOverlap: z.number(),
    minPhraseWords: z.number(),
    // The neighbour it echoed hardest, and that neighbour's script as it read at the time.
    neighborLogId: z.string().optional(),
    neighborScript: z.string().optional(),
    overlap: z.number(),
    // The run of words lifted from the neighbour; "" when the rejection was overlap-only.
    phrase: z.string(),
    resolution: z.enum(["accepted", "discarded"]).optional(),
    resolvedAt: z.string().optional(),
    // THE EVIDENCE — the observation script the model actually wrote.
    script: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "ObservationRejection" });

/**
 * `list_observation_neighbours` → `GET /admin/tracks/{trackId}/observation-neighbours`
 * (operationId `listObservationNeighbours`).
 *
 * AGENT tier (`adminAuth` only — the on-box observation sweep reads it with its agent token to
 * hand the author its neighbourhood's SPENT moves, exactly as the note sweep reads its
 * neighbours). Returns the stored observation scripts of the finding's nearest sonic neighbours
 * (the same set the echo gate measures against), nearest first, only the ones that carry a
 * script. `{ ok, neighbours }`.
 */
export const listObservationNeighbours = oc
  .route({
    method: "GET",
    operationId: "listObservationNeighbours",
    path: "/admin/tracks/{trackId}/observation-neighbours",
    summary: "A finding's sonic neighbours' observation scripts (the author's spent moves)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional(), trackId: z.string() }))
  .output(
    z.object({
      neighbours: z.array(ObservationNeighbourSchema),
      ok: z.literal(true),
    }),
  );

/**
 * `list_observation_rejections` → `GET /admin/observation-rejections` (operationId
 * `listObservationRejections`).
 *
 * Admin tier (agent-allowed read — a pure read that renders nothing). Every held observation
 * still waiting on the operator's eye, oldest first, plus the gate's current dials. `open:
 * "false"` reads the SETTLED ones (what he rendered, what he binned). `trackId` narrows to one
 * finding. `{ ok, gate, rejections }`.
 */
export const listObservationRejections = oc
  .route({
    method: "GET",
    operationId: "listObservationRejections",
    path: "/admin/observation-rejections",
    summary: "The observations the echo gate held back (with the reason + the gate's dials)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      open: z.string().optional(),
      trackId: z.string().optional(),
    }),
  )
  .output(
    z.object({
      gate: ObservationGateSchema,
      ok: z.literal(true),
      rejections: z.array(ObservationRejectionSchema),
    }),
  );

/**
 * `resolve_observation_rejection` → `POST /admin/observation-rejections/{id}/resolve`
 * (operationId `resolveObservationRejection`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). The operator's ruling on a held observation.
 *
 * `accepted` — he read the script and it is good. It is RENDERED onto the finding through the
 * shared render path, overruling the echo gate (a human reading both scripts side by side is
 * the higher authority). A finding that already carries an observation (a fresh script cleared
 * the gate meanwhile) is left untouched and `skipped: true` comes back — the spoken analogue of
 * the note ledger's fill-empty-only rail, so a render is never wasted. Accepting spends a
 * Cartesia render, which is why this is operator tier and an agent token 403s.
 *
 * `discarded` — the gate was right. The finding stays observation-less and queued; the next
 * sweep tick is free to author a colder script.
 *
 * Codes: `not_found`/404, `already_resolved`/409.
 */
export const resolveObservationRejection = oc
  .route({
    method: "POST",
    operationId: "resolveObservationRejection",
    path: "/admin/observation-rejections/{id}/resolve",
    summary: "Rule on a held observation: render it or bin it (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string(), resolution: z.enum(["accepted", "discarded"]) }))
  .output(
    z.object({
      ok: z.literal(true),
      rejection: ObservationRejectionSchema,
      // `true` when `accepted` did NOT render because the finding already carried an observation.
      skipped: z.boolean(),
    }),
  );

/**
 * `update_observation_gate` → `PATCH /admin/observation-gate` (operationId
 * `updateObservationGate`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). Retune the observation echo gate's dials. They
 * live in the `settings` KV, so this takes effect on the very next sweep tick with no deploy.
 * Each dial is independently settable (an absent field leaves it alone) and BOUNDED. Tuning the
 * gate changes what the archive will and won't say out loud about itself, so an agent token
 * 403s. Codes: `invalid_request`/400.
 */
export const updateObservationGate = oc
  .route({
    method: "PATCH",
    operationId: "updateObservationGate",
    path: "/admin/observation-gate",
    summary: "Retune the observation echo gate's thresholds (operator; a flip, not a deploy)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      maxOverlap: z.number().optional(),
      minPhraseWords: z.number().optional(),
    }),
  )
  .output(z.object({ gate: ObservationGateSchema, ok: z.literal(true) }));

/** The `admin-observations` domain's ops, merged into the root contract by `./index.ts`. */
export const adminObservationsContract = {
  list_observation_neighbours: listObservationNeighbours,
  list_observation_rejections: listObservationRejections,
  resolve_observation_rejection: resolveObservationRejection,
  update_observation_gate: updateObservationGate,
};

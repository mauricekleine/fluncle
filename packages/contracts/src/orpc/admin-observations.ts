import { oc } from "@orpc/contract";
import * as z from "zod";

export const ObservationGateSchema = z
  .object({
    maxOverlap: z.number(),

    minPhraseWords: z.number(),
  })
  .meta({ id: "ObservationGate" });

export const ObservationNeighbourSchema = z
  .object({
    logId: z.string(),
    script: z.string(),
  })
  .meta({ id: "ObservationNeighbour" });

export const ObservationRejectionSchema = z
  .object({
    artUrl: z.string().optional(),
    artists: z.array(z.string()),

    attempts: z.number(),
    createdAt: z.string(),
    id: z.string(),
    logId: z.string().optional(),
    maxOverlap: z.number(),
    minPhraseWords: z.number(),

    neighborLogId: z.string().optional(),
    neighborScript: z.string().optional(),
    overlap: z.number(),

    phrase: z.string(),
    resolution: z.enum(["accepted", "discarded"]).optional(),
    resolvedAt: z.string().optional(),

    script: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "ObservationRejection" });

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

      skipped: z.boolean(),
    }),
  );

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

export const adminObservationsContract = {
  list_observation_neighbours: listObservationNeighbours,
  list_observation_rejections: listObservationRejections,
  resolve_observation_rejection: resolveObservationRejection,
  update_observation_gate: updateObservationGate,
};

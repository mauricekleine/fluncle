import { oc } from "@orpc/contract";
import * as z from "zod";

export const PROJECTION_STEP_LIMIT_MAX = 1_000;

export const ProjectionTargetSchema = z
  .enum(["artist_qualification", "crawl_due_work", "public_aggregates", "track_due_work"])
  .meta({ id: "ProjectionTarget" });

export const ProjectionCutoverSchema = z
  .enum(["crawl_due_work", "public_projections", "track_due_work"])
  .meta({ id: "ProjectionCutover" });

export const ProjectionStepActionSchema = z
  .enum(["audit", "rebuild", "repair"])
  .meta({ id: "ProjectionStepAction" });

const CountSchema = z.number().int().nonnegative();
const BoundedCountSchema = z.object({ count: CountSchema, truncated: z.boolean() });
const DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();

const RebuildSchema = z.object({
  complete: z.boolean(),
  completed: CountSchema,
  projected: CountSchema,
  running: CountSchema,
  scanned: CountSchema,
  total: CountSchema,
});

const BacklogSchema = z.object({
  leased: BoundedCountSchema,
  ready: BoundedCountSchema,
  scheduled: BoundedCountSchema,
});

const RepairSchema = z.object({
  direct: BoundedCountSchema,
  fanout: BoundedCountSchema,
  total: BoundedCountSchema,
});

const ConvergenceSchema = z.object({
  digestMatched: z.boolean().nullable(),
  epochMatched: z.boolean().nullable(),
  projectedDigest: DigestSchema,
  projectedEpoch: CountSchema.nullable(),
  sourceDigest: DigestSchema,
  sourceEpoch: CountSchema.nullable(),
});

const ProjectionFamilyStatusSchema = z.object({
  backlog: BacklogSchema,
  convergence: ConvergenceSchema,
  ready: z.boolean(),
  rebuild: RebuildSchema,
  repairs: RepairSchema,
});

export const ProjectionStatusSchema = z.object({
  cutovers: z.object({
    crawlDueWork: z.boolean(),
    publicProjections: z.boolean(),
    trackDueWork: z.boolean(),
  }),
  projections: z.object({
    artistQualification: ProjectionFamilyStatusSchema,
    crawlDueWork: ProjectionFamilyStatusSchema,
    publicAggregates: ProjectionFamilyStatusSchema.extend({ anchorsReady: z.boolean() }),
    trackDueWork: ProjectionFamilyStatusSchema,
  }),
  readyToOpen: z.object({
    crawlDueWork: z.boolean(),
    publicProjections: z.boolean(),
    trackDueWork: z.boolean(),
  }),
});

/** Operator-only, bounded diagnostic read. No raw rows, SQL, or source identifiers leave it. */
export const getProjectionStatus = oc
  .route({
    method: "GET",
    operationId: "getProjectionStatus",
    path: "/admin/projections/status",
    summary: "Read projection rebuild, repair, and convergence readiness",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), status: ProjectionStatusSchema }));

/** Run one bounded, resumable projection-control step. */
export const advanceProjection = oc
  .route({
    method: "POST",
    operationId: "advanceProjection",
    path: "/admin/projections/{target}/advance",
    summary: "Advance one bounded projection rebuild, repair, or audit step",
    tags: ["Admin"],
  })
  .input(
    z.object({
      action: ProjectionStepActionSchema,
      limit: z.number().int().min(1).max(PROJECTION_STEP_LIMIT_MAX),
      target: ProjectionTargetSchema,
    }),
  )
  .output(
    z.object({
      action: ProjectionStepActionSchema,
      complete: z.boolean(),
      ok: z.literal(true),
      processed: CountSchema,
      scheduled: CountSchema,
      status: ProjectionStatusSchema,
      target: ProjectionTargetSchema,
    }),
  );

/** The only supported projection flag writer; opening is readiness-gated, closing always works. */
export const setProjectionCutover = oc
  .route({
    method: "PUT",
    operationId: "setProjectionCutover",
    path: "/admin/projections/{target}/cutover",
    summary: "Open or close one readiness-gated projection cutover",
    tags: ["Admin"],
  })
  .input(z.object({ enabled: z.boolean(), target: ProjectionCutoverSchema }))
  .output(
    z.object({
      enabled: z.boolean(),
      ok: z.literal(true),
      status: ProjectionStatusSchema,
      target: ProjectionCutoverSchema,
    }),
  );

export const adminProjectionsContract = {
  advance_projection: advanceProjection,
  get_projection_status: getProjectionStatus,
  set_projection_cutover: setProjectionCutover,
};

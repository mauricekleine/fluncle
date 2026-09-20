import { oc } from "@orpc/contract";
import * as z from "zod";

export const PROJECTION_STEP_LIMIT_MAX = 500;

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

const OldestOutstandingMarkerAgeSchema = z.object({
  ageMs: CountSchema.nullable(),
  reason: z
    .enum(["marker_timestamp_invalid", "marker_timestamp_unavailable", "status_field_unavailable"])
    .nullable(),
  truncated: z.boolean(),
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
  oldestOutstandingMarkerAge: OldestOutstandingMarkerAgeSchema.optional(),
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
    trackDueWork: ProjectionFamilyStatusSchema.extend({
      // The synthetic catalogue-rank corpus marker's age. It is a resumable rebuild checkpoint
      // wearing a source-marker row, not fan-out debt: it clears only when a whole rank generation
      // completes against an unchanged corpus, and any corpus mutation restarts it. Its age is
      // therefore reported here and excluded from `oldestOutstandingMarkerAge`, which exists to say
      // whether ordinary debt is draining. Null when the marker holds no repair row; optional for
      // rolling compatibility with an older server.
      catalogueRankMarkerAgeMs: CountSchema.nullable().optional(),
    }),
  }),
  readyToOpen: z.object({
    crawlDueWork: z.boolean(),
    publicProjections: z.boolean(),
    trackDueWork: z.boolean(),
  }),
});

/** Admin-authenticated bounded diagnostic read. No raw rows or identifiers leave it. */
export const getProjectionStatus = oc
  .route({
    method: "GET",
    operationId: "getProjectionStatus",
    path: "/admin/projections/status",
    summary: "Read projection rebuild, repair, and convergence readiness",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), status: ProjectionStatusSchema }));

/** Run one bounded step; agent authority is handler-limited to runtime-family repair. */
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
      includeStatus: z.boolean().default(true),
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
      status: ProjectionStatusSchema.optional(),
      target: ProjectionTargetSchema,
      // Track repair only: whether an ordinary track source marker still awaits fanout after the
      // step. The synthetic catalogue-rank corpus marker never counts.
      trackSourceMarkersPending: z.boolean().optional(),
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

export const DUE_WORK_REKEY_LIMIT_MAX = 500;

/**
 * Mark one due-work queue's projected rows for repair, so the maintenance sweep re-keys them under
 * today's definition. Bounded and resumable; a dry run is the default. The automatic path is the
 * definition version stored with each rebuild checkpoint — this is the operator's lever for
 * forcing one queue now.
 */
export const rekeyDueWorkQueue = oc
  .route({
    method: "POST",
    operationId: "rekeyDueWorkQueue",
    path: "/admin/projections/due-work/{workKind}/rekey",
    summary: "Mark one due-work queue for re-keying under today's order definition",
    tags: ["Admin"],
  })
  .input(
    z.object({
      apply: z.boolean().default(false),
      cursor: z.string().max(200).nullable().default(null),
      limit: z
        .number()
        .int()
        .min(1)
        .max(DUE_WORK_REKEY_LIMIT_MAX)
        .default(DUE_WORK_REKEY_LIMIT_MAX),
      workKind: z.string().min(1).max(64),
    }),
  )
  .output(
    z.object({
      applied: z.boolean(),
      cursor: z.string().nullable(),
      definitionVersion: z.string(),
      hasMore: z.boolean(),
      marked: CountSchema,
      matched: CountSchema,
      ok: z.literal(true),
      remaining: BoundedCountSchema,
      subjectType: z.string(),
      workKind: z.string(),
    }),
  );

export const adminProjectionsContract = {
  advance_projection: advanceProjection,
  get_projection_status: getProjectionStatus,
  rekey_due_work_queue: rekeyDueWorkQueue,
  set_projection_cutover: setProjectionCutover,
};

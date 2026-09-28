import { oc } from "@orpc/contract";
import * as z from "zod";

export const MAX_RECORDED_LABEL_OUTLIERS = 2000;

export const MAX_LABEL_OUTLIER_DISMISSALS = 500;

const LabelOutlierReferenceSchema = z.enum(["catalogue", "label"]);

export const RecordedLabelOutlierSchema = z
  .object({
    albumId: z.string().min(1).max(256).nullable(),
    artistSupport: z.number().int().min(0),
    fingerprint: z.string().min(1).max(128),
    labelId: z.string().min(1).max(256).nullable(),
    reference: LabelOutlierReferenceSchema,
    referenceMedian: z.number(),
    score: z.number(),
    singleTrackId: z.string().min(1).max(256).nullable(),
    trackCount: z.number().int().min(1),
    unitId: z.string().min(1).max(256),
    z: z.number(),
  })
  .meta({ id: "RecordedLabelOutlier" });

export const LabelOutlierRunSchema = z
  .object({
    flagged: z.number().int().min(0),
    labelsScored: z.number().int().min(0),
    ranAt: z.string(),
    replicaSyncedAt: z.string().nullable(),
    tracksScored: z.number().int().min(0),
    unitsScored: z.number().int().min(0),
  })
  .meta({ id: "LabelOutlierRun" });

export const AlertedLabelOutlierSchema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    unitId: z.string().min(1).max(256),
  })
  .meta({ id: "AlertedLabelOutlier" });

export const PendingLabelOutlierAlertSchema = z
  .object({
    albumName: z.string().nullable(),
    labelName: z.string().nullable(),
    title: z.string(),
    unitId: z.string(),
  })
  .meta({ id: "PendingLabelOutlierAlert" });

export const recordLabelOutliers = oc
  .route({
    method: "PUT",
    operationId: "recordLabelOutliers",
    path: "/admin/label-outliers",
    summary: "Replace the nightly label-outlier review list with the box's scored set",
    tags: ["Admin"],
  })
  .input(
    z.object({
      labelsScored: z.number().int().min(0),
      outliers: z.array(RecordedLabelOutlierSchema).max(MAX_RECORDED_LABEL_OUTLIERS),
      replicaSyncedAt: z.string().nullable(),
      totalFlagged: z.number().int().min(0),
      tracksScored: z.number().int().min(0),
      unitsScored: z.number().int().min(0),
    }),
  )
  .output(
    z.object({
      flagged: z.number().int(),
      ok: z.literal(true),
      pendingAlertUnits: z.array(AlertedLabelOutlierSchema),
      pendingAlerts: z.array(PendingLabelOutlierAlertSchema),
      removed: z.number().int(),
    }),
  );

export const acknowledgeLabelOutlierAlerts = oc
  .route({
    method: "PUT",
    operationId: "acknowledgeLabelOutlierAlerts",
    path: "/admin/label-outliers/alerts",
    summary: "Mark flagged label outliers as announced, once their Discord summary has landed",
    tags: ["Admin"],
  })
  .input(
    z.object({
      units: z.array(AlertedLabelOutlierSchema).min(1).max(MAX_RECORDED_LABEL_OUTLIERS),
    }),
  )
  .output(z.object({ acknowledged: z.number().int(), ok: z.literal(true) }));

export const LabelOutlierTrackSchema = z
  .object({
    artists: z.array(z.object({ name: z.string(), slug: z.string() })),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "LabelOutlierTrack" });

export const LabelOutlierItemSchema = z
  .object({
    album: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    artistSupport: z.number(),
    discogsStyles: z.array(z.string()),
    dismissedAt: z.string().nullable(),
    firstFlaggedAt: z.string(),
    label: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    reference: LabelOutlierReferenceSchema,
    referenceMedian: z.number(),
    score: z.number(),
    trackCount: z.number(),
    tracks: z.array(LabelOutlierTrackSchema),
    unitId: z.string(),
    z: z.number(),
  })
  .meta({ id: "LabelOutlierItem" });

export const listLabelOutliers = oc
  .route({
    method: "GET",
    operationId: "listLabelOutliers",
    path: "/admin/label-outliers",
    summary: "The label-outlier review list: albums and singles that sound unlike their label",
    tags: ["Admin"],
  })
  .output(
    z.object({
      items: z.array(LabelOutlierItemSchema),
      lastRun: LabelOutlierRunSchema.nullable(),
      ok: z.literal(true),
    }),
  );

export const setLabelOutliersDismissed = oc
  .route({
    method: "PUT",
    operationId: "setLabelOutliersDismissed",
    path: "/admin/label-outliers/dismissed",
    summary: "Mark flagged label outliers as looking fine, or put them back on the list (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      dismissed: z.boolean(),
      unitIds: z.array(z.string().min(1).max(256)).min(1).max(MAX_LABEL_OUTLIER_DISMISSALS),
    }),
  )
  .output(z.object({ changed: z.number().int(), ok: z.literal(true) }));

export const LABEL_OUTLIER_INPUTS_DEFAULT_PAGE = 500;

export const LABEL_OUTLIER_INPUTS_MAX_PAGE = 1000;

export const LabelOutlierInputTrackSchema = z
  .object({
    albumId: z.string().nullable(),
    artistIds: z.array(z.string()),
    embeddingBase64: z.string(),
    labelId: z.string().nullable(),
    trackId: z.string(),
  })
  .meta({ id: "LabelOutlierInputTrack" });

export const LabelOutlierInputAlbumSchema = z
  .object({ discogsStyles: z.string(), id: z.string() })
  .meta({ id: "LabelOutlierInputAlbum" });

export const listLabelOutlierInputs = oc
  .route({
    method: "GET",
    operationId: "listLabelOutlierInputs",
    path: "/admin/label-outliers/inputs",
    summary:
      "One keyset page of the label-outlier scoring inputs: embedded catalogue tracks with their raw vector bytes, artist credits, and album Discogs styles",
    tags: ["Admin"],
  })
  .input(z.object({ cursor: z.string().max(512).optional(), limit: z.string().optional() }))
  .output(
    z.object({
      albums: z.array(LabelOutlierInputAlbumSchema),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      tracks: z.array(LabelOutlierInputTrackSchema),
    }),
  );

export const adminLabelOutliersContract = {
  acknowledge_label_outlier_alerts: acknowledgeLabelOutlierAlerts,
  list_label_outlier_inputs: listLabelOutlierInputs,
  list_label_outliers: listLabelOutliers,
  record_label_outliers: recordLabelOutliers,
  set_label_outliers_dismissed: setLabelOutliersDismissed,
};

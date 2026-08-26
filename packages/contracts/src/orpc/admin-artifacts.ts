// The artifact-change domain: a versioned producer log and fenced source snapshots for
// filesystemful consumers such as Sonar and the local public-device artifact builder.
//
// Every operation is private and excluded from the public OpenAPI document by the existing
// `/admin/*` filter. Registration, bootstrap, reads, checkpoints, activation, and inactivation are
// agent tier; compaction is operator tier because it irreversibly deletes an acknowledged prefix.

import { oc } from "@orpc/contract";
import * as z from "zod";

export const ARTIFACT_CHANGE_API_MAX_LIMIT = 500;
export const ARTIFACT_SNAPSHOT_API_MAX_LIMIT = 200;
export const ARTIFACT_COMPACTION_API_MAX_LIMIT = 1_000;

export const ARTIFACT_SUPPORTED_CONTRACTS = [
  { formatVersion: 1, stream: "device.album", streamVersion: 1 },
  { formatVersion: 1, stream: "device.artist", streamVersion: 1 },
  { formatVersion: 1, stream: "device.finding", streamVersion: 1 },
  { formatVersion: 1, stream: "device.label", streamVersion: 1 },
  { formatVersion: 1, stream: "device.track", streamVersion: 1 },
  { formatVersion: 1, stream: "device.track-artist", streamVersion: 1 },
  { formatVersion: 1, stream: "sonar.track", streamVersion: 1 },
] as const;

export const ArtifactStreamSchema = z.enum([
  "device.album",
  "device.artist",
  "device.finding",
  "device.label",
  "device.track",
  "device.track-artist",
  "sonar.track",
]);

export type ArtifactStream = z.infer<typeof ArtifactStreamSchema>;

export const ArtifactContractSchema = z.strictObject({
  formatVersion: z.number().int().positive(),
  stream: ArtifactStreamSchema,
  streamVersion: z.number().int().positive(),
});

export type ArtifactContract = z.infer<typeof ArtifactContractSchema>;

const ConsumerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);
const DigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const SequenceSchema = z.number().int().nonnegative();

export const ArtifactRebuildCheckpointSchema = ArtifactContractSchema.extend({
  completedAt: z.string().nullable(),
  consumerDigest: DigestSchema,
  consumerItemCount: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  generation: z.string().min(1).max(512),
  snapshotSeq: SequenceSchema,
  sourceDigest: DigestSchema,
  sourceItemCount: z.number().int().nonnegative(),
  startedAt: z.string(),
  state: z.enum(["complete", "running"]),
  updatedAt: z.string(),
});

export type ArtifactRebuildCheckpoint = z.infer<typeof ArtifactRebuildCheckpointSchema>;

export const ArtifactConsumerStatusSchema = z.strictObject({
  appliedThroughSeq: SequenceSchema.nullable(),
  checkpointedAt: z.string().nullable(),
  compactionBarrier: SequenceSchema.nullable(),
  consumerId: ConsumerIdSchema,
  contracts: z.array(ArtifactContractSchema),
  earliestSeq: SequenceSchema.nullable(),
  headSeq: SequenceSchema,
  rebuilds: z.array(ArtifactRebuildCheckpointSchema),
  registeredAt: z.string(),
  snapshotSeq: SequenceSchema.nullable(),
  state: z.enum(["active", "inactive", "rebuilding"]),
  stateChangedAt: z.string(),
  updatedAt: z.string(),
});

export type ArtifactConsumerStatus = z.infer<typeof ArtifactConsumerStatusSchema>;

export const ArtifactChangeEventSchema = z.strictObject({
  createdAt: z.string(),
  formatRegistered: z.boolean(),
  formatVersion: z.number().int().positive(),
  operation: z.enum(["delete", "upsert"]),
  payloadBlobBase64: z.string().max(6_000).nullable(),
  payloadDigest: DigestSchema,
  payloadJson: z.string().max(256 * 1024),
  producer: z.string(),
  revision: z.number().int().positive(),
  seq: SequenceSchema,
  // A deliberately open string: a consumer must be able to SEE and reject an event written by a
  // future/unknown producer version instead of failing response decoding before it sees metadata.
  stream: z.string().min(1).max(128),
  streamVersion: z.number().int().positive(),
  subjectId: z.string().min(1).max(1_024),
  subjectType: z.string().min(1).max(128),
  supportedByConsumer: z.boolean(),
});

export type ArtifactChangeEvent = z.infer<typeof ArtifactChangeEventSchema>;

export const ArtifactSnapshotItemSchema = ArtifactContractSchema.extend({
  operation: z.literal("upsert"),
  payloadBlobBase64: z.string().max(6_000).nullable(),
  payloadDigest: DigestSchema,
  payloadJson: z.string().max(256 * 1024),
  subjectId: z.string().min(1).max(1_024),
  subjectType: z.string().min(1).max(128),
});

export type ArtifactSnapshotItem = z.infer<typeof ArtifactSnapshotItemSchema>;

export const ArtifactSnapshotPageSchema = ArtifactContractSchema.extend({
  complete: z.boolean(),
  consumerId: ConsumerIdSchema,
  cursor: z.string().nullable(),
  generation: z.string(),
  headSeq: SequenceSchema,
  itemCount: z.number().int().nonnegative(),
  items: z.array(ArtifactSnapshotItemSchema).max(ARTIFACT_SNAPSHOT_API_MAX_LIMIT),
  ok: z.literal(true),
  pageDigest: DigestSchema,
  snapshotSeq: SequenceSchema,
  sourceDigest: DigestSchema,
});

export type ArtifactSnapshotPage = z.infer<typeof ArtifactSnapshotPageSchema>;

export const ArtifactChangePageSchema = z.strictObject({
  batchDigest: DigestSchema,
  consumerId: ConsumerIdSchema,
  events: z.array(ArtifactChangeEventSchema).max(ARTIFACT_CHANGE_API_MAX_LIMIT),
  fromSeq: SequenceSchema,
  hasMore: z.boolean(),
  headSeq: SequenceSchema,
  ok: z.literal(true),
  throughSeq: SequenceSchema,
});

export type ArtifactChangePage = z.infer<typeof ArtifactChangePageSchema>;

export const ArtifactCompactionResultSchema = z.strictObject({
  barrier: SequenceSchema.nullable(),
  deletedCount: z.number().int().nonnegative(),
  deletedFromSeq: SequenceSchema.nullable(),
  deletedThroughSeq: SequenceSchema.nullable(),
  ok: z.literal(true),
  reason: z.enum(["compacted", "empty", "no_safe_barrier"]),
});

export type ArtifactCompactionResult = z.infer<typeof ArtifactCompactionResultSchema>;

export const registerArtifactConsumer = oc
  .route({
    method: "POST",
    operationId: "registerArtifactConsumer",
    path: "/admin/artifacts/consumers",
    summary: "Register or re-register an artifact consumer at a fresh snapshot fence",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      consumerId: ConsumerIdSchema,
      contracts: z.array(ArtifactContractSchema).min(1).max(7),
    }),
  )
  .output(z.strictObject({ consumer: ArtifactConsumerStatusSchema, ok: z.literal(true) }));

export const getArtifactConsumer = oc
  .route({
    method: "GET",
    operationId: "getArtifactConsumer",
    path: "/admin/artifacts/consumers/{consumerId}",
    summary: "Read one artifact consumer's lifecycle, contracts, fences, and checkpoints",
    tags: ["Admin"],
  })
  .input(z.strictObject({ consumerId: ConsumerIdSchema }))
  .output(z.strictObject({ consumer: ArtifactConsumerStatusSchema, ok: z.literal(true) }));

export const listArtifactSnapshot = oc
  .route({
    method: "GET",
    operationId: "listArtifactSnapshot",
    path: "/admin/artifacts/snapshots",
    summary: "Read the next deterministic source-snapshot page for a rebuilding consumer",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      consumerId: ConsumerIdSchema,
      limit: z.coerce.number().int().min(1).max(ARTIFACT_SNAPSHOT_API_MAX_LIMIT).default(100),
      stream: ArtifactStreamSchema,
      streamVersion: z.coerce.number().int().positive(),
    }),
  )
  .output(ArtifactSnapshotPageSchema);

export const checkpointArtifactRebuild = oc
  .route({
    method: "POST",
    operationId: "checkpointArtifactRebuild",
    path: "/admin/artifacts/consumers/{consumerId}/rebuilds/{stream}/checkpoint",
    summary: "Re-read and durably checkpoint one exact source-snapshot page",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      consumerDigest: DigestSchema,
      consumerId: ConsumerIdSchema,
      consumerItemCount: z.number().int().nonnegative(),
      generation: z.string().min(1).max(512),
      pageDigest: DigestSchema,
      pageLimit: z.number().int().min(1).max(ARTIFACT_SNAPSHOT_API_MAX_LIMIT),
      stream: ArtifactStreamSchema,
      streamVersion: z.number().int().positive(),
    }),
  )
  .output(z.strictObject({ checkpoint: ArtifactRebuildCheckpointSchema, ok: z.literal(true) }));

export const activateArtifactConsumer = oc
  .route({
    method: "POST",
    operationId: "activateArtifactConsumer",
    path: "/admin/artifacts/consumers/{consumerId}/activate",
    summary: "Move a digest-complete rebuilt consumer onto its fenced change checkpoint",
    tags: ["Admin"],
  })
  .input(z.strictObject({ consumerId: ConsumerIdSchema }))
  .output(z.strictObject({ consumer: ArtifactConsumerStatusSchema, ok: z.literal(true) }));

export const listArtifactChanges = oc
  .route({
    method: "GET",
    operationId: "listArtifactChanges",
    path: "/admin/artifacts/changes",
    summary: "Read the next bounded global-sequence page from a consumer checkpoint",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      consumerId: ConsumerIdSchema,
      limit: z.coerce.number().int().min(1).max(ARTIFACT_CHANGE_API_MAX_LIMIT).default(100),
    }),
  )
  .output(ArtifactChangePageSchema);

export const acknowledgeArtifactChanges = oc
  .route({
    method: "POST",
    operationId: "acknowledgeArtifactChanges",
    path: "/admin/artifacts/consumers/{consumerId}/checkpoint",
    summary: "Durably acknowledge the exact next artifact event batch",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      batchDigest: DigestSchema,
      consumerId: ConsumerIdSchema,
      eventCount: z.number().int().min(1).max(ARTIFACT_CHANGE_API_MAX_LIMIT),
      fromSeq: SequenceSchema,
      throughSeq: SequenceSchema,
    }),
  )
  .output(z.strictObject({ consumer: ArtifactConsumerStatusSchema, ok: z.literal(true) }));

export const inactivateArtifactConsumer = oc
  .route({
    method: "POST",
    operationId: "inactivateArtifactConsumer",
    path: "/admin/artifacts/consumers/{consumerId}/inactivate",
    summary: "Inactivate a consumer and discard every reusable fence and checkpoint",
    tags: ["Admin"],
  })
  .input(z.strictObject({ consumerId: ConsumerIdSchema }))
  .output(z.strictObject({ consumer: ArtifactConsumerStatusSchema, ok: z.literal(true) }));

export const compactArtifactChanges = oc
  .route({
    method: "POST",
    operationId: "compactArtifactChanges",
    path: "/admin/artifacts/changes/compact",
    summary: "Delete one bounded prefix below every active or rebuilding consumer barrier",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      limit: z.number().int().min(1).max(ARTIFACT_COMPACTION_API_MAX_LIMIT).default(1_000),
    }),
  )
  .output(ArtifactCompactionResultSchema);

export const adminArtifactsContract = {
  acknowledge_artifact_changes: acknowledgeArtifactChanges,
  activate_artifact_consumer: activateArtifactConsumer,
  checkpoint_artifact_rebuild: checkpointArtifactRebuild,
  compact_artifact_changes: compactArtifactChanges,
  get_artifact_consumer: getArtifactConsumer,
  inactivate_artifact_consumer: inactivateArtifactConsumer,
  list_artifact_changes: listArtifactChanges,
  list_artifact_snapshot: listArtifactSnapshot,
  register_artifact_consumer: registerArtifactConsumer,
};

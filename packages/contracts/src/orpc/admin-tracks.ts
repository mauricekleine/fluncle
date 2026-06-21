// The `admin-tracks` domain contract module — the admin-gated track ops (the
// enrichment/curation write path + the video control-plane). This is the ADMIN
// wave's pattern-complete pilot (docs/orpc-migration-brief.md, the admin
// section): it exercises every admin pattern the fan-out will reuse —
//
//   - the FIELD-LEVEL role guard: `update_track` is on `adminProcedure` (both the
//     operator and the agent authenticate), and the handler reads `context.role`
//     to bound the agent to analysis fields (an operator-only field written by the
//     agent is a 403, not a silent drop);
//   - an `operatorProcedure` mint: `observe_track` (the live route is
//     `requireOperator`, so it stays operator-only — see the server module);
//   - the JSON video CONTROL-PLANE: `presign_track_video_uploads` +
//     `finalize_track_video` — the bytes go direct to R2 via the presigned URL, so
//     the bodies oRPC sees are plain JSON (in scope per the brief).
//
// Inputs are LOOSE/passthrough by design: the live admin routes do NOT
// schema-validate — they narrow `unknown` in-handler and emit their own codes
// (`invalid_request`/`note_too_long`/`no_fields`/…). A permissive contract keeps
// oRPC from pre-rejecting so that logic — and its exact codes — stays
// byte-for-byte for the admin consumers (the `fluncle admin` CLI + the enrichment
// agent). A future admin wave adds an op here and one import line in `./index.ts`,
// touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * The PATCH /admin/tracks/{trackId} body — the generic admin track update. LOOSE
 * + optional UNKNOWN: the live route narrows each field itself (number/string
 * guards, the `enrichmentStatus` enum, `parseEditorialNote`) and runs the
 * agent-role field guard, so the contract must not pre-reject. The handler reads
 * the raw input and reproduces that logic verbatim.
 */
const UpdateTrackBodySchema = z.looseObject({
  bpm: z.unknown().optional(),
  enrichmentStatus: z.unknown().optional(),
  features: z.unknown().optional(),
  isrc: z.unknown().optional(),
  key: z.unknown().optional(),
  logId: z.unknown().optional(),
  note: z.unknown().optional(),
  vibeX: z.unknown().optional(),
  vibeY: z.unknown().optional(),
  videoUrl: z.unknown().optional(),
});

/**
 * The observe body (POST /admin/tracks/{trackId}/observe). LOOSE: the live route
 * resolves the model/voice/duration defaults and voice-GATES the script itself
 * (emitting `no_script`/`voice_gate`), so the contract stays permissive to keep
 * those codes byte-for-byte.
 */
const ObserveTrackBodySchema = z.looseObject({
  contextNote: z.unknown().optional(),
  durationMs: z.unknown().optional(),
  durationTargetSec: z.unknown().optional(),
  model: z.unknown().optional(),
  script: z.unknown().optional(),
  voiceId: z.unknown().optional(),
  voiceSettings: z.unknown().optional(),
});

/**
 * The presign body (POST /admin/tracks/{trackId}/video/uploads). LOOSE: the live
 * route validates `fields` itself (`no_fields`/`bad_field`/`unknown_field`/
 * `no_footage`), so the contract stays permissive.
 */
const PresignVideoUploadsBodySchema = z.looseObject({
  fields: z.unknown().optional(),
});

/**
 * The finalize body (POST /admin/tracks/{trackId}/video/finalize). LOOSE: every
 * field is optional + normalized in-handler (trim/slice, the `squared` flag, the
 * model/reasoning defaults), so the contract stays permissive.
 */
const FinalizeVideoBodySchema = z.looseObject({
  squared: z.unknown().optional(),
  videoModel: z.unknown().optional(),
  videoModelReasoning: z.unknown().optional(),
  videoVehicle: z.unknown().optional(),
});

/** A presigned-upload row as `presign_track_video_uploads` returns it. */
const VideoUploadSchema = z
  .object({
    contentType: z.string(),
    field: z.string(),
    key: z.string(),
    url: z.string(),
  })
  .meta({ id: "VideoUpload" });

/**
 * `update_track` → `PATCH /admin/tracks/{trackId}` (operationId `updateTrack`).
 *
 * The generic admin track update (BPM/key/features/status/video/note/vibe/identity
 * backfill). On `adminProcedure` — BOTH the operator and the agent authenticate;
 * the FIELD-LEVEL role guard runs in-handler (the agent may write only analysis
 * fields; an operator-only field → 403 `forbidden`). Reuses `updateTrack`,
 * preserving the `{ ok: true, fields, trackId }` envelope and the live
 * `note_too_long`/422, `not_found`/404 codes.
 */
export const updateTrack = oc
  .route({
    method: "PATCH",
    operationId: "updateTrack",
    path: "/admin/tracks/{trackId}",
    summary: "Update a track's enrichment/curation fields (role-gated per field)",
    tags: ["Admin"],
  })
  .input(UpdateTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      fields: z.array(z.string()),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

/**
 * `observe_track` → `POST /admin/tracks/{trackId}/observe` (operationId
 * `observeTrack`).
 *
 * Mint the audio-observation artifact (render + R2 upload + write-back). On
 * `operatorProcedure` — the live route is `requireOperator`, so the agent role
 * gets a 403 (this MATCHES the live tier; the migration brief's "agent-allowed"
 * note is superseded by the codebase, which is authoritative). Reuses the live
 * handler logic verbatim, preserving the `{ ok: true, audioUrl, durationMs, … }`
 * envelope and the `no_script`/400, `voice_gate`/422, `no_log_id`/400 codes.
 */
export const observeTrack = oc
  .route({
    method: "POST",
    operationId: "observeTrack",
    path: "/admin/tracks/{trackId}/observe",
    summary: "Mint a track's spoken audio-observation artifact",
    tags: ["Admin"],
  })
  .input(ObserveTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      audioUrl: z.string(),
      durationMs: z.number(),
      generatedAt: z.string(),
      jsonUrl: z.string(),
      logId: z.string(),
      ok: z.literal(true),
      textUrl: z.string(),
      trackId: z.string(),
      voiceId: z.string(),
    }),
  );

/**
 * `presign_track_video_uploads` → `POST /admin/tracks/{trackId}/video/uploads`
 * (operationId `presignTrackVideoUploads`).
 *
 * Phase 1 of the presigned direct-to-R2 upload flow — the JSON control-plane: the
 * caller lists the artifact `fields`, the Worker signs one PUT URL per field
 * (bytes go straight to R2, bypassing the edge body limit). On `operatorProcedure`
 * (live `requireOperator`). Preserves the `{ ok: true, logId, trackId, uploads }`
 * envelope and the `no_fields`/`bad_field`/`unknown_field`/`no_footage` 400 codes.
 */
export const presignTrackVideoUploads = oc
  .route({
    method: "POST",
    operationId: "presignTrackVideoUploads",
    path: "/admin/tracks/{trackId}/video/uploads",
    summary: "Presign direct-to-R2 PUT URLs for a track's video artifacts",
    tags: ["Admin"],
  })
  .input(PresignVideoUploadsBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      uploads: z.array(VideoUploadSchema),
    }),
  );

/**
 * `finalize_track_video` → `POST /admin/tracks/{trackId}/video/finalize`
 * (operationId `finalizeTrackVideo`).
 *
 * Phase 2 of the presigned flow — links the canonical web cut (sets video_url to
 * <log-id>/footage.mp4 and stores the vehicle / model ledger; `squared` stamps the
 * two-master layout). On `operatorProcedure` (live `requireOperator`). Preserves
 * the `{ ok: true, logId, trackId, videoUrl }` envelope and the `not_found`/404,
 * `no_log_id`/400 codes.
 */
export const finalizeTrackVideo = oc
  .route({
    method: "POST",
    operationId: "finalizeTrackVideo",
    path: "/admin/tracks/{trackId}/video/finalize",
    summary: "Finalize a track's uploaded video bundle (link the canonical cut)",
    tags: ["Admin"],
  })
  .input(FinalizeVideoBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      videoUrl: z.string(),
    }),
  );

/** The `admin-tracks` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTracksContract = {
  finalize_track_video: finalizeTrackVideo,
  observe_track: observeTrack,
  presign_track_video_uploads: presignTrackVideoUploads,
  update_track: updateTrack,
};

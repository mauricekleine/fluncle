import { env } from "cloudflare:workers";
import { type InferContractRouterInputs } from "@orpc/contract";
import { ORPCError } from "@orpc/server";
import {
  type contract,
  MAX_CAPTURE_COMMIT_BATCH,
  MAX_CAPTURE_PREPARE_BATCH,
  MAX_EMBEDDING_WRITE_BATCH,
} from "@fluncle/contracts/orpc";
import { FOUND_BASE, trackMedia, videoVersion } from "../../media";
import { recordNoteAttempt } from "../backfill";
import { coerceEmbedding, EMBEDDING_DIMS } from "../embedding";
import { parseEditorialNote } from "../http-errors";
import { gateNoteText, noteEchoError, scoreNoteEcho, type NoteNeighbor } from "../note";
import { getNoteEchoThresholds, recordNoteRejection } from "../note-rejections";
import { publishTrack } from "../publish";
import { buildContextQuery, fetchTrackContext, gateObservationScript } from "../observation";
import { observationEchoError, scoreObservationEcho } from "../observation-echo";
import { observationNeighbours } from "../observation-neighbours";
import { renderAndStoreObservation } from "../observation-render";
import {
  getObservationEchoThresholds,
  recordObservationRejection,
} from "../observation-rejections";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ApiError } from "../spotify";
import { VIDEOS_BUCKET, presignUploads } from "../r2-presign";
import {
  clearCaptureSource,
  fillEmptyNote,
  isYoutubeVerification,
  parseCaptureSourceVideoId,
  pinCaptureSource,
  type TrackUpdate,
  updateTrack,
} from "../track-update";
import { isDueWorkMaintenancePending } from "../due-work";
import { countTrackWork, listTrackWork } from "../track-work";
import {
  authorizeCaptureReconciliation,
  commitCaptureReconciliation,
  commitCaptureReconciliations,
  prepareCaptureReconciliation,
  prepareCaptureReconciliations,
  type CaptureExternalResult,
  type CaptureReconciliationKind,
} from "../track-capture-reconciliation";
import { purgeVideoCache } from "../video-cache";
import {
  type EnrichmentStatusFilter,
  ENRICHMENT_STATUS_FILTERS,
  decodeTrackCursor,
  getMixableOrder,
  getObservationProvenance,
  getSimilarFindings,
  getTrackContextNote,
  listTracks,
  MixableOrderError,
  searchTracks,
} from "../tracks";
import { isLogId } from "../../log-id";
import { type VideoArtifact, artifactByField, readRenderManifestStamps } from "../video-bundle";
import { type Implementer, parseLimit, requireTrack, toFault } from "./_shared";

const OPERATOR_ONLY_FIELDS: (keyof TrackUpdate)[] = ["isrc", "logId", "note", "videoUrl"];

type AdminTrackInputs = InferContractRouterInputs<typeof contract>;
type PatchBody = AdminTrackInputs["update_track"];
type ObserveBody = AdminTrackInputs["observe_track"];
type NoteBody = AdminTrackInputs["note_track"];

const ADMIN_LIST_DEFAULT_LIMIT = 16;
const ADMIN_LIST_MAX_LIMIT = 48;

const NOTE_NEIGHBOR_LIMIT = 6;

async function noteNeighbors(trackId: string): Promise<NoteNeighbor[]> {
  const findings = await getSimilarFindings(trackId, NOTE_NEIGHBOR_LIMIT);

  return findings.flatMap((finding) =>
    finding.logId && finding.note?.trim()
      ? [{ logId: finding.logId, note: finding.note.trim() }]
      : [],
  );
}

function parseTriStateBool(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function normalizedVideoField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function parseEnrichmentStatus(value: string | undefined): EnrichmentStatusFilter | undefined {
  return value && (ENRICHMENT_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as EnrichmentStatusFilter)
    : undefined;
}

function parseAdminLimit(value: string | undefined): number {
  return parseLimit(value, ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT);
}

function resolveDurationTargetSec(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 90) {
    return Math.round(value);
  }

  return 30;
}

const TRACK_WORK_CAPABILITIES = {
  commitTrackCaptures: MAX_CAPTURE_COMMIT_BATCH,
  prepareTrackCaptures: MAX_CAPTURE_PREPARE_BATCH,
  updateTrackEmbeddings: MAX_EMBEDDING_WRITE_BATCH,
} as const;

const EMBEDDING_BATCH_WALL_BUDGET_MS = 45_000;

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type CaptureCommittedResult =
  | { applied: true; kind: "capture"; outcome: "done" | "failed" | "unmatched" }
  | {
      applied: true;
      kind: "youtube-provenance";
      outcome: "none" | "source-found" | "youtube-found";
    }
  | { applied: true; kind: "youtube-reverdict"; outcome: "reverdict" };

function isCaptureCommittedResult(value: unknown): value is CaptureCommittedResult {
  if (typeof value !== "object" || value === null || !("applied" in value)) {
    return false;
  }
  if (value.applied !== true || !("kind" in value) || !("outcome" in value)) {
    return false;
  }
  return (
    (value.kind === "capture" &&
      (value.outcome === "done" || value.outcome === "failed" || value.outcome === "unmatched")) ||
    (value.kind === "youtube-provenance" &&
      (value.outcome === "none" ||
        value.outcome === "source-found" ||
        value.outcome === "youtube-found")) ||
    (value.kind === "youtube-reverdict" && value.outcome === "reverdict")
  );
}

function isCaptureRejectedResult(value: unknown): value is { applied: false; reason: "stale" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "applied" in value &&
    value.applied === false &&
    "reason" in value &&
    value.reason === "stale"
  );
}

export function adminTracksHandlers(os: Implementer) {
  const prepareTrackCaptureHandler = os.prepare_track_capture
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const result = await prepareCaptureReconciliation(
          input.trackId,
          input.kind as CaptureReconciliationKind,
          input.priorSnapshotToken,
        );
        return { ok: true as const, ...result };
      } catch (error) {
        throw toFault(error);
      }
    });

  const authorizeTrackCaptureHandler = os.authorize_track_capture
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const result = await authorizeCaptureReconciliation({
          result: input.result as CaptureExternalResult,
          snapshotToken: input.snapshotToken,
          trackId: input.trackId,
        });
        return { ok: true as const, ...result };
      } catch (error) {
        throw toFault(error);
      }
    });

  const prepareTrackCapturesHandler = os.prepare_track_captures
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { deferred, reserved, results } = await prepareCaptureReconciliations(
          input.items.map((item) => ({
            kind: item.kind as CaptureReconciliationKind,
            ...(item.priorSnapshotToken === undefined
              ? {}
              : { priorSnapshotToken: item.priorSnapshotToken }),
            trackId: item.trackId,
          })),

          { reservedThisTick: input.reservedThisTick ?? 0 },
        );

        return { deferred, ok: true as const, reserved, results };
      } catch (error) {
        throw toFault(error);
      }
    });

  const commitTrackCapturesHandler = os.commit_track_captures
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { deferred, receipts } = await commitCaptureReconciliations(input.items);

        return {
          deferred,
          ok: true as const,
          receipts: receipts.map((receipt) => ({
            ...(receipt.elapsedMs === undefined ? {} : { elapsedMs: receipt.elapsedMs }),
            ...(receipt.error === undefined ? {} : { error: receipt.error }),
            outcome: receipt.outcome,
            replayed: receipt.replayed,
            ...(isCaptureCommittedResult(receipt.result) || isCaptureRejectedResult(receipt.result)
              ? { result: receipt.result }
              : {}),
            trackId: receipt.trackId,
          })),
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const updateTrackEmbeddingsHandler = os.update_track_embeddings
    .use(adminAuth)
    .handler(async ({ context, input }) => {
      const startedAt = performance.now();
      const results: {
        elapsedMs?: number;
        error?: string;
        fields?: string[];
        outcome: "deferred" | "failed" | "updated";
        trackId: string;
      }[] = [];
      let deferred = 0;

      for (const [index, item] of input.items.entries()) {
        if (index > 0 && performance.now() - startedAt >= EMBEDDING_BATCH_WALL_BUDGET_MS) {
          deferred += 1;
          results.push({ elapsedMs: 0, outcome: "deferred", trackId: item.trackId });
          continue;
        }

        const itemStartedAt = performance.now();
        const vector = coerceEmbedding(item.embedding);

        if (!vector) {
          results.push({
            elapsedMs: Math.max(0, Math.round(performance.now() - itemStartedAt)),
            error: `embedding must be a JSON array of ${EMBEDDING_DIMS} finite numbers`,
            outcome: "failed",
            trackId: item.trackId,
          });
          continue;
        }

        try {
          const result = await updateTrack(
            item.trackId,
            { embedding: JSON.stringify(vector) },
            { writer: context.role },
          );
          results.push({
            elapsedMs: Math.max(0, Math.round(performance.now() - itemStartedAt)),
            fields: result.fields,
            outcome: "updated",
            trackId: item.trackId,
          });
        } catch (error) {
          results.push({
            elapsedMs: Math.max(0, Math.round(performance.now() - itemStartedAt)),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            outcome: "failed",
            trackId: item.trackId,
          });
        }
      }

      return { deferred, ok: true as const, results };
    });

  const commitTrackCaptureHandler = os.commit_track_capture
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const outcome = await commitCaptureReconciliation(input);
        if (outcome.outcome === "lookup-failed") {
          throw new ApiError(
            "capture_receipt_lookup_failed",
            "The capture receipt could not be reconciled safely.",
            503,
          );
        }
        if (outcome.outcome === "committed") {
          if (!isCaptureCommittedResult(outcome.result)) {
            throw new ApiError(
              "capture_receipt_result_invalid",
              "The capture receipt returned an invalid terminal result.",
              503,
            );
          }
          return {
            ok: true as const,
            outcome: outcome.outcome,
            replayed: outcome.replayed,
            result: outcome.result,
          };
        }
        if (outcome.outcome === "rejected") {
          if (!isCaptureRejectedResult(outcome.result)) {
            throw new ApiError(
              "capture_receipt_result_invalid",
              "The capture receipt returned an invalid terminal result.",
              503,
            );
          }
          return {
            ok: true as const,
            outcome: outcome.outcome,
            replayed: outcome.replayed,
            result: outcome.result,
          };
        }
        return {
          ok: true as const,
          outcome: outcome.outcome,
          replayed: outcome.replayed,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const updateTrackHandler = os.update_track.use(adminAuth).handler(async ({ context, input }) => {
    try {
      const body: PatchBody = input;
      const trackId = body.trackId;
      const update: TrackUpdate = {};

      const parseAnalysisFields = (): void => {
        if (typeof body.bpm === "number" && Number.isFinite(body.bpm)) {
          update.bpm = body.bpm;
        }

        if (typeof body.key === "string") {
          update.key = body.key;
        }

        if (typeof body.bpmSource === "string" && body.bpmSource.trim()) {
          update.bpmSource = body.bpmSource;
        }

        if (typeof body.keySource === "string" && body.keySource.trim()) {
          update.keySource = body.keySource;
        }

        if (typeof body.bpmConfidence === "number" && Number.isFinite(body.bpmConfidence)) {
          update.bpmConfidence = body.bpmConfidence;
        }

        if (typeof body.keyConfidence === "number" && Number.isFinite(body.keyConfidence)) {
          update.keyConfidence = body.keyConfidence;
        }

        if (body.analyzedFrom === "preview" || body.analyzedFrom === "full") {
          update.analyzedFrom = body.analyzedFrom;
        }

        if (typeof body.analyzedAt === "string" && body.analyzedAt.trim()) {
          update.analyzedAt = body.analyzedAt;
        }

        if (typeof body.features === "string") {
          update.features = body.features;
        }

        if (body.embedding !== undefined) {
          if (body.embedding === "") {
            update.embedding = "";
          } else {
            const raw =
              typeof body.embedding === "string" ? safeJsonParse(body.embedding) : body.embedding;
            const vector = coerceEmbedding(raw);

            if (!vector) {
              throw new ORPCError("BAD_REQUEST", {
                data: {
                  apiCode: "invalid_embedding",
                  apiMessage: `embedding must be a JSON array of ${EMBEDDING_DIMS} finite numbers`,
                },
                message: `embedding must be a JSON array of ${EMBEDDING_DIMS} finite numbers`,
                status: 400,
              });
            }

            update.embedding = JSON.stringify(vector);
          }
        }
      };

      parseAnalysisFields();

      const parseFindingFields = (): void => {
        if (typeof body.videoUrl === "string") {
          update.videoUrl = body.videoUrl;
        }

        if (typeof body.galaxyId === "string") {
          update.galaxyId = body.galaxyId;
        }

        if (
          body.enrichmentStatus === "pending" ||
          body.enrichmentStatus === "done" ||
          body.enrichmentStatus === "failed"
        ) {
          update.enrichmentStatus = body.enrichmentStatus;
        }

        if (typeof body.note === "string") {
          update.note = parseEditorialNote(body.note);
        }

        if (typeof body.videoVehicle === "string" && body.videoVehicle.trim()) {
          update.videoVehicle = body.videoVehicle.trim().slice(0, 120);
        }

        if (typeof body.videoGrain === "string" && body.videoGrain.trim()) {
          update.videoGrain = body.videoGrain.trim().slice(0, 120);
        }

        if (typeof body.videoRegister === "string" && body.videoRegister.trim()) {
          update.videoRegister = body.videoRegister.trim().slice(0, 120);
        }

        if (typeof body.videoPalette === "string" && body.videoPalette.trim()) {
          update.videoPalette = body.videoPalette.trim().slice(0, 120);
        }

        if (typeof body.videoPlateSubject === "string" && body.videoPlateSubject.trim()) {
          update.videoPlateSubject = body.videoPlateSubject.trim().slice(0, 120);
        }

        if (typeof body.videoStructure === "string" && body.videoStructure.trim()) {
          update.videoStructure = body.videoStructure.trim().slice(0, 120);
        }

        if (typeof body.isrc === "string") {
          update.isrc = body.isrc;
        }

        if (typeof body.logId === "string") {
          update.logId = body.logId;
        }
      };

      parseFindingFields();

      const parseCaptureFields = (): void => {
        if (
          body.captureStatus === "pending" ||
          body.captureStatus === "done" ||
          body.captureStatus === "unmatched" ||
          body.captureStatus === "failed"
        ) {
          update.captureStatus = body.captureStatus;
        }

        if (typeof body.sourceAudioKey === "string" && body.sourceAudioKey.trim()) {
          update.sourceAudioKey = body.sourceAudioKey;
        }

        if (typeof body.sourceAudioCapturedAt === "string" && body.sourceAudioCapturedAt.trim()) {
          update.sourceAudioCapturedAt = body.sourceAudioCapturedAt;
        }

        if (typeof body.sourceAudioAttemptedAt === "string" && body.sourceAudioAttemptedAt.trim()) {
          update.sourceAudioAttemptedAt = body.sourceAudioAttemptedAt;
        }

        if (
          typeof body.sourceAudioFailures === "number" &&
          Number.isFinite(body.sourceAudioFailures)
        ) {
          update.sourceAudioFailures = body.sourceAudioFailures;
        }

        if (
          typeof body.sourceAudioBytes === "number" &&
          Number.isInteger(body.sourceAudioBytes) &&
          body.sourceAudioBytes >= 0
        ) {
          update.sourceAudioBytes = body.sourceAudioBytes;
        }

        if (
          body.captureVerification === "preview-match" ||
          body.captureVerification === "unverified" ||
          body.captureVerification === "mismatch"
        ) {
          update.captureVerification = body.captureVerification;
        }

        if (typeof body.captureVerifiedAt === "string" && body.captureVerifiedAt.trim()) {
          update.captureVerifiedAt = body.captureVerifiedAt;
        }

        if (typeof body.sourceAudioRejected === "string") {
          update.sourceAudioRejected = body.sourceAudioRejected;
        }

        if (
          body.sourceVerification === "soundcloud-preview-match" ||
          body.sourceVerification === "soundcloud-archive-match"
        ) {
          update.sourceVerification = body.sourceVerification;
        }

        if (typeof body.youtubeVideoId === "string" && body.youtubeVideoId.trim()) {
          update.youtubeVideoId = body.youtubeVideoId.trim();
        }

        if (isYoutubeVerification(body.youtubeVerification)) {
          update.youtubeVerification = body.youtubeVerification;
        }

        if (body.youtubeReverdict === true) {
          update.youtubeReverdict = true;
        }
      };

      parseCaptureFields();

      if (context.role === "agent") {
        const blocked = OPERATOR_ONLY_FIELDS.filter((field) => field in update);

        if (blocked.length > 0) {
          throw new ORPCError("FORBIDDEN", {
            data: {
              apiCode: "forbidden",
              apiMessage: `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
            },
            message: `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
            status: 403,
          });
        }
      }

      const result = await updateTrack(trackId, update, { writer: context.role });

      return { ok: true as const, ...result };
    } catch (error) {
      throw toFault(error);
    }
  });

  const getTrackAdminHandler = os.get_track_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const track = await requireTrack(input.trackId);

      return { ok: true as const, track };
    } catch (error) {
      throw toFault(error);
    }
  });

  const listTracksAdminHandler = os.list_tracks_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const q = input.q?.trim();

      if (q) {
        return {
          tracks: await searchTracks({
            limit: parseAdminLimit(input.limit),
            q,
          }),
        };
      }

      return await listTracks({
        captureQueue: parseTriStateBool(input.captureQueue) === true,
        cursor: decodeTrackCursor(input.cursor ?? null),
        hasContext: parseTriStateBool(input.hasContext),
        hasEmbedding: parseTriStateBool(input.hasEmbedding),
        hasKey: parseTriStateBool(input.hasKey),
        hasNote: parseTriStateBool(input.hasNote),
        hasObservation: parseTriStateBool(input.hasObservation),
        hasVideo: parseTriStateBool(input.hasVideo),
        limit: parseAdminLimit(input.limit),
        order: input.order === "asc" ? "asc" : "desc",
        retryEmptyContext: parseTriStateBool(input.retryEmptyContext) === true,
        status: parseEnrichmentStatus(input.status),
      });
    } catch (error) {
      throw toFault(error);
    }
  });

  const listTrackWorkHandler = os.list_track_work.use(adminAuth).handler(async ({ input }) => {
    try {
      const counting = input.count === "true";

      const debtAware = counting && input.debtAware === "true";
      let tracks: Awaited<ReturnType<typeof listTrackWork>> = [];
      let debtPending = false;
      try {
        tracks = await listTrackWork({
          kind: input.kind,
          limit: input.limit,
          scope: input.scope,
        });
      } catch (error) {
        if (!debtAware || !isDueWorkMaintenancePending(error)) {
          throw error;
        }
        debtPending = true;
      }

      const queued = counting
        ? await countTrackWork({ kind: input.kind, scope: input.scope })
        : undefined;

      return {
        capabilities: TRACK_WORK_CAPABILITIES,
        debtPending: debtAware ? debtPending : undefined,
        ok: true,
        queued,
        tracks,
      } as const;
    } catch (error) {
      throw toFault(error);
    }
  });

  const publishTrackHandler = os.publish_track
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const body: AdminTrackInputs["publish_track"] = input;

        if (typeof body.spotifyUrl !== "string") {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "invalid_request", apiMessage: "Missing Spotify track URL" },
            message: "Missing Spotify track URL",
            status: 400,
          });
        }

        const note = parseEditorialNote(body.note);

        const result = await publishTrack(body.spotifyUrl, {
          dryRun: body.dryRun === true,
          note: note || undefined,
        });

        return { ok: true as const, ...result };
      } catch (error) {
        throw toFault(error);
      }
    });

  const observeTrackHandler = os.observe_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: ObserveBody = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      const force = body.force === true;

      if (track.observationAudioUrl && !force) {
        const existingBase = encodeURIComponent(track.logId);

        return {
          audioUrl: track.observationAudioUrl,
          durationMs: track.observationDurationMs ?? 0,
          generatedAt: track.observationGeneratedAt ?? "",
          jsonUrl: `${FOUND_BASE}/${existingBase}/observation.json`,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          textUrl: trackMedia(track.logId).observationTextUrl,
          trackId: track.trackId,
          voiceId: "",
        };
      }

      const script = gateObservationScript(body.script, [...track.artists, track.title]);
      const durationTargetSec = resolveDurationTargetSec(body.durationTargetSec);
      let promptVersion = typeof body.promptVersion === "number" ? body.promptVersion : null;

      if (force && typeof body.promptVersion !== "number") {
        const stored = await getObservationProvenance(track.trackId);

        if (stored.script !== null && stored.script === script) {
          promptVersion = stored.promptVersion;
        }
      }

      if (!force) {
        const neighbors = await observationNeighbours(track.trackId);
        const thresholds = await getObservationEchoThresholds();
        const echo = scoreObservationEcho(script, neighbors, thresholds);

        if (echo.echoes) {
          try {
            await recordObservationRejection(track.trackId, script, echo, thresholds);
          } catch (ledgerError) {
            console.error("observe_track: failed to hold the rejected observation", ledgerError);
          }

          throw observationEchoError(echo);
        }
      }

      const result = await renderAndStoreObservation(track, script, {
        ...(typeof body.contextNote === "string" && body.contextNote.trim()
          ? { contextNote: body.contextNote }
          : {}),
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        durationTargetSec,
        promptVersion,
        ...(typeof body.voiceId === "string" ? { voiceId: body.voiceId } : {}),
      });

      return { ok: true as const, ...result };
    } catch (error) {
      throw toFault(error);
    }
  });

  const contextTrackHandler = os.context_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const idOrLogId = input.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      const refresh = input.refresh === true || input.refresh === "true";
      const existing = await getTrackContextNote(track.trackId);

      if (existing?.trim() && !refresh) {
        return {
          contextNote: existing,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          sources: [],
          trackId: track.trackId,
        };
      }

      const query =
        typeof input.query === "string" && input.query.trim()
          ? input.query.trim()
          : buildContextQuery(track);
      const fetched = await fetchTrackContext(
        query,
        {
          logId: track.logId,
          trackId: track.trackId,
        },

        { isrc: track.isrc },
      );

      if (fetched.status === "resolved" && fetched.contextNote.trim()) {
        await updateTrack(track.trackId, {
          contextNote: fetched.contextNote,

          contextPromptVersion: fetched.promptVersion,
          contextStatus: "resolved",
        });
      } else if (refresh && existing?.trim()) {
      } else {
        await updateTrack(track.trackId, { contextStatus: fetched.status });
      }

      const contextNote =
        fetched.status === "resolved" && fetched.contextNote.trim()
          ? fetched.contextNote
          : refresh && existing?.trim()
            ? existing
            : fetched.contextNote;

      return {
        contextNote,
        logId: track.logId,
        ok: true as const,
        sources: fetched.sources,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  const noteTrackHandler = os.note_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: NoteBody = input;
      const idOrLogId = body.trackId;

      const dryRun = body.dryRun === true;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every finding needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every finding needs a coordinate.",
          status: 400,
        });
      }

      if (!dryRun && track.note?.trim()) {
        await recordNoteAttempt(track.trackId, false);

        return {
          logId: track.logId,
          note: track.note,
          ok: true as const,
          skipped: true as const,
          trackId: track.trackId,
        };
      }

      const note = gateNoteText(body.note, [...track.artists, track.title]);

      const neighbors = await noteNeighbors(track.trackId);
      const thresholds = await getNoteEchoThresholds();
      const echo = scoreNoteEcho(note, neighbors, thresholds);

      if (echo.echoes) {
        if (!dryRun) {
          try {
            await recordNoteRejection(track.trackId, note, echo, thresholds);
          } catch (ledgerError) {
            console.error("note_track: failed to hold the rejected note", ledgerError);
          }
        }

        throw noteEchoError(echo);
      }

      if (dryRun) {
        return {
          dryRun: true as const,
          echo: { logId: echo.logId, overlap: echo.overlap, phrase: echo.phrase },
          logId: track.logId,
          neighbors: neighbors.map((neighbor) => neighbor.logId),
          note,
          ok: true as const,
          trackId: track.trackId,
        };
      }

      const filled = await fillEmptyNote(
        track.trackId,
        parseEditorialNote(note) ?? note,
        body.promptVersion,
      );

      if (!filled) {
        await recordNoteAttempt(track.trackId, false);
        const current = await requireTrack(idOrLogId);

        return {
          logId: track.logId,
          note: current.note ?? note,
          ok: true as const,
          skipped: true as const,
          trackId: track.trackId,
        };
      }

      await recordNoteAttempt(track.trackId, true);

      return {
        echo: { logId: echo.logId, overlap: echo.overlap, phrase: echo.phrase },
        logId: track.logId,
        note,
        ok: true as const,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  const presignVideoUploadsHandler = os.presign_track_video_uploads
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        const requested = Array.isArray(input.fields) ? input.fields : undefined;

        if (!requested || requested.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_fields",
              apiMessage: "List the artifact `fields` you want to upload",
            },
            message: "List the artifact `fields` you want to upload",
            status: 400,
          });
        }

        const artifacts: VideoArtifact[] = [];

        for (const field of requested) {
          if (typeof field !== "string") {
            throw new ORPCError("BAD_REQUEST", {
              data: { apiCode: "bad_field", apiMessage: "Each field must be a string" },
              message: "Each field must be a string",
              status: 400,
            });
          }

          const artifact = artifactByField(field);

          if (!artifact) {
            throw new ORPCError("BAD_REQUEST", {
              data: {
                apiCode: "unknown_field",
                apiMessage: `Unknown video artifact field: ${field}`,
              },
              message: `Unknown video artifact field: ${field}`,
              status: 400,
            });
          }

          artifacts.push(artifact);
        }

        const platesOnly =
          artifacts.length > 0 &&
          artifacts.every(
            (artifact) => artifact.field === "plate" || artifact.field === "plate-background",
          );

        if (!platesOnly && !artifacts.some((artifact) => artifact.field === "footage")) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_footage",
              apiMessage: "A `footage` cut (footage.mp4) is required",
            },
            message: "A `footage` cut (footage.mp4) is required",
            status: 400,
          });
        }

        const signed = await presignUploads(
          VIDEOS_BUCKET,
          artifacts.map((artifact) => ({
            contentType: artifact.contentType,
            key: `${track.logId}/${artifact.name}`,
          })),
        );

        const uploads = signed.map((row, index) => {
          const artifact = artifacts[index];
          if (artifact === undefined) {
            throw new Error("Presigned upload row has no matching artifact");
          }

          return {
            contentType: row.contentType,
            field: artifact.field,
            key: row.key,
            url: row.url,
          };
        });

        return { logId: track.logId, ok: true as const, trackId: track.trackId, uploads };
      } catch (error) {
        throw toFault(error);
      }
    });

  const finalizeVideoHandler = os.finalize_track_video.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: AdminTrackInputs["finalize_track_video"] = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      const bodyVehicle = normalizedVideoField(body.videoVehicle);
      const bodyGrain = normalizedVideoField(body.videoGrain);
      const bodyRegister = normalizedVideoField(body.videoRegister);
      const bodyPalette = normalizedVideoField(body.videoPalette);
      const bodyPlateSubject = normalizedVideoField(body.videoPlateSubject);
      const bodyStructure = normalizedVideoField(body.videoStructure);
      const bodyModel = normalizedVideoField(body.videoModel);
      const bodyReasoning = normalizedVideoField(body.videoModelReasoning);

      const manifestStamps =
        bodyVehicle && bodyGrain && bodyRegister && bodyPalette && bodyStructure && bodyPlateSubject
          ? {}
          : await readRenderManifestStamps(env.VIDEOS, track.logId);
      const videoVehicle = bodyVehicle ?? manifestStamps.vehicle;
      const videoGrain = bodyGrain ?? manifestStamps.grain;
      const videoRegister = bodyRegister ?? manifestStamps.register;
      const videoPalette = bodyPalette ?? manifestStamps.palette;
      const videoPlateSubject = bodyPlateSubject ?? manifestStamps.plateSubject;
      const videoStructure = bodyStructure ?? manifestStamps.structure;
      const videoModel = bodyModel ?? manifestStamps.model ?? "anthropic/claude-opus-5";
      const videoModelReasoning = bodyReasoning ?? manifestStamps.reasoning ?? "high";

      const videoUrl = trackMedia(track.logId).videoUrl;

      const squared = body.squared === true;

      const squaredAt = squared ? new Date().toISOString() : undefined;

      await updateTrack(track.trackId, {
        videoModel,
        videoModelReasoning,
        videoUrl,
        ...(squaredAt ? { videoSquaredAt: squaredAt } : {}),
        ...(videoVehicle ? { videoVehicle } : {}),
        ...(videoGrain ? { videoGrain } : {}),
        ...(videoRegister ? { videoRegister } : {}),
        ...(videoPalette ? { videoPalette } : {}),
        ...(videoPlateSubject ? { videoPlateSubject } : {}),
        ...(videoStructure ? { videoStructure } : {}),
      });

      purgeVideoCache(
        track.logId,
        squared || Boolean(track.videoSquaredAt),
        videoVersion(squaredAt ?? track.videoSquaredAt),
      );

      return { logId: track.logId, ok: true as const, trackId: track.trackId, videoUrl };
    } catch (error) {
      throw toFault(error);
    }
  });

  const requeueVideoHandler = os.requeue_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        if (!track.videoUrl && !track.videoSquaredAt) {
          return {
            alreadyClear: true as const,
            logId: track.logId,
            ok: true as const,
            trackId: track.trackId,
          };
        }

        await updateTrack(track.trackId, { videoSquaredAt: "", videoUrl: "" });

        return { logId: track.logId, ok: true as const, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  const purgeVideoHandler = os.purge_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        if (!track.videoUrl) {
          return {
            logId: track.logId,
            noVideo: true as const,
            ok: true as const,
            trackId: track.trackId,
          };
        }

        purgeVideoCache(
          track.logId,
          Boolean(track.videoSquaredAt),
          videoVersion(track.videoSquaredAt),
        );

        return { logId: track.logId, ok: true as const, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  const pinCaptureSourceHandler = os.pin_capture_source
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      const videoId = parseCaptureSourceVideoId(input.youtubeVideoId);

      if (videoId === null) {
        const message = `"${input.youtubeVideoId.trim().slice(0, 120)}" is not a YouTube video id or watch URL (expected 11 URL-safe characters, or a youtube.com / youtu.be / music.youtube.com link)`;

        throw new ORPCError("BAD_REQUEST", {
          data: { apiCode: "invalid_youtube_video_id", apiMessage: message },
          message,
          status: 400,
        });
      }

      try {
        const track = await requireTrack(input.trackId);

        const result = await pinCaptureSource(track.trackId, videoId, {
          allowDurationMismatch: input.allowDurationMismatch === true,
        });

        return { ...result, ok: true as const };
      } catch (error) {
        throw toFault(error);
      }
    });

  const clearCaptureSourceHandler = os.clear_capture_source
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const track = await requireTrack(input.trackId);
        const result = await clearCaptureSource(track.trackId);

        return { ...result, ok: true as const };
      } catch (error) {
        throw toFault(error);
      }
    });

  const getMixableOrderHandler = os.get_mixable_order.use(adminAuth).handler(async ({ input }) => {
    const ids = input.ids
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (ids.length < 2 || ids.length > 64) {
      throw new ORPCError("BAD_REQUEST", {
        data: { apiCode: "invalid_request", apiMessage: "Provide 2 to 64 Log IDs to order" },
        message: "Provide 2 to 64 Log IDs to order",
      });
    }

    const invalid = ids.filter((id) => !isLogId(id));

    if (invalid.length > 0) {
      throw new ORPCError("BAD_REQUEST", {
        data: {
          apiCode: "invalid_request",
          apiMessage: `Not a Log ID: ${invalid.join(", ")}`,
        },
        message: `Not a Log ID: ${invalid.join(", ")}`,
      });
    }

    if (input.seed !== undefined && !isLogId(input.seed)) {
      throw new ORPCError("BAD_REQUEST", {
        data: { apiCode: "invalid_request", apiMessage: `Not a Log ID: ${input.seed}` },
        message: `Not a Log ID: ${input.seed}`,
      });
    }

    try {
      const result = await getMixableOrder(ids, { seedLogId: input.seed });

      return { ...result, ok: true as const };
    } catch (error) {
      if (error instanceof MixableOrderError) {
        throw new ORPCError("BAD_REQUEST", {
          data: { apiCode: "invalid_request", apiMessage: error.message },
          message: error.message,
        });
      }

      throw toFault(error);
    }
  });

  return {
    authorize_track_capture: authorizeTrackCaptureHandler,
    clear_capture_source: clearCaptureSourceHandler,
    commit_track_capture: commitTrackCaptureHandler,
    commit_track_captures: commitTrackCapturesHandler,
    context_track: contextTrackHandler,
    finalize_track_video: finalizeVideoHandler,
    get_mixable_order: getMixableOrderHandler,
    get_track_admin: getTrackAdminHandler,
    list_track_work: listTrackWorkHandler,
    list_tracks_admin: listTracksAdminHandler,
    note_track: noteTrackHandler,
    observe_track: observeTrackHandler,
    pin_capture_source: pinCaptureSourceHandler,
    prepare_track_capture: prepareTrackCaptureHandler,
    prepare_track_captures: prepareTrackCapturesHandler,
    presign_track_video_uploads: presignVideoUploadsHandler,
    publish_track: publishTrackHandler,
    purge_video: purgeVideoHandler,
    requeue_video: requeueVideoHandler,
    update_track: updateTrackHandler,
    update_track_embeddings: updateTrackEmbeddingsHandler,
  };
}

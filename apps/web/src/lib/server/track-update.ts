import { type TrackUpdateResult } from "@fluncle/contracts";
import { type InStatement } from "@libsql/client";

export type { TrackUpdateResult };

export const YOUTUBE_VERIFICATION_VALUES = [
  "archive-match",
  "inconclusive",
  "metadata-match",
  "no-match",
  "preview-match",
] as const;

export type YoutubeVerification = (typeof YOUTUBE_VERIFICATION_VALUES)[number];

export function isYoutubeVerification(value: unknown): value is YoutubeVerification {
  return YOUTUBE_VERIFICATION_VALUES.some((candidate) => candidate === value);
}

import { isLogId } from "../log-id";
import { parseArtistsJson } from "./artists";
import {
  insertCurrentSonarTrackArtifactChangeInTransaction,
  prepareCurrentSonarTrackArtifactChange,
} from "./artifact-changes";
import {
  CATALOGUE_RANK_MATERIAL_REVISION_KEY,
  catalogueRankMaterialRevisionForFindingStatement,
} from "./catalogue";
import { getDb, typedRow } from "./db";
import { purgeLogCache } from "./edge-cache";
import {
  CLEAR_EMBEDDING_SQL,
  clearEmbeddingSatellite,
  coerceEmbedding,
  SET_EMBEDDING_SQL,
  toVectorProbe,
  writeEmbeddingSatellite,
} from "./embedding";
import { purgeTrackEntityPages } from "./entity-cache-purge";
import { type AdminRole } from "./env";
import { type IdentityMethod } from "./identity-envelope";
import { hasIsrc } from "./isrc";
import { rankableArtistDeltaForTrackStatement } from "./hub-counts";
import { resolveLogId } from "./log-id";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceStatements,
  markDueWorkSourceRepairsFromSelectStatement,
} from "./due-work";
import { ApiError } from "./spotify";
import { extractYoutubeVideoId } from "./youtube";
import { checkYoutubeOfficial } from "./youtube-official";
import { upsertTrackDuplicateKeyStatement } from "./track-duplicate-keys";

export type TrackUpdate = {
  analyzedAt?: string;
  analyzedFrom?: "preview" | "full";
  bpm?: number;
  bpmConfidence?: number;
  bpmSource?: string;

  captureStatus?:
    | "done"
    | "duplicate-cleared"
    | "failed"
    | "pending"
    | "quarantine-cleared"
    | "unmatched"
    | "wrong-audio";

  captureVerification?: "mismatch" | "preview-match" | "unverified";

  captureVerifiedAt?: string;

  contextNote?: string;

  contextPromptVersion?: number | null;

  contextStatus?: "pending" | "resolved" | "empty" | "failed";

  embedding?: string;
  enrichmentStatus?: "pending" | "processing" | "done" | "failed";

  features?: string;

  galaxyId?: string;

  isrc?: string;
  key?: string;
  keyConfidence?: number;
  keySource?: string;

  logId?: string;
  note?: string;

  notePromptVersion?: number | null;

  observationAlignmentJson?: string;

  observationAudioUrl?: string;

  observationDurationMs?: number;

  observationGeneratedAt?: string;

  observationPromptVersion?: number | null;
  observationScript?: string;

  sourceAudioAttemptedAt?: string;

  sourceAudioBytes?: number;

  sourceAudioCapturedAt?: string;

  sourceAudioFailures?: number;

  sourceAudioKey?: string;

  sourceAudioRejected?: string;

  sourceVerification?: "soundcloud-archive-match" | "soundcloud-preview-match";

  videoModel?: string;

  videoModelReasoning?: string;

  videoSquaredAt?: string;
  videoUrl?: string;

  videoVehicle?: string;

  videoGrain?: string;

  videoRegister?: string;

  videoPalette?: string;

  videoPlateSubject?: string;

  videoStructure?: string;

  youtubeReverdict?: boolean;

  youtubeVerification?: YoutubeVerification;

  youtubeVideoId?: string;
};

const VISIBLE_FIELDS = new Set<keyof TrackUpdate>([
  "bpm",
  "enrichmentStatus",
  "isrc",
  "key",
  "logId",
  "note",
  "observationAudioUrl",
  "observationDurationMs",
  "observationGeneratedAt",
  "videoGrain",
  "videoModel",
  "videoModelReasoning",
  "videoPalette",
  "videoPlateSubject",
  "videoRegister",
  "videoStructure",
  "videoSquaredAt",
  "videoUrl",
  "videoVehicle",
]);

const PROTECTED_SOURCES = new Set(["operator", "rekordbox"]);

const CERTIFICATION_FIELDS = new Set<keyof TrackUpdate>([
  "contextNote",
  "contextPromptVersion",
  "contextStatus",
  "enrichmentStatus",
  "galaxyId",
  "logId",
  "note",
  "notePromptVersion",
  "observationAlignmentJson",
  "observationAudioUrl",
  "observationDurationMs",
  "observationGeneratedAt",
  "observationPromptVersion",
  "observationScript",
  "videoGrain",
  "videoModel",
  "videoModelReasoning",
  "videoPalette",
  "videoPlateSubject",
  "videoRegister",
  "videoStructure",
  "videoSquaredAt",
  "videoUrl",
  "videoVehicle",
]);

type ExistingRow = {
  added_at: string | null;

  artists_json: string | null;
  bpm: number | null;
  bpm_source: string | null;

  certified: number;
  dismissed_at: string | null;
  duplicate_of_track_id: string | null;
  duration_ms: bigint | number | null;
  isrc: string | null;

  has_embedding: bigint | number;

  key: string | null;
  key_source: string | null;

  label: string | null;

  label_name: string | null;
  log_id: string | null;
  nearest_finding_score: number | null;
  spotify_uri: string | null;
  title: string;

  youtube_video_id: string | null;

  youtube_video_official: number | null;
};

async function prepareTrackSonarArtifact(
  existing: ExistingRow,
  update: TrackUpdate,
  hasFinding: boolean,
  effectiveLogId: string | null,
  trackId: string,
) {
  const embedding = update.embedding;

  if (embedding === undefined) {
    throw new ApiError("invalid_embedding", "Embedding material is missing", 400);
  }

  let vector: Uint8Array | null = null;

  if (embedding !== "") {
    let parsed: unknown;

    try {
      parsed = JSON.parse(embedding) as unknown;
    } catch {
      throw new ApiError("invalid_embedding", "Embedding is not valid JSON", 400);
    }

    const values = coerceEmbedding(parsed);

    if (values === null) {
      throw new ApiError(
        "invalid_embedding",
        "Embedding must be a JSON array of 1024 finite numbers",
        400,
      );
    }

    vector = toVectorProbe(values);
  }

  return prepareCurrentSonarTrackArtifactChange({
    anchored: existing.spotify_uri !== null,
    bpm: update.bpm ?? existing.bpm,
    certified: effectiveLogId !== null,
    dismissed: existing.dismissed_at !== null,
    durationMs: existing.duration_ms,
    hasFinding,
    isDuplicate: existing.duplicate_of_track_id !== null,
    key: update.key ?? existing.key,
    nearestFindingScore: existing.nearest_finding_score,
    producer: "track-update",
    trackId,
    vector,
  });
}

function recordingNames(existing: ExistingRow): { artists: string[]; labels: string[] } {
  const labels = [existing.label_name, existing.label]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());

  return { artists: parseArtistsJson(existing.artists_json ?? "[]"), labels };
}

function applySourceHierarchy(
  existing: ExistingRow,
  update: TrackUpdate,
  writer: AdminRole | undefined,
): boolean {
  if (writer === "agent") {
    const writesKey =
      update.key !== undefined ||
      update.keySource !== undefined ||
      update.keyConfidence !== undefined;
    const writesBpm =
      update.bpm !== undefined ||
      update.bpmSource !== undefined ||
      update.bpmConfidence !== undefined;
    const protectedKey =
      writesKey && existing.key_source && PROTECTED_SOURCES.has(existing.key_source);
    const protectedBpm =
      writesBpm && existing.bpm_source && PROTECTED_SOURCES.has(existing.bpm_source);
    if (protectedKey) {
      delete update.key;
      delete update.keySource;
      delete update.keyConfidence;
    }
    if (protectedBpm) {
      delete update.bpm;
      delete update.bpmSource;
      delete update.bpmConfidence;
    }
    return Boolean(protectedKey || protectedBpm);
  }
  if (writer === "operator") {
    if (update.key !== undefined && update.keySource === undefined) {
      update.keySource = "operator";
    }
    if (update.bpm !== undefined && update.bpmSource === undefined) {
      update.bpmSource = "operator";
    }
  }
  return false;
}

function assertCertificationUpdateAllowed(
  trackId: string,
  certified: boolean,
  update: TrackUpdate,
): void {
  if (certified) {
    return;
  }
  const refused = (Object.keys(update) as Array<keyof TrackUpdate>)
    .filter((field) => CERTIFICATION_FIELDS.has(field))
    .sort();
  if (refused.length > 0) {
    throw new ApiError(
      "uncertified",
      `${trackId} is a catalogue track (no finding), so it cannot take the certification field${
        refused.length > 1 ? "s" : ""
      } ${refused.join(", ")}. Analysis fields (bpm, key, features, embedding, capture) are allowed; certifying a track is publish_track's job.`,
      409,
    );
  }
}

async function updateTrackWithOptions(
  trackId: string,
  update: TrackUpdate,

  options: { writer?: AdminRole },
): Promise<TrackUpdateResult> {
  const db = await getDb();

  const existingResult = await db.execute({
    args: [trackId],

    sql: `select tracks.isrc, tracks.title, tracks.bpm, tracks.bpm_source, tracks.key_source,
                 tracks.key, tracks.has_embedding,
                 tracks.spotify_uri, tracks.dismissed_at, tracks.duplicate_of_track_id,
                 tracks.nearest_finding_score, tracks.duration_ms,
                 tracks.artists_json, tracks.youtube_video_id, tracks.youtube_video_official,
                 tracks.label, labels.name as label_name,
                 findings.log_id, findings.added_at,
                 (findings.track_id is not null) as certified
          from tracks
          left join findings on findings.track_id = tracks.track_id
          left join labels on labels.id = tracks.label_id
          where tracks.track_id = ? limit 1`,
  });
  const existing = typedRow<ExistingRow>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  const certified = Number(existing.certified) === 1;

  assertCertificationUpdateAllowed(trackId, certified, update);

  const guardDroppedFields = applySourceHierarchy(existing, update, options.writer);

  const sets: string[] = [];
  const args: Array<number | string | null> = [];
  const findingSets: string[] = [];
  const findingArgs: Array<number | string | null> = [];

  let embeddingStatement: InStatement | undefined;
  let catalogueRankMaterialRevision: string | undefined;

  let effectiveLogId = existing.log_id;

  const appendTempoAndKeyAnalysisFields = (): void => {
    if (update.bpm !== undefined) {
      sets.push("bpm = ?");
      args.push(update.bpm);
    }

    if (update.key !== undefined) {
      sets.push("key = ?");
      args.push(update.key);
    }

    if (update.bpmSource !== undefined) {
      sets.push("bpm_source = ?");
      args.push(update.bpmSource);
    }

    if (update.bpmConfidence !== undefined) {
      sets.push("bpm_confidence = ?");
      args.push(update.bpmConfidence);
    }

    if (update.keySource !== undefined) {
      sets.push("key_source = ?");
      args.push(update.keySource);
    }

    if (update.keyConfidence !== undefined) {
      sets.push("key_confidence = ?");
      args.push(update.keyConfidence);
    }

    if (update.analyzedFrom !== undefined) {
      sets.push("analyzed_from = ?");
      args.push(update.analyzedFrom);
    }

    if (update.analyzedAt !== undefined) {
      sets.push("analyzed_at = ?");
      args.push(update.analyzedAt);
    }
  };

  const appendVideoAndEnrichmentFields = (): void => {
    if (update.videoUrl !== undefined) {
      findingSets.push("video_url = ?");
      findingArgs.push(update.videoUrl === "" ? null : update.videoUrl);
    }

    if (update.videoVehicle !== undefined) {
      findingSets.push("video_vehicle = ?");
      findingArgs.push(update.videoVehicle);
    }

    if (update.videoGrain !== undefined) {
      findingSets.push("video_grain = ?");
      findingArgs.push(update.videoGrain);
    }

    if (update.videoRegister !== undefined) {
      findingSets.push("video_register = ?");
      findingArgs.push(update.videoRegister);
    }

    if (update.videoPalette !== undefined) {
      findingSets.push("video_palette = ?");
      findingArgs.push(update.videoPalette);
    }

    if (update.videoPlateSubject !== undefined) {
      findingSets.push("video_plate_subject = ?");
      findingArgs.push(update.videoPlateSubject);
    }

    if (update.videoStructure !== undefined) {
      findingSets.push("video_structure = ?");
      findingArgs.push(update.videoStructure);
    }

    if (update.videoModel !== undefined) {
      findingSets.push("video_model = ?");
      findingArgs.push(update.videoModel);
    }

    if (update.videoModelReasoning !== undefined) {
      findingSets.push("video_model_reasoning = ?");
      findingArgs.push(update.videoModelReasoning);
    }

    if (update.videoSquaredAt !== undefined) {
      findingSets.push("video_squared_at = ?");
      findingArgs.push(update.videoSquaredAt === "" ? null : update.videoSquaredAt);
    }

    if (update.enrichmentStatus !== undefined) {
      findingSets.push("enrichment_status = ?");
      findingArgs.push(update.enrichmentStatus);
    }
  };

  const appendFeatureEmbeddingAndGalaxyFields = (): void => {
    if (update.features !== undefined) {
      sets.push("features_json = ?");
      args.push(update.features);
    }

    if (update.embedding !== undefined) {
      if (update.embedding === "") {
        sets.push(CLEAR_EMBEDDING_SQL);
        embeddingStatement = clearEmbeddingSatellite(trackId);
      } else {
        sets.push(SET_EMBEDDING_SQL);
        embeddingStatement = writeEmbeddingSatellite(trackId, update.embedding);
      }
      catalogueRankMaterialRevision = `track-update:${crypto.randomUUID()}`;
    }

    if (update.galaxyId !== undefined) {
      findingSets.push("galaxy_id = ?");
      findingArgs.push(update.galaxyId === "" ? null : update.galaxyId);
    }
  };

  const appendCaptureStorageFields = (): void => {
    if (update.captureStatus !== undefined) {
      sets.push(
        "capture_status = case when capture_status = 'duplicate-cleared' then capture_status else ? end",
      );
      args.push(update.captureStatus);
    }

    if (update.sourceAudioKey !== undefined) {
      sets.push("source_audio_key = ?");
      args.push(update.sourceAudioKey);
    }

    if (update.captureVerification !== undefined) {
      sets.push("capture_verification = ?");
      args.push(update.captureVerification);
    }

    if (update.captureVerifiedAt !== undefined) {
      sets.push("capture_verified_at = ?");
      args.push(update.captureVerifiedAt);
    }

    if (update.sourceAudioRejected !== undefined) {
      sets.push("source_audio_rejected = ?");
      args.push(update.sourceAudioRejected === "" ? null : update.sourceAudioRejected);
    }

    if (update.sourceAudioCapturedAt !== undefined) {
      sets.push("source_audio_captured_at = ?");
      args.push(update.sourceAudioCapturedAt);
    }

    if (update.sourceAudioAttemptedAt !== undefined) {
      sets.push("source_audio_attempted_at = ?");
      args.push(update.sourceAudioAttemptedAt);
    }

    if (update.sourceAudioFailures !== undefined) {
      sets.push("source_audio_failures = ?");
      args.push(update.sourceAudioFailures);
    }

    if (update.sourceAudioBytes !== undefined) {
      sets.push("source_audio_bytes = ?");
      args.push(update.sourceAudioBytes);
    }
  };

  appendTempoAndKeyAnalysisFields();
  appendVideoAndEnrichmentFields();
  appendFeatureEmbeddingAndGalaxyFields();
  appendCaptureStorageFields();

  const askedSourceVerification = update.sourceVerification !== undefined;
  const askedYoutube =
    update.youtubeVideoId !== undefined ||
    update.youtubeVerification !== undefined ||
    update.youtubeReverdict !== undefined;
  const appendCaptureProvenanceFields = async (): Promise<void> => {
    const sourceVerification =
      update.sourceVerification === "soundcloud-preview-match" ||
      update.sourceVerification === "soundcloud-archive-match"
        ? update.sourceVerification
        : undefined;
    if (sourceVerification !== undefined) {
      sets.push("source_verification = ?");
      args.push(sourceVerification);
    }

    const YOUTUBE_PROOF_METHODS: Partial<Record<YoutubeVerification, IdentityMethod>> = {
      "archive-match": "fingerprint",
      "metadata-match": "search",
      "preview-match": "fingerprint",
    };

    const provenanceMethod: IdentityMethod | undefined =
      update.captureVerification === "preview-match"
        ? "fingerprint"
        : typeof update.youtubeVerification === "string"
          ? YOUTUBE_PROOF_METHODS[update.youtubeVerification]
          : undefined;

    if (
      update.youtubeVideoId !== undefined &&
      provenanceMethod !== undefined &&
      !existing.youtube_video_id
    ) {
      const official = await checkYoutubeOfficial(update.youtubeVideoId, recordingNames(existing));

      sets.push(
        "youtube_video_id = coalesce(youtube_video_id, ?)",
        "youtube_video_official = case when youtube_video_id is null then ? else youtube_video_official end",
        "youtube_verified_at = case when youtube_video_id is null then ? else youtube_verified_at end",

        "youtube_verified_by = case when youtube_video_id is null then ? else youtube_verified_by end",
      );
      args.push(update.youtubeVideoId, official, new Date().toISOString(), provenanceMethod);
    }

    const youtubeSettledNothing =
      (update.youtubeVerification === "no-match" ||
        update.youtubeVerification === "inconclusive") &&
      update.youtubeVideoId === undefined &&
      !existing.youtube_video_id;

    if (youtubeSettledNothing) {
      sets.push("youtube_provenance_failures = coalesce(youtube_provenance_failures, 0) + 1");
    }

    if (youtubeSettledNothing && update.youtubeVerification === "no-match") {
      sets.push(
        "youtube_verified_at = case when youtube_video_id is null then ? else youtube_verified_at end",
      );
      args.push(new Date().toISOString());
    }

    if (
      update.youtubeReverdict === true &&
      existing.youtube_video_id &&
      Number(existing.youtube_video_official) !== 1
    ) {
      const official = await checkYoutubeOfficial(
        existing.youtube_video_id,
        recordingNames(existing),
      );

      if (official !== null) {
        sets.push("youtube_video_official = ?");
        args.push(official);
      }

      sets.push("youtube_verified_at = ?");
      args.push(new Date().toISOString());
    }
  };

  await appendCaptureProvenanceFields();

  const appendEditorialFields = (): void => {
    if (update.note !== undefined) {
      findingSets.push("note = ?");
      findingArgs.push(update.note);

      if (update.notePromptVersion === undefined) {
        findingSets.push("note_prompt_version = ?");
        findingArgs.push(null);
      }
    }

    if (update.notePromptVersion !== undefined) {
      findingSets.push("note_prompt_version = ?");
      findingArgs.push(update.notePromptVersion);
    }

    if (update.contextNote !== undefined) {
      findingSets.push("context_note = ?");
      findingArgs.push(update.contextNote);

      if (update.contextPromptVersion === undefined) {
        findingSets.push("context_prompt_version = ?");
        findingArgs.push(null);
      }
    }

    if (update.contextPromptVersion !== undefined) {
      findingSets.push("context_prompt_version = ?");
      findingArgs.push(update.contextPromptVersion);
    }

    if (update.contextStatus !== undefined) {
      findingSets.push("context_status = ?");
      findingArgs.push(update.contextStatus);
    }

    if (update.observationAlignmentJson !== undefined) {
      findingSets.push("observation_alignment_json = ?");
      findingArgs.push(
        update.observationAlignmentJson === "" ? null : update.observationAlignmentJson,
      );
    }

    if (update.observationAudioUrl !== undefined) {
      findingSets.push("observation_audio_url = ?");
      findingArgs.push(update.observationAudioUrl === "" ? null : update.observationAudioUrl);
    }

    if (update.observationDurationMs !== undefined) {
      findingSets.push("observation_duration_ms = ?");
      findingArgs.push(update.observationDurationMs);
    }

    if (update.observationGeneratedAt !== undefined) {
      findingSets.push("observation_generated_at = ?");
      findingArgs.push(update.observationGeneratedAt);
    }

    if (update.observationPromptVersion !== undefined) {
      findingSets.push("observation_prompt_version = ?");
      findingArgs.push(update.observationPromptVersion);
    }

    if (update.observationScript !== undefined && update.observationPromptVersion === undefined) {
      findingSets.push("observation_prompt_version = ?");
      findingArgs.push(null);
    }

    if (update.observationScript !== undefined) {
      findingSets.push("observation_script = ?");
      findingArgs.push(update.observationScript === "" ? null : update.observationScript);
    }
  };

  appendEditorialFields();

  const appendIdentityFields = async (): Promise<void> => {
    if (update.isrc !== undefined) {
      if (existing.isrc?.trim()) {
        throw new ApiError("immutable", "isrc is already set; identity fields never change", 409);
      }

      if (!update.isrc.trim()) {
        throw new ApiError("invalid_isrc", "isrc must be a non-empty string", 400);
      }

      sets.push("isrc = ?");
      args.push(update.isrc.trim());

      sets.push("has_isrc = ?");
      args.push(hasIsrc(update.isrc));
    }

    if (update.logId !== undefined) {
      if (existing.log_id?.trim()) {
        throw new ApiError("immutable", "log_id is already set; coordinates are permanent", 409);
      }

      let logId: string;

      const foundAt = existing.added_at;

      if (!foundAt) {
        throw new ApiError("not_found", `No finding for track ${trackId}`, 404);
      }

      if (update.logId === "auto") {
        logId = await resolveLogId(
          {
            foundAt,
            isrc: update.isrc?.trim() || existing.isrc,
            trackId,
          },
          async (candidate) => {
            const taken = await db.execute({
              args: [candidate],
              sql: `select 1 from findings where log_id = ? limit 1`,
            });

            return taken.rows.length > 0;
          },
        );
      } else {
        if (!isLogId(update.logId)) {
          throw new ApiError(
            "invalid_log_id",
            `"${update.logId}" is not a Log ID coordinate (expected sector.orbit.mark, e.g. 004.7.2I, or "auto")`,
            400,
          );
        }

        const taken = await db.execute({
          args: [update.logId],
          sql: `select 1 from findings where log_id = ? limit 1`,
        });

        if (taken.rows.length > 0) {
          throw new ApiError("log_id_taken", `${update.logId} already names another finding`, 409);
        }

        logId = update.logId;
      }

      findingSets.push("log_id = ?");
      findingArgs.push(logId);
      effectiveLogId = logId;
    }
  };

  await appendIdentityFields();

  if (sets.length === 0 && findingSets.length === 0) {
    if (guardDroppedFields || askedYoutube || askedSourceVerification) {
      return { fields: [], trackId };
    }

    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  const touchesVisible = (Object.keys(update) as Array<keyof TrackUpdate>).some((field) =>
    VISIBLE_FIELDS.has(field),
  );

  if (touchesVisible && certified) {
    findingSets.push("updated_at = ?");
    findingArgs.push(new Date().toISOString());
  }

  const wasRankable = existing.key !== null && Number(existing.has_embedding) === 1;
  const nextKey = update.key === undefined ? existing.key : update.key;
  const nextHasEmbedding =
    update.embedding === undefined ? Number(existing.has_embedding) === 1 : update.embedding !== "";
  const isRankable = nextKey !== null && nextHasEmbedding;
  const rankableDelta = Number(isRankable) - Number(wasRankable);

  const statements = [
    ...(sets.length > 0
      ? [
          {
            args: [...args, trackId],
            sql: `update tracks set ${sets.join(", ")} where track_id = ?`,
          },
        ]
      : []),
    ...(update.isrc !== undefined
      ? [
          upsertTrackDuplicateKeyStatement({
            artistsJson: existing.artists_json ?? "[]",
            isrc: update.isrc.trim(),
            title: existing.title,
            trackId,
          }),
        ]
      : []),
    ...(findingSets.length > 0
      ? [
          {
            args: [...findingArgs, trackId],
            sql: `update findings set ${findingSets.join(", ")} where track_id = ?`,
          },
        ]
      : []),
    ...(embeddingStatement ? [embeddingStatement] : []),
    ...(catalogueRankMaterialRevision === undefined
      ? []
      : [catalogueRankMaterialRevisionForFindingStatement(trackId, catalogueRankMaterialRevision)]),
    ...markDueWorkSourceMaintenanceStatements([{ subjectId: trackId, subjectType: "track" }], {
      producer: "track-update",
      publicProjectionImpact: {
        impact: update.key === undefined ? "neither" : "public_aggregates",
        justification:
          update.key === undefined
            ? "This update does not write tracks.key."
            : "This update writes tracks.key.",
      },
    }),
    ...(catalogueRankMaterialRevision === undefined
      ? []
      : [
          markDueWorkSourceRepairsFromSelectStatement(
            "track",
            {
              args: [
                DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                trackId,
                CATALOGUE_RANK_MATERIAL_REVISION_KEY,
                catalogueRankMaterialRevision,
              ],
              sql: `select ? as subject_id
                where exists (select 1 from findings where track_id = ?)
                  and exists (select 1 from settings where key = ? and value = ?)`,
            },
            { markerVersion: catalogueRankMaterialRevision, producer: "track-update" },
          ),
        ]),
    ...(rankableDelta === 0
      ? []
      : [rankableArtistDeltaForTrackStatement(trackId, rankableDelta > 0 ? 1 : -1)]),
  ];

  if (embeddingStatement === undefined) {
    await db.batch(statements, "write");
  } else {
    const preparedArtifact = await prepareTrackSonarArtifact(
      existing,
      update,
      certified,
      effectiveLogId,
      trackId,
    );

    const transaction = await db.transaction("write");

    try {
      await transaction.batch(statements);
      await insertCurrentSonarTrackArtifactChangeInTransaction(transaction, preparedArtifact);
      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {}

      throw error;
    } finally {
      transaction.close();
    }
  }

  purgeLogCache(effectiveLogId);
  purgeTrackEntityPages(trackId);

  return {
    fields: [...sets, ...findingSets, ...(embeddingStatement ? ["embedding_blob"] : [])].map(
      (set) => set.split(" ")[0] ?? set,
    ),
    trackId,
  };
}

export function updateTrack(
  trackId: string,
  update: TrackUpdate,
  options: { writer?: AdminRole } = {},
): Promise<TrackUpdateResult> {
  return updateTrackWithOptions(trackId, update, options);
}

export async function fillEmptyNote(
  trackId: string,
  note: string,
  promptVersion?: number | null,
): Promise<boolean> {
  const db = await getDb();
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select log_id from findings where track_id = ? limit 1`,
  });
  const existing = typedRow<{ log_id: string | null }>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  const results = await db.batch(
    [
      {
        args: [note, promptVersion ?? null, new Date().toISOString(), trackId],
        sql: `update findings
                set note = ?, note_prompt_version = ?, updated_at = ?
              where track_id = ?
                and (note is null or trim(note) = '')`,
      },
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: trackId, subjectType: "track" }], {
        onlyIfPreviousStatementChanged: true,
        producer: "track-note-fill",
      }),
    ],
    "write",
  );
  const result = results[0];

  const filled = (result?.rowsAffected ?? 0) > 0;

  if (filled) {
    purgeLogCache(existing.log_id);
    purgeTrackEntityPages(trackId);
  }

  return filled;
}

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube.com",
  "youtu.be",
  "youtube.com",
]);

export function parseCaptureSourceVideoId(input: string): null | string {
  const value = input.trim();

  if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) {
    return value;
  }

  let url: URL;

  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  return extractYoutubeVideoId(url.toString());
}

export type CaptureSourcePinResult = {
  captureSourcePin: null | string;

  captureSourcePinAllowDuration: boolean;
  captureStatus: string;
  logId: null | string;
  trackId: string;
};

type CaptureSourcePinRow = {
  artists_json: string | null;
  capture_source_pin: string | null;
  capture_source_pin_allow_duration: bigint | null | number;
  capture_status: string;
  label: string | null;
  label_name: string | null;
  log_id: string | null;
};

async function readCaptureSourcePinRow(trackId: string): Promise<CaptureSourcePinRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select tracks.artists_json, tracks.capture_source_pin,
                 tracks.capture_source_pin_allow_duration, tracks.capture_status,
                 tracks.label, labels.name as label_name, findings.log_id
          from tracks
          left join findings on findings.track_id = tracks.track_id
          left join labels on labels.id = tracks.label_id
          where tracks.track_id = ? limit 1`,
  });
  const row = typedRow<CaptureSourcePinRow>(result.rows);

  if (!row) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  return row;
}

export async function pinCaptureSource(
  trackId: string,
  videoId: string,
  options: { allowDurationMismatch?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<CaptureSourcePinResult> {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new ApiError(
      "invalid_youtube_video_id",
      `"${videoId}" is not a YouTube video id (11 URL-safe characters, or a youtube.com / youtu.be / music.youtube.com URL)`,
      400,
    );
  }

  const existing = await readCaptureSourcePinRow(trackId);
  const labels = [existing.label_name, existing.label]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  const official = await checkYoutubeOfficial(
    videoId,
    { artists: parseArtistsJson(existing.artists_json ?? "[]"), labels },
    options.fetchImpl,
  );
  const now = new Date().toISOString();
  const db = await getDb();

  await db.batch(
    [
      {
        args: [
          videoId,
          options.allowDurationMismatch === true ? 1 : 0,
          videoId,
          official,
          now,
          trackId,
        ],
        sql: `update tracks
                set capture_source_pin = ?,
                    capture_source_pin_allow_duration = ?,
                    capture_status = case when capture_status = 'duplicate-cleared' then capture_status else 'pending' end,
                    source_audio_failures = 0,
                    source_audio_rejected = null,
                    youtube_video_id = ?,
                    youtube_video_official = ?,
                    youtube_verified_at = ?,
                    youtube_verified_by = 'operator',
                    source_verification = 'operator'
              where track_id = ?`,
      },
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: trackId, subjectType: "track" }], {
        producer: "track-capture-source-pin",
      }),
    ],
    "write",
  );

  const after = await readCaptureSourcePinRow(trackId);

  return {
    captureSourcePin: after.capture_source_pin,
    captureSourcePinAllowDuration: Number(after.capture_source_pin_allow_duration ?? 0) === 1,
    captureStatus: after.capture_status,
    logId: after.log_id,
    trackId,
  };
}

export async function clearCaptureSource(trackId: string): Promise<CaptureSourcePinResult> {
  const existing = await readCaptureSourcePinRow(trackId);
  const db = await getDb();

  await db.batch(
    [
      {
        args: [trackId],

        sql: `update tracks
                set capture_source_pin = null,
                    capture_source_pin_allow_duration = 0,
                    youtube_video_id = case when youtube_verified_by = 'operator' then null else youtube_video_id end,
                    youtube_video_official = case when youtube_verified_by = 'operator' then null else youtube_video_official end,
                    youtube_verified_at = case when youtube_verified_by = 'operator' then null else youtube_verified_at end,
                    source_verification = case when source_verification = 'operator' then null else source_verification end,
                    youtube_verified_by = case when youtube_verified_by = 'operator' then null else youtube_verified_by end
              where track_id = ?`,
      },
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: trackId, subjectType: "track" }], {
        producer: "track-capture-source-pin-clear",
      }),
    ],
    "write",
  );

  return {
    captureSourcePin: null,
    captureSourcePinAllowDuration: false,
    captureStatus: existing.capture_status,
    logId: existing.log_id,
    trackId,
  };
}

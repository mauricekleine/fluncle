import {
  type FinalizeResponse,
  type PresignResponse,
  type TrackGetResponse,
  type TrackListItem,
  type TrackSocialShowResponse,
  type TrackSocialUpdateResponse,
  type TrackUpdateResponse,
} from "@fluncle/contracts";
import {
  adminApiDelete,
  adminApiGet,
  adminApiPatch,
  adminApiPost,
  adminApiPut,
  publicApiGet,
} from "../api";
import { CliError } from "../output";

export type TrackGetResult = TrackGetResponse;

export async function trackGetCommand(idOrLogId: string): Promise<TrackGetResult> {
  return publicApiGet<TrackGetResult>(`/api/v1/tracks/${encodeURIComponent(idOrLogId)}`);
}

export type TrackSimilarResult = { findings: TrackListItem[]; ok: true };

export async function trackSimilarCommand(
  idOrLogId: string,
  limit?: number,
): Promise<TrackSimilarResult> {
  const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;

  return publicApiGet<TrackSimilarResult>(
    `/api/v1/tracks/${encodeURIComponent(idOrLogId)}/similar${query}`,
  );
}

export type TrackGetAdminResult = { ok: true; track: TrackListItem };

export async function trackGetAdminCommand(idOrLogId: string): Promise<TrackGetAdminResult> {
  return adminApiGet<TrackGetAdminResult>(`/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}`);
}

export type TrackUpdateOptions = {
  analyzedAt?: string;
  analyzedFrom?: string;
  bpm?: number;
  bpmConfidence?: number;
  bpmSource?: string;
  embedding?: number[];
  features?: string;
  galaxyId?: string;
  isrc?: string;
  key?: string;
  keyConfidence?: number;
  keySource?: string;
  note?: string;
  status?: string;
  videoUrl?: string;
};

type TrackUpdateBody = {
  analyzedAt?: string;
  analyzedFrom?: string;
  bpm?: number;
  bpmConfidence?: number;
  bpmSource?: string;
  embedding?: number[];
  enrichmentStatus?: string;
  features?: string;
  galaxyId?: string;
  isrc?: string;
  key?: string;
  keyConfidence?: number;
  keySource?: string;
  note?: string;
  videoUrl?: string;
};

export type TrackVideoOptions = {
  composition?: string;
  cover?: string;
  footage?: string;
  footageLandscape?: string;
  footageLandscapeSocial?: string;
  footageNotext?: string;
  footageSocial?: string;
  intent?: string;
  metrics?: string;
  model?: string;
  note?: string;
  plate?: string;
  plateBackground?: string;
  poster?: string;
  props?: string;
  reasoning?: string;
  render?: string;
  scene?: string;
};

const DEFAULT_VIDEO_MODEL = "anthropic/claude-opus-5";

const DEFAULT_VIDEO_REASONING = "high";

export type TrackVideoResult = {
  logId: string;
  ok: true;
  trackId: string;
  urls: Record<string, string>;
};

const FOUND_BASE = "https://found.fluncle.com";

const VIDEO_FIELDS: ReadonlyArray<{ field: string; option: keyof TrackVideoOptions }> = [
  { field: "footage", option: "footage" },
  { field: "footage-social", option: "footageSocial" },
  { field: "footage-notext", option: "footageNotext" },
  { field: "footage-landscape", option: "footageLandscape" },
  { field: "footage-landscape-social", option: "footageLandscapeSocial" },
  { field: "poster", option: "poster" },
  { field: "cover", option: "cover" },
  { field: "plate", option: "plate" },
  { field: "plate-background", option: "plateBackground" },
  { field: "note", option: "note" },
  { field: "composition", option: "composition" },
  { field: "props", option: "props" },
  { field: "render", option: "render" },
  { field: "intent", option: "intent" },
  { field: "metrics", option: "metrics" },
  { field: "scene", option: "scene" },
];

const RERENDER_CONTRACT_FIELDS: ReadonlyArray<{ file: string; option: keyof TrackVideoOptions }> = [
  { file: "composition.tsx", option: "composition" },
  { file: "props.json", option: "props" },
  { file: "render.json", option: "render" },
];

const RERENDER_ADVISORY_FIELDS: ReadonlyArray<{ file: string; option: keyof TrackVideoOptions }> = [
  { file: "intent.json", option: "intent" },
  { file: "metrics.json", option: "metrics" },
  { file: "scene.json", option: "scene" },
];

const FOOTAGE_FIELDS: ReadonlyArray<keyof TrackVideoOptions> = [
  "footage",
  "footageSocial",
  "footageNotext",
  "footageLandscape",
  "footageLandscapeSocial",
];

const PLATE_FIELDS: ReadonlyArray<keyof TrackVideoOptions> = ["plate", "plateBackground"];

const NON_FILE_OPTIONS: ReadonlyArray<keyof TrackVideoOptions> = ["model", "reasoning"];

export function isPlatesOnlyUpload(files: TrackVideoOptions): boolean {
  const hasPlate = PLATE_FIELDS.some((option) => Boolean(files[option]));
  if (!hasPlate) {
    return false;
  }
  return (Object.keys(files) as Array<keyof TrackVideoOptions>).every(
    (option) =>
      !files[option] || PLATE_FIELDS.includes(option) || NON_FILE_OPTIONS.includes(option),
  );
}

export type BundleCompleteness = {
  uploadingFootage: boolean;

  missingContract: string[];

  missingAdvisory: string[];

  plateWarnings: string[];
};

export function checkBundleCompleteness(files: TrackVideoOptions): BundleCompleteness {
  const uploadingFootage = FOOTAGE_FIELDS.some((option) => Boolean(files[option]));
  const missingFrom = (specs: ReadonlyArray<{ file: string; option: keyof TrackVideoOptions }>) =>
    uploadingFootage ? specs.filter((spec) => !files[spec.option]).map((spec) => spec.file) : [];
  const plateWarnings: string[] = [];
  if (files.plateBackground && !files.plate) {
    plateWarnings.push(
      "plate.background.png without plate.png. The background is the parallax layer OF a plate; pass --plate (or drop it in the --dir) too",
    );
  }
  return {
    missingAdvisory: missingFrom(RERENDER_ADVISORY_FIELDS),
    missingContract: missingFrom(RERENDER_CONTRACT_FIELDS),
    plateWarnings,
    uploadingFootage,
  };
}

export type TrackVideoCommandOptions = {
  allowPartial?: boolean;
};

function validateBundleCompleteness(
  files: TrackVideoOptions,
  onProgress: ((message: string) => void) | undefined,
  options: TrackVideoCommandOptions,
): void {
  const completeness = checkBundleCompleteness(files);
  if (
    completeness.uploadingFootage &&
    completeness.missingContract.length > 0 &&
    !options.allowPartial
  ) {
    throw new CliError(
      "bundle_incomplete",
      `Refusing to upload a PARTIAL bundle: footage is being uploaded but the re-render contract is missing ${completeness.missingContract.join(", ")}. ` +
        `A footage-only upload leaves composition.tsx/props.json/render.json stale on R2 and desyncs the render.json from the DB ledger. ` +
        `Ship the complete bundle (re-run \`ship\` and upload with --dir), or pass --allow-partial for a deliberate partial refresh (e.g. poster-only).`,
    );
  }
  if (completeness.uploadingFootage) {
    if (completeness.missingContract.length > 0) {
      onProgress?.(
        `warning: --allow-partial, uploading WITHOUT the re-render contract (${completeness.missingContract.join(", ")}); the R2 bundle will NOT be re-renderable`,
      );
    }
    for (const missing of completeness.missingAdvisory) {
      onProgress?.(`warning: ${missing} missing (provenance/eval only), shipping without it`);
    }
  }
  for (const warning of completeness.plateWarnings) {
    onProgress?.(`warning: ${warning}`);
  }
}

export async function trackVideoCommand(
  idOrLogId: string,
  files: TrackVideoOptions,
  onProgress?: (message: string) => void,
  options: TrackVideoCommandOptions = {},
): Promise<TrackVideoResult> {
  validateBundleCompleteness(files, onProgress, options);

  const present = VIDEO_FIELDS.map((spec) => ({
    field: spec.field,
    path: files[spec.option],
  })).filter((spec): spec is { field: string; path: string } => Boolean(spec.path));

  if (present.length === 0) {
    throw new CliError(
      "nothing_to_upload",
      "No bundle files resolved to upload (pass --dir <bundle> or explicit file flags).",
    );
  }

  const platesOnly = isPlatesOnlyUpload(files);

  const presign = await adminApiPost<PresignResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/video/uploads`,
    { fields: present.map((spec) => spec.field) },
  );

  const byField = new Map(presign.uploads.map((upload) => [upload.field, upload]));
  const urls: Record<string, string> = {};

  const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

  for (const spec of present) {
    const upload = byField.get(spec.field);

    if (!upload) {
      throw new CliError("presign_missing", `Worker did not sign an upload for ${spec.field}`);
    }

    onProgress?.(`Uploading ${spec.field} → ${upload.key}`);

    const file = Bun.file(spec.path);
    const body = file.size > STREAM_THRESHOLD_BYTES ? file : await file.arrayBuffer();
    const response = await fetch(upload.url, {
      body,
      headers: { "Content-Type": upload.contentType },
      method: "PUT",
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new CliError(
        "r2_put_failed",
        `R2 rejected ${spec.field} with ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }

    urls[spec.field] = `${FOUND_BASE}/${upload.key}`;
  }

  if (platesOnly) {
    onProgress?.(
      `plate pre-upload complete. Compose against ${FOUND_BASE}/${presign.logId}/plate.png; finalize is deferred to the footage ship`,
    );
    return { logId: presign.logId, ok: true, trackId: presign.trackId, urls };
  }

  const manifest = files.render ? await readManifestFields(files.render) : {};
  const videoModel = files.model?.trim().slice(0, 120) || manifest.model || DEFAULT_VIDEO_MODEL;
  const videoModelReasoning =
    files.reasoning?.trim().slice(0, 120) || manifest.reasoning || DEFAULT_VIDEO_REASONING;
  const squared = Boolean(urls["footage"] && urls["footage-social"]);
  const finalize = await adminApiPost<FinalizeResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/video/finalize`,
    {
      videoModel,
      videoModelReasoning,
      ...(squared ? { squared: true } : {}),
      ...(manifest.vehicle ? { videoVehicle: manifest.vehicle } : {}),
      ...(manifest.grain ? { videoGrain: manifest.grain } : {}),
      ...(manifest.register ? { videoRegister: manifest.register } : {}),
      ...(manifest.palette ? { videoPalette: manifest.palette } : {}),
    },
  );

  return { logId: finalize.logId, ok: true, trackId: finalize.trackId, urls };
}

type RenderManifestField = "grain" | "model" | "palette" | "reasoning" | "register" | "vehicle";

const DIVERSITY_LEDGER_FIELDS = ["vehicle", "grain", "register"] as const;

async function readManifestFields(
  renderPath: string,
): Promise<Partial<Record<RenderManifestField, string>>> {
  let result: Partial<Record<RenderManifestField, string>> = {};

  try {
    const manifest = (await Bun.file(renderPath).json()) as Record<RenderManifestField, unknown>;
    const parsed: Partial<Record<RenderManifestField, string>> = {};

    for (const key of ["vehicle", "grain", "model", "reasoning", "register", "palette"] as const) {
      const value = manifest[key];

      if (typeof value === "string" && value.trim()) {
        parsed[key] = value.trim().slice(0, 120);
      }
    }

    result = parsed;
  } catch {}

  const missing = DIVERSITY_LEDGER_FIELDS.filter((key) => !result[key]);

  if (missing.length > 0) {
    console.error(
      `[video] render.json is missing ${missing.join(", ")}, so the finding ships without its diversity-ledger stamp(s); fix the render bundle's render.json`,
    );
  }

  return result;
}

type TrackDraftResult = {
  externalId: string;
  ok: true;
  platform: string;
  status: string;
  trackId: string;
};

export async function trackDraftCommand(
  idOrLogId: string,
  platform: string,
): Promise<TrackDraftResult> {
  return adminApiPost(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/social/${platform}/draft`,
  );
}

export type TrackSocialUpdateOptions = {
  scheduledFor?: string;
  status: string;
  url?: string;
};

type TrackSocialUpdateBody = {
  scheduledFor?: string;
  status: string;
  url?: string;
};

export async function trackSocialUpdateCommand(
  idOrLogId: string,
  platform: string,
  options: TrackSocialUpdateOptions,
): Promise<TrackSocialUpdateResponse> {
  const body: TrackSocialUpdateBody = { status: options.status };

  if (options.url !== undefined) {
    body.url = options.url;
  }

  if (options.scheduledFor !== undefined) {
    body.scheduledFor = options.scheduledFor;
  }

  return adminApiPatch(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/social/${platform}`,
    body,
  );
}

export async function trackSocialShowCommand(idOrLogId: string): Promise<TrackSocialShowResponse> {
  return adminApiGet(`/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/social`);
}

export type TrackSocialCaptureResult = {
  captured: Array<{ platform: string; trackId: string; url: string }>;
  ok: true;
  polled: number;
};

export async function trackSocialCaptureCommand(limit?: number): Promise<TrackSocialCaptureResult> {
  const body = limit === undefined ? {} : { limit: String(limit) };

  return adminApiPost<TrackSocialCaptureResult>(`/api/v1/admin/social/posts/capture`, body);
}

export async function trackUpdateCommand(
  trackId: string,
  options: TrackUpdateOptions,
): Promise<TrackUpdateResponse> {
  const body: TrackUpdateBody = {};

  if (options.bpm !== undefined) {
    body.bpm = options.bpm;
  }
  if (options.key !== undefined) {
    body.key = options.key;
  }
  if (options.videoUrl !== undefined) {
    body.videoUrl = options.videoUrl;
  }
  if (options.status !== undefined) {
    body.enrichmentStatus = options.status;
  }
  if (options.features !== undefined) {
    body.features = options.features;
  }
  if (options.embedding !== undefined) {
    body.embedding = options.embedding;
  }
  if (options.galaxyId !== undefined) {
    body.galaxyId = options.galaxyId;
  }

  if (options.isrc !== undefined) {
    body.isrc = options.isrc;
  }
  if (options.note !== undefined) {
    body.note = options.note;
  }

  if (options.bpmSource !== undefined) {
    body.bpmSource = options.bpmSource;
  }
  if (options.bpmConfidence !== undefined) {
    body.bpmConfidence = options.bpmConfidence;
  }
  if (options.keySource !== undefined) {
    body.keySource = options.keySource;
  }
  if (options.keyConfidence !== undefined) {
    body.keyConfidence = options.keyConfidence;
  }
  if (options.analyzedFrom !== undefined) {
    body.analyzedFrom = options.analyzedFrom;
  }
  if (options.analyzedAt !== undefined) {
    body.analyzedAt = options.analyzedAt;
  }

  return adminApiPatch<TrackUpdateResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(trackId)}`,
    body,
  );
}

export type TrackRequeueVideoResponse = {
  alreadyClear?: boolean;
  logId: string;
  ok: true;
  trackId: string;
};

export async function trackRequeueVideoCommand(
  idOrLogId: string,
): Promise<TrackRequeueVideoResponse> {
  return adminApiPost<TrackRequeueVideoResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/video/requeue`,
  );
}

export type TrackPurgeVideoResponse = {
  logId: string;
  noVideo?: boolean;
  ok: true;
  trackId: string;
};

export async function trackPurgeVideoCommand(idOrLogId: string): Promise<TrackPurgeVideoResponse> {
  return adminApiPost<TrackPurgeVideoResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/video/purge`,
  );
}

export type TrackCaptureSourcePinResponse = {
  captureSourcePin: null | string;

  captureSourcePinAllowDuration: boolean;
  captureStatus: string;
  logId: null | string;
  ok: true;
  trackId: string;
};

export async function trackPinSourceCommand(
  idOrLogId: string,
  youtube: string,
  options: { allowDurationMismatch?: boolean } = {},
): Promise<TrackCaptureSourcePinResponse> {
  return adminApiPut<TrackCaptureSourcePinResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/capture-source`,
    {
      ...(options.allowDurationMismatch === true ? { allowDurationMismatch: true } : {}),
      youtubeVideoId: youtube,
    },
  );
}

export async function trackClearSourcePinCommand(
  idOrLogId: string,
): Promise<TrackCaptureSourcePinResponse> {
  return adminApiDelete<TrackCaptureSourcePinResponse>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/capture-source`,
  );
}

export type TrackObserveOptions = {
  contextNote?: string;
  durationMs?: number;
  durationTargetSec?: number;

  force?: boolean;

  promptVersion?: number;

  script: string;
  voiceId?: string;
};

type ObserveBody = {
  contextNote?: string;
  durationMs?: number;
  durationTargetSec?: number;
  force?: boolean;
  promptVersion?: number;
  script: string;
  voiceId?: string;
};

export type TrackObserveResult = {
  audioUrl: string;
  durationMs: number;
  generatedAt: string;
  jsonUrl: string;
  logId: string;
  ok: true;
  textUrl: string;
  trackId: string;
  voiceId: string;
};

export async function trackObserveCommand(
  idOrLogId: string,
  options: TrackObserveOptions,
): Promise<TrackObserveResult> {
  const body: ObserveBody = { script: options.script };

  if (options.voiceId !== undefined) {
    body.voiceId = options.voiceId;
  }
  if (options.durationMs !== undefined) {
    body.durationMs = options.durationMs;
  }
  if (options.durationTargetSec !== undefined) {
    body.durationTargetSec = options.durationTargetSec;
  }
  if (typeof options.promptVersion === "number") {
    body.promptVersion = options.promptVersion;
  }
  if (options.contextNote !== undefined) {
    body.contextNote = options.contextNote;
  }
  if (options.force) {
    body.force = true;
  }

  return adminApiPost<TrackObserveResult>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/observe`,
    body,
  );
}

export type TrackContextOptions = {
  query?: string;
  refresh?: boolean;
};

type ContextBody = {
  query?: string;
  refresh?: boolean;
};

export type TrackContextResult = {
  contextNote: string;
  logId: string;
  ok: true;

  skipped?: boolean;
  sources: string[];
  trackId: string;
};

export async function trackContextCommand(
  idOrLogId: string,
  options: TrackContextOptions = {},
): Promise<TrackContextResult> {
  const body: ContextBody = {};

  if (options.query !== undefined) {
    body.query = options.query;
  }

  if (options.refresh) {
    body.refresh = true;
  }

  return adminApiPost<TrackContextResult>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/context`,
    body,
  );
}

export type TrackNoteOptions = {
  dryRun?: boolean;

  note: string;

  promptVersion?: number;
};

type NoteBody = {
  dryRun?: boolean;
  promptVersion?: number;
  note: string;
};

type TrackNoteEcho = {
  logId: string | null;

  overlap: number;

  phrase: string;
};

export type TrackNoteResult = {
  dryRun?: boolean;

  echo?: TrackNoteEcho;
  logId: string;

  neighbors?: string[];
  note: string;
  ok: true;

  skipped?: boolean;
  trackId: string;
};

export async function trackNoteCommand(
  idOrLogId: string,
  options: TrackNoteOptions,
): Promise<TrackNoteResult> {
  const body: NoteBody = { note: options.note };

  if (options.dryRun) {
    body.dryRun = true;
  }

  if (typeof options.promptVersion === "number") {
    body.promptVersion = options.promptVersion;
  }

  return adminApiPost<TrackNoteResult>(
    `/api/v1/admin/tracks/${encodeURIComponent(idOrLogId)}/note`,
    body,
  );
}

import {
  type FinalizeResponse,
  type PresignResponse,
  type TrackGetResponse,
  type TrackSocialShowResponse,
  type TrackSocialUpdateResponse,
  type TrackUpdateResponse,
} from "@fluncle/contracts";
import { adminApiGet, adminApiPatch, adminApiPost, publicApiGet } from "../api";
import { CliError } from "../output";

export type TrackGetResult = TrackGetResponse;

export async function trackGetCommand(idOrLogId: string): Promise<TrackGetResult> {
  return publicApiGet<TrackGetResult>(`/api/tracks/${encodeURIComponent(idOrLogId)}`);
}

export type TrackUpdateOptions = {
  bpm?: number;
  features?: string;
  key?: string;
  note?: string;
  status?: string;
  videoUrl?: string;
};

type TrackUpdateBody = {
  bpm?: number;
  enrichmentStatus?: string;
  features?: string;
  key?: string;
  note?: string;
  videoUrl?: string;
};

export type TrackVideoOptions = {
  composition?: string;
  cover?: string;
  footage?: string;
  footageSilent?: string;
  model?: string;
  note?: string;
  poster?: string;
  props?: string;
  reasoning?: string;
  render?: string;
};

// The authoring AI model recorded for a video, in <provider>/<model> notation.
// The default when neither --model nor render.json supplies one.
const DEFAULT_VIDEO_MODEL = "anthropic/claude-opus-4-8";

// The reasoning/thinking effort recorded for a video (e.g. "high"). The default
// when neither --reasoning nor render.json supplies one.
const DEFAULT_VIDEO_REASONING = "high";

export type TrackVideoResult = {
  logId: string;
  ok: true;
  trackId: string;
  urls: Record<string, string>;
};

// The public read base for stored artifacts (matches the Worker's FOUND_BASE).
const FOUND_BASE = "https://found.fluncle.com";

// The artifact fields the bundle ships, each mapped to its CLI option. The
// content type the PUT replays is whatever the presign endpoint baked into the
// signature; we just echo it back on the request.
const VIDEO_FIELDS: ReadonlyArray<{ field: string; option: keyof TrackVideoOptions }> = [
  { field: "footage", option: "footage" },
  { field: "footage-silent", option: "footageSilent" },
  { field: "poster", option: "poster" },
  { field: "cover", option: "cover" },
  { field: "note", option: "note" },
  { field: "composition", option: "composition" },
  { field: "props", option: "props" },
  { field: "render", option: "render" },
];

// Uploads a track's video bundle DIRECTLY to R2 via short-lived presigned PUT
// URLs the Worker signs. The bytes go straight to R2's S3 endpoint, not through
// the Worker, so they bypass Cloudflare's ~100MB edge body limit (a crf-20 cut
// is ~99MB and the bundle ships two of them). Three phases: presign → PUT each
// file → finalize (links the footage cut as video_url + stores the vehicle).
//
// onProgress is called per file so the caller can print clear progress.
export async function trackVideoCommand(
  idOrLogId: string,
  files: TrackVideoOptions,
  onProgress?: (message: string) => void,
): Promise<TrackVideoResult> {
  const present = VIDEO_FIELDS.map((spec) => ({
    field: spec.field,
    path: files[spec.option],
  })).filter((spec): spec is { field: string; path: string } => Boolean(spec.path));

  // Phase 1: ask the Worker to sign a PUT URL for each artifact we have.
  const presign = await adminApiPost<PresignResponse>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video/uploads`,
    { fields: present.map((spec) => spec.field) },
  );

  const byField = new Map(presign.uploads.map((upload) => [upload.field, upload]));
  const urls: Record<string, string> = {};

  // Phase 2: PUT each file straight to its presigned URL. Stream via Bun.file so
  // a 99MB cut is never buffered into memory. The Content-Type MUST match the
  // one baked into the signature, or R2 returns SignatureDoesNotMatch.
  for (const spec of present) {
    const upload = byField.get(spec.field);

    if (!upload) {
      throw new CliError("presign_missing", `Worker did not sign an upload for ${spec.field}`);
    }

    onProgress?.(`Uploading ${spec.field} → ${upload.key}`);

    const response = await fetch(upload.url, {
      body: Bun.file(spec.path),
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

  // Phase 3: finalize — link the footage cut as video_url and record the vehicle
  // read from the bundle's render.json (the diversity ledger). The authoring
  // model comes from --model, else render.json, else the default.
  const videoVehicle = files.render ? await readVehicle(files.render) : undefined;
  const videoModel =
    files.model?.trim().slice(0, 120) ||
    (files.render ? await readModel(files.render) : undefined) ||
    DEFAULT_VIDEO_MODEL;
  const videoModelReasoning =
    files.reasoning?.trim().slice(0, 120) ||
    (files.render ? await readReasoning(files.render) : undefined) ||
    DEFAULT_VIDEO_REASONING;
  const finalize = await adminApiPost<FinalizeResponse>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video/finalize`,
    { videoModel, videoModelReasoning, ...(videoVehicle ? { videoVehicle } : {}) },
  );

  return { logId: finalize.logId, ok: true, trackId: finalize.trackId, urls };
}

// Reads a single string field (vehicle/model/reasoning) from the bundle's
// render.json. A missing or unparseable value just leaves the field empty (the
// caller defaults), never fails the upload.
type RenderManifestField = "model" | "reasoning" | "vehicle";

async function readManifestField(
  renderPath: string,
  key: RenderManifestField,
): Promise<string | undefined> {
  try {
    const manifest = (await Bun.file(renderPath).json()) as Record<RenderManifestField, unknown>;
    const value = manifest[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 120);
    }
  } catch {
    // Loose manifest; ignore.
  }

  return undefined;
}

async function readVehicle(renderPath: string): Promise<string | undefined> {
  return readManifestField(renderPath, "vehicle");
}

async function readModel(renderPath: string): Promise<string | undefined> {
  return readManifestField(renderPath, "model");
}

async function readReasoning(renderPath: string): Promise<string | undefined> {
  return readManifestField(renderPath, "reasoning");
}

type TrackDraftResult = {
  externalId: string;
  ok: true;
  platform: string;
  status: string;
  trackId: string;
};

// Pushes a platform draft (e.g. TikTok via Postiz) for a track's video.
export async function trackDraftCommand(
  idOrLogId: string,
  platform: string,
): Promise<TrackDraftResult> {
  return adminApiPost(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/social/${platform}/draft`,
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

// Updates a per-platform post's status after manual review/publish in-app.
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
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/social/${platform}`,
    body,
  );
}

// Lists a track's per-platform publication state.
export async function trackSocialShowCommand(idOrLogId: string): Promise<TrackSocialShowResponse> {
  return adminApiGet(`/api/admin/tracks/${encodeURIComponent(idOrLogId)}/social`);
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
  if (options.note !== undefined) {
    body.note = options.note;
  }

  return adminApiPatch<TrackUpdateResponse>(
    `/api/admin/tracks/${encodeURIComponent(trackId)}`,
    body,
  );
}

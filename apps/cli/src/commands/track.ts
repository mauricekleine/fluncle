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
  footageSocial?: string;
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
  { field: "footage-social", option: "footageSocial" },
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
  // model comes from --model, else render.json, else the default. When the bundle
  // carried BOTH the square footage.mp4 and the portrait footage.social.mp4,
  // footage.mp4 is the clean square crop source, so signal `squared` to stamp the
  // two-master layout (docs/video-variants.md).
  const manifest = files.render ? await readManifestFields(files.render) : {};
  const videoModel = files.model?.trim().slice(0, 120) || manifest.model || DEFAULT_VIDEO_MODEL;
  const videoModelReasoning =
    files.reasoning?.trim().slice(0, 120) || manifest.reasoning || DEFAULT_VIDEO_REASONING;
  const squared = Boolean(urls["footage"] && urls["footage-social"]);
  const finalize = await adminApiPost<FinalizeResponse>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video/finalize`,
    {
      videoModel,
      videoModelReasoning,
      ...(squared ? { squared: true } : {}),
      ...(manifest.vehicle ? { videoVehicle: manifest.vehicle } : {}),
      ...(manifest.grain ? { videoGrain: manifest.grain } : {}),
    },
  );

  return { logId: finalize.logId, ok: true, trackId: finalize.trackId, urls };
}

// Reads the bundle's render.json once and returns the three string fields the
// finalize call needs (vehicle/model/reasoning). A missing or unparseable value
// just leaves that field absent (the caller defaults), never fails the upload.
type RenderManifestField = "grain" | "model" | "reasoning" | "vehicle";

async function readManifestFields(
  renderPath: string,
): Promise<Partial<Record<RenderManifestField, string>>> {
  try {
    const manifest = (await Bun.file(renderPath).json()) as Record<RenderManifestField, unknown>;
    const result: Partial<Record<RenderManifestField, string>> = {};

    for (const key of ["vehicle", "grain", "model", "reasoning"] as const) {
      const value = manifest[key];

      if (typeof value === "string" && value.trim()) {
        result[key] = value.trim().slice(0, 120);
      }
    }

    return result;
  } catch {
    // Loose manifest; ignore.
  }

  return {};
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

// `fluncle admin tracks requeue-video <id|logId>` — clear a finding's video so it
// re-enters the render queue AND drops cleanly off radio until re-rendered (the
// render skill improved → re-film an already-filmed finding). Operator-authenticated
// (it removes a LIVE published video; the FLUNCLE_API_TOKEN must be the operator
// token, never the box agent's). Clears BOTH gates server-side: video_url (the queue
// gate) and video_squared_at (the radio gate). Idempotent — an already-clear finding
// comes back `alreadyClear: true`. A body-less POST (the id is the whole input).
//
// CACHE CAVEAT (known follow-up, not done here): re-shipping footage.mp4 to the same
// R2 key leaves Cloudflare Media-Transformation renditions cached separately, so a
// re-render may still need a purge of the transform URLs (docs/video-variants.md).
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
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video/requeue`,
  );
}

// `fluncle admin track observe <id|logId>` — mint the audio-observation artifact.
// The agent authors + voice-gates the spoken script (it holds copywriting-fluncle)
// and passes it here; the Worker fetches the factual context, re-scans the script,
// renders it with ElevenLabs, uploads observation.{mp3,txt,json} to R2, and writes
// the observation fields back. The CLI stays a thin relay — no vendor logic.
export type TrackObserveOptions = {
  contextNote?: string;
  durationMs?: number;
  durationTargetSec?: number;
  model?: string;
  /** The spoken script (read from --script-file by the caller, or passed inline). */
  script: string;
  voiceId?: string;
};

type ObserveBody = {
  contextNote?: string;
  durationMs?: number;
  durationTargetSec?: number;
  model?: string;
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
  if (options.model !== undefined) {
    body.model = options.model;
  }
  if (options.durationMs !== undefined) {
    body.durationMs = options.durationMs;
  }
  if (options.durationTargetSec !== undefined) {
    body.durationTargetSec = options.durationTargetSec;
  }
  if (options.contextNote !== undefined) {
    body.contextNote = options.contextNote;
  }

  return adminApiPost<TrackObserveResult>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/observe`,
    body,
  );
}

// `fluncle admin tracks context <id|logId>` — fetch + store the track's FACTUAL
// context note (Firecrawl facts only). The split-out context half of the
// observation pipeline: the Worker fetches the facts and writes the internal
// `context_note` so a later `observe` can author + render from it without holding
// Firecrawl. Idempotent — a finding that already has a note is a no-op (`skipped`),
// so the context cron can fire on a fixed interval safely. The CLI stays a thin
// relay; the optional --query overrides the Worker's search string, and --refresh
// RE-RUNS the fetch+distil even when a note already exists (backfill/sharpen).
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
  /** True when a context note already existed and the call was a no-op. */
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
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/context`,
    body,
  );
}

// `fluncle admin tracks note <id|logId> --script-file <path>` — store the
// AGENT-AUTHORED editorial note for a finding (the written-note sibling of
// `observe`). The Worker voice-GATES the note and fills it ONLY when the finding has
// no note yet: an operator-written (or previously auto-authored) note is never
// clobbered (the call returns `skipped: true`). The CLI stays a thin relay; the
// caller reads the authored note from --script-file (or passes it inline).
export type TrackNoteOptions = {
  /** The voice-gated editorial note (read from --script-file by the caller, or inline). */
  note: string;
};

type NoteBody = {
  note: string;
};

export type TrackNoteResult = {
  logId: string;
  note: string;
  ok: true;
  /** True when a note already existed and the fill-empty-only guard refused to clobber it. */
  skipped?: boolean;
  trackId: string;
};

export async function trackNoteCommand(
  idOrLogId: string,
  options: TrackNoteOptions,
): Promise<TrackNoteResult> {
  const body: NoteBody = { note: options.note };

  return adminApiPost<TrackNoteResult>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/note`,
    body,
  );
}

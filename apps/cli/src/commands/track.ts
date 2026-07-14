import {
  type FinalizeResponse,
  type PresignResponse,
  type TrackGetResponse,
  type TrackListItem,
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

// `get_similar_findings` → `fluncle tracks similar <id|logId>` (Convention B). The
// finding's SONIC neighbours — the MuQ-embedding nearest neighbours the `/log` "more
// like this" row shows, ranked in SQL. A public read, and the auto-note's second fuel:
// the note sweep reads this to learn what the region of the archive around a finding
// already sounds like (docs/agents/note-agent.md). Each neighbour carries its own
// editorial note, which is the part the sweep is after.
export type TrackSimilarResult = { findings: TrackListItem[]; ok: true };

export async function trackSimilarCommand(
  idOrLogId: string,
  limit?: number,
): Promise<TrackSimilarResult> {
  const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;

  return publicApiGet<TrackSimilarResult>(
    `/api/tracks/${encodeURIComponent(idOrLogId)}/similar${query}`,
  );
}

// `fluncle admin tracks get <id|logId>` — the ADMIN single-finding lookup. Fetches
// ONE finding with its FULL admin fields (the vibe coords, the video ledger, the
// observation, the editorial note) — the authoritative by-coordinate read, so a
// lookup never has to scan a list (and can't misread a live finding as nonexistent).
// Agent-allowed read (the admin tier). Distinct from the public `tracks get`, which
// hits `/api/tracks/{idOrLogId}` and only carries the public projection.
export type TrackGetAdminResult = { ok: true; track: TrackListItem };

export async function trackGetAdminCommand(idOrLogId: string): Promise<TrackGetAdminResult> {
  return adminApiGet<TrackGetAdminResult>(`/api/admin/tracks/${encodeURIComponent(idOrLogId)}`);
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

// The RE-RENDERABLE-SOURCE contract: the three artifacts that MUST accompany any
// footage upload so the R2 bundle stays a complete, re-renderable source and its
// render.json stays in sync with the DB ledger. Shipping footage WITHOUT these
// desyncs the bundle — the 2026-07 partial-upload regression (footage/social/poster
// uploaded, composition/props/render left stale). Keyed by conventional filename so
// the error names exactly what to add.
const RERENDER_CONTRACT_FIELDS: ReadonlyArray<{ file: string; option: keyof TrackVideoOptions }> = [
  { file: "composition.tsx", option: "composition" },
  { file: "props.json", option: "props" },
  { file: "render.json", option: "render" },
];

// The warn-only companions: shipped for provenance/eval but not load-bearing for a
// re-render, so a missing one is a warning, never a hard error.
const RERENDER_ADVISORY_FIELDS: ReadonlyArray<{ file: string; option: keyof TrackVideoOptions }> = [
  { file: "intent.json", option: "intent" },
  { file: "metrics.json", option: "metrics" },
  { file: "scene.json", option: "scene" },
];

// Any of these present means "footage is being uploaded", which arms the re-render
// contract check (a poster-only or cover-only refresh uploads none of them).
const FOOTAGE_FIELDS: ReadonlyArray<keyof TrackVideoOptions> = [
  "footage",
  "footageSocial",
  "footageNotext",
  "footageLandscape",
  "footageLandscapeSocial",
];

// The plate-lane inputs. OPTIONAL by design: a plate-less (abstract) bundle is fully
// valid and a plate bundle without its background is fine, so neither ever joins the
// re-render contract or the advisory set on a footage upload. They matter to the
// guard in one direction only: a plates-only set is the sanctioned PRE-composition
// upload (upload-first order — the composition references the durable
// found.fluncle.com URL, so the plates must be on R2 before it is authored).
const PLATE_FIELDS: ReadonlyArray<keyof TrackVideoOptions> = ["plate", "plateBackground"];

// The non-file options riding TrackVideoOptions (finalize metadata, not artifacts).
const NON_FILE_OPTIONS: ReadonlyArray<keyof TrackVideoOptions> = ["model", "reasoning"];

/**
 * True when the resolved file set is a plate-lane PRE-upload: at least one plate
 * artifact and nothing else. This set skips both the footage requirement and the
 * finalize call — plates go up before any render exists, and finalize would set
 * `video_url` (dequeuing the finding from the render queue before it is filmed).
 */
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
  /** true when at least one footage master is in the upload set. */
  uploadingFootage: boolean;
  /** missing re-render-contract filenames (hard-error unless --allow-partial). */
  missingContract: string[];
  /** missing advisory filenames (warn-only). */
  missingAdvisory: string[];
  /** plate-lane advisories (warn-only, armed on any upload): plates are OPTIONAL —
   *  a plate-less bundle is valid and a plate without its background is fine — so
   *  the only warnable shape is a background WITHOUT its plate. */
  plateWarnings: string[];
};

// Pure check over the resolved file set: is this a complete re-renderable bundle?
// A field counts as "present" when its path is set (—dir resolves conventional
// names only when the file exists; an explicit flag sets the path). The contract is
// only armed when footage is being uploaded — a poster-only refresh is exempt, and
// so is the plate-lane pre-upload (plates ship before any render exists).
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
  /** Ship an intentionally partial bundle (e.g. a poster-only refresh), skipping the
   *  re-render-contract requirement. The escape hatch, never the default. */
  allowPartial?: boolean;
};

// Uploads a track's video bundle DIRECTLY to R2 via short-lived presigned PUT
// URLs the Worker signs. The bytes go straight to R2's S3 endpoint, not through
// the Worker, so they bypass Cloudflare's ~100MB edge body limit (a crf-20 cut
// is ~99MB and the bundle ships two of them). Three phases: presign → PUT each
// file → finalize (links the footage cut as video_url + stores the vehicle).
//
// Before any of that, the bundle-completeness guard: a footage upload MUST carry the
// re-render contract (composition + props + render), or the R2 bundle desyncs from
// the DB ledger. Missing contract files hard-error (naming them) unless --allow-partial.
//
// onProgress is called per file so the caller can print clear progress.
export async function trackVideoCommand(
  idOrLogId: string,
  files: TrackVideoOptions,
  onProgress?: (message: string) => void,
  options: TrackVideoCommandOptions = {},
): Promise<TrackVideoResult> {
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

  // The plate-lane pre-upload (upload-first order): plates go up BEFORE the
  // composition exists, so this set must NOT finalize — finalize sets `video_url`,
  // which would dequeue the finding from the render queue before it is filmed.
  const platesOnly = isPlatesOnlyUpload(files);

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

  // A plates-only pre-upload STOPS here: the artifacts are on R2 at their durable
  // keys and the composition can now reference them; the finding stays in the
  // render queue (no video_url write) until the real footage ship finalizes.
  if (platesOnly) {
    onProgress?.(
      `plate pre-upload complete. Compose against ${FOUND_BASE}/${presign.logId}/plate.png; finalize is deferred to the footage ship`,
    );
    return { logId: presign.logId, ok: true, trackId: presign.trackId, urls };
  }

  // Phase 3: finalize — link the footage cut as video_url and record the vehicle
  // read from the bundle's render.json (the diversity ledger). The authoring
  // model comes from --model, else render.json, else the default. When the bundle
  // carried BOTH the square footage.mp4 and the portrait footage.social.mp4,
  // footage.mp4 is the clean square crop source, so signal `squared` to stamp the
  // two-master layout.
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
      ...(manifest.register ? { videoRegister: manifest.register } : {}),
    },
  );

  return { logId: finalize.logId, ok: true, trackId: finalize.trackId, urls };
}

// Reads the bundle's render.json once and returns the string fields the finalize
// call needs (vehicle/grain/register — the diversity ledgers — plus model/reasoning).
// A missing or unparseable value leaves that field absent (the caller defaults) and
// never FAILS the upload — but it no longer passes SILENTLY: vehicle/grain/register
// are the homogenisation evidence (docs/planning/homogenisation-evidence.md), and
// three 2026-07 renders shipped as unlabelled holes in that ledger before this warn
// existed. The warning lands on stderr, so the render conductor's log carries it and
// the ship is auditable after the fact.
type RenderManifestField = "grain" | "model" | "reasoning" | "register" | "vehicle";

const DIVERSITY_LEDGER_FIELDS = ["vehicle", "grain", "register"] as const;

async function readManifestFields(
  renderPath: string,
): Promise<Partial<Record<RenderManifestField, string>>> {
  let result: Partial<Record<RenderManifestField, string>> = {};

  try {
    const manifest = (await Bun.file(renderPath).json()) as Record<RenderManifestField, unknown>;
    const parsed: Partial<Record<RenderManifestField, string>> = {};

    for (const key of ["vehicle", "grain", "model", "reasoning", "register"] as const) {
      const value = manifest[key];

      if (typeof value === "string" && value.trim()) {
        parsed[key] = value.trim().slice(0, 120);
      }
    }

    result = parsed;
  } catch {
    // Loose manifest; the warn below names every missing field.
  }

  const missing = DIVERSITY_LEDGER_FIELDS.filter((key) => !result[key]);

  if (missing.length > 0) {
    console.error(
      `[video] render.json is missing ${missing.join(", ")} — the finding ships without its diversity-ledger stamp(s); fix the render bundle's render.json`,
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

// `fluncle admin tracks social --capture` — the capture SWEEP. Drains the "pushed
// but no URL" backlog across YouTube + TikTok: the Worker polls Postiz's `/missing`
// for each pending post, builds the permalink from the platform's native content
// id, records it, links the Postiz release-id for analytics, and flips a captured
// TikTok draft to published. Agent-allowed (it only fills the public URL Postiz
// withheld on create — it publishes nothing). Idempotent and best-effort; the box
// capture cron drives it. The CLI stays a thin relay.
export type TrackSocialCaptureResult = {
  captured: Array<{ platform: string; trackId: string; url: string }>;
  ok: true;
  polled: number;
};

export async function trackSocialCaptureCommand(limit?: number): Promise<TrackSocialCaptureResult> {
  // A JSON body (even when empty) is required: the oRPC handler builds its input
  // from the request body, and a bodyless POST deserializes to `undefined` (a 400
  // `invalid_request`). `limit` rides in the body, the CLI's relay shape for the
  // other JSON admin POSTs.
  const body = limit === undefined ? {} : { limit: String(limit) };

  return adminApiPost<TrackSocialCaptureResult>(`/api/admin/social/posts/capture`, body);
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
  if (options.note !== undefined) {
    body.note = options.note;
  }
  // BPM/key analysis provenance (RFC bpm-key-accuracy) — internal analysis metadata written
  // alongside bpm/key by the enrich sweep, kept out of VISIBLE_FIELDS server-side.
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
// CACHE NOTE: re-shipping footage.mp4 to the same R2 key leaves Cloudflare
// Media-Transformation renditions cached separately. The video ship purges them
// automatically on a re-render; `fluncle admin tracks purge-video` is the manual
// twin.
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

// `fluncle admin tracks purge-video <id|logId>` — evict a finding's stale
// Cloudflare Media-Transformation renditions from the edge. The manual twin of the
// automatic purge the video ship fires on a re-render: the player streams MT crops
// derived from `footage.mp4`, so re-uploading to the same R2 key leaves those
// renditions stale until their TTL expires. Run this after a manual R2 re-upload,
// or to force-evict a finding whose automatic purge was skipped (no zone token at
// the time). Operator-authenticated. Body-less POST. `noVideo: true` when there is
// nothing to purge.
export type TrackPurgeVideoResponse = {
  logId: string;
  noVideo?: boolean;
  ok: true;
  trackId: string;
};

export async function trackPurgeVideoCommand(idOrLogId: string): Promise<TrackPurgeVideoResponse> {
  return adminApiPost<TrackPurgeVideoResponse>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video/purge`,
  );
}

// `fluncle admin track observe <id|logId>` — mint the audio-observation artifact.
// The agent authors + voice-gates the spoken script (it holds copywriting-fluncle)
// and passes it here; the Worker fetches the factual context, re-scans the script,
// renders it with Cartesia, uploads observation.{mp3,txt,json} to R2, and writes
// the observation fields back. The CLI stays a thin relay — no vendor logic.
export type TrackObserveOptions = {
  contextNote?: string;
  durationMs?: number;
  durationTargetSec?: number;
  /** Re-render even if an observation already exists (voice re-tune / fix a render). */
  force?: boolean;
  /**
   * PROVENANCE — the prompt-registry version this script was authored under (0 = the
   * baked default, N = override N). The on-box sweep passes it; omit it for an
   * operator-written script. See docs/agents/prompt-registry.md.
   */
  promptVersion?: number;
  /** The spoken script (read from --script-file by the caller, or passed inline). */
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
  /** Run BOTH gates and report the verdict, storing nothing (the pre-check / A-B harness). */
  dryRun?: boolean;
  /** The voice-gated editorial note (read from --script-file by the caller, or inline). */
  note: string;
  /**
   * PROVENANCE — the prompt-registry version this note was authored under (0 = the
   * baked default, N = override N). The on-box sweep passes it; omit it for an
   * operator-typed note, whose provenance is honestly NULL — no prompt wrote it.
   * See docs/agents/prompt-registry.md.
   */
  promptVersion?: number;
};

type NoteBody = {
  dryRun?: boolean;
  promptVersion?: number;
  note: string;
};

/** How hard a note echoes its sonic neighbourhood (the anti-sameness rail's reading). */
export type TrackNoteEcho = {
  /** The neighbour it echoes hardest, or null when there was nothing to echo. */
  logId: string | null;
  /** Content-word overlap with that neighbour (0..1). */
  overlap: number;
  /** The run of words lifted from it, or "" when nothing reached the lift threshold. */
  phrase: string;
};

export type TrackNoteResult = {
  /** True on a --dry-run: the gates ran, nothing was stored. */
  dryRun?: boolean;
  /** The measured echo against the finding's sonic neighbours. */
  echo?: TrackNoteEcho;
  logId: string;
  /** The Log IDs the note was gated against (--dry-run only). */
  neighbors?: string[];
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

  if (options.dryRun) {
    body.dryRun = true;
  }

  if (typeof options.promptVersion === "number") {
    body.promptVersion = options.promptVersion;
  }

  return adminApiPost<TrackNoteResult>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/note`,
    body,
  );
}

// Fluncle Studio — the footage cut. Turn one `pending` clip into a framed 9:16 clip on
// R2, then mark it `done`.
//
// A clip is a real ffmpeg cut from the landscape 1080p set rendition (a mixtape's
// `<logId>/set.mp4`, or a recording's owned `r2Key`): trim `[inMs,outMs]`, crop 16:9 →
// 9:16 at the operator's `xOffset`, and store the result as the clip's pseudo-finding
// master `<clipId>/footage.mp4` so the merged `videoCrop(clipId)` / `videoCropPoster` /
// `videoAudioStripped` MT helpers finish it (the resolution ladder, the poster, the silent
// TikTok variant) — see apps/web/src/lib/media.ts.
//
// The cut ships CLEAN — a pure crop, NO baked text overlay. Recorded set footage doesn't
// read well under a drawtext caption, and the operator writes the caption on Instagram /
// TikTok at post time, so the brand frame the earlier design baked in (title + coordinate +
// Track-ID + ink-halo + fonts) has been removed.
//
// WHERE IT RUNS: the always-on Hermes box (rave-02), driven by the `fluncle-studio-clip`
// `--no-agent` cron (docs/agents/hermes/scripts/clip-sweep.ts), which lists pending
// clips and calls `fluncle admin clips cut <clipId>` per clip. The box holds NO R2
// creds — the agent token signs a SINGLE-PUT upload (`presign_clip_upload`, agent tier;
// a clip is < 100 MB) and the box streams the cut straight to R2, then `finalize_clip_cut`
// marks it done + purges the stale edge renditions server-side (a re-cut to the same
// clipId must not keep serving the old cut — #152 lesson).
//
// CI HAS NO ffmpeg: every pure helper below (the ffmpeg arg shape, the footage key, the
// crop filtergraph) is exported and unit-tested WITHOUT invoking ffmpeg (clips.test.ts).
// The one shell-out is skip-guarded on a `ffmpeg -version` probe.

import {
  type ClipCutFinalizeResponse,
  type ClipPresignResponse,
  type ClipsResponse,
  type ClipDTO,
} from "@fluncle/contracts";
import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";

// The public read base for stored artifacts (matches the Worker's FOUND_BASE). The set
// rendition + the clip's pseudo-finding master both live under it, keyed by their id.
const FOUND_BASE = "https://found.fluncle.com";

// The portrait clip geometry + the encode caps. The clip is BITRATE-CAPPED so the
// output `footage.mp4` stays < 100 MB — else Cloudflare Media Transformations 400s the
// fan-out (its source ceiling). A 60 s 1080×1920 cut at maxrate 10M lands ~75 MB of
// video + ~1.5 MB audio, comfortably under the cap.
export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;
export const CLIP_CRF = 21;
export const CLIP_MAXRATE = "10M";
export const CLIP_BUFSIZE = "20M";
export const CLIP_AUDIO_BITRATE = "192k";

// Cloudflare MT rejects a source over 100 MB; the cut must clear it (the bitrate cap is
// the primary guard, this is the backstop the cut command asserts on the rendered file).
export const MAX_CLIP_BYTES = 100 * 1024 * 1024;

/** The clip's pseudo-finding master key on R2 — what every MT helper resolves against. */
export function clipFootageKey(clipId: string): string {
  return `${clipId}/footage.mp4`;
}

/** The landscape set rendition the cut reads from R2 (Unit A's `<logId>/set.mp4`). */
export function setVideoUrl(logId: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/set.mp4`;
}

export type ClipCutFilterOptions = {
  /** The 9:16 framing offset (px from the left of the landscape source). */
  xOffset: number;
};

/**
 * Build the video filtergraph: crop 16:9 → 9:16 at `xOffset`, scale to 1080×1920, fix the
 * pixel aspect. That is the WHOLE cut — the clip ships CLEAN, with no baked text overlay
 * (recorded set footage reads poorly under a drawtext caption, and the operator writes the
 * caption on Instagram / TikTok at post time). The graph's single video pad is `[out]`
 * (mapped by `clipCutFfmpegArgs`); the source audio rides through untouched via `-map 0:a?`.
 */
export function clipCutFilterComplex(options: ClipCutFilterOptions): string {
  const xOffset = Math.max(0, Math.round(options.xOffset));

  return `[0:v]crop=ih*9/16:ih:${xOffset}:0,scale=${CLIP_WIDTH}:${CLIP_HEIGHT},setsar=1[out]`;
}

export type ClipCutFfmpegOptions = ClipCutFilterOptions & {
  inMs: number;
  outMs: number;
  outputPath: string;
  setUrl: string;
};

/**
 * The ffmpeg argv that cuts + frames the clip in ONE pass from the set rendition. Pure
 * (a thin shell-out spec), so the arg shape is unit-tested without invoking ffmpeg.
 *
 * `-ss` BEFORE `-i` is an input seek — over HTTP against the faststart `set.mp4` it
 * range-requests to the offset instead of downloading the whole ~1.5 GB rendition — and
 * with the re-encode below it is frame-accurate in modern ffmpeg. The bitrate cap
 * (`-maxrate`/`-bufsize` + CRF) keeps the output under 100 MB; `+faststart` puts the
 * moov atom up front so the result range-streams + survives MT.
 *
 * The crop rides as a `-filter_complex` with a labelled `[out]` pad so the source audio can
 * be mapped alongside it with `-map 0:a?` (optional — a set with no audio still cuts).
 */
export function clipCutFfmpegArgs(options: ClipCutFfmpegOptions): string[] {
  const inSeconds = (options.inMs / 1000).toFixed(3);
  const durationSeconds = ((options.outMs - options.inMs) / 1000).toFixed(3);
  const filter = clipCutFilterComplex(options);

  return [
    "-y",
    "-ss",
    inSeconds,
    "-i",
    options.setUrl,
    "-t",
    durationSeconds,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(CLIP_CRF),
    "-maxrate",
    CLIP_MAXRATE,
    "-bufsize",
    CLIP_BUFSIZE,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    CLIP_AUDIO_BITRATE,
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
}

/** List clips via the admin API (Unit G `list_clips`; agent token clears requireAdmin). */
export async function clipsListCommand(
  filter: { mixtapeId?: string; recordingId?: string; status?: string } = {},
): Promise<ClipDTO[]> {
  const params = new URLSearchParams();

  if (filter.recordingId) {
    params.set("recordingId", filter.recordingId);
  }

  if (filter.mixtapeId) {
    params.set("mixtapeId", filter.mixtapeId);
  }

  if (filter.status) {
    params.set("status", filter.status);
  }

  const query = params.toString();
  const response = await adminApiGet<ClipsResponse>(`/api/admin/clips${query ? `?${query}` : ""}`);

  return response.clips;
}

export type ClipCutResult = {
  clipId: string;
  key: string;
  sizeBytes: number;
  url: string;
};

// The set the cut reads from — resolved from EITHER the clip's recording (the RFC
// recording-primitive path) or, for a legacy clip, its mixtape. The cut is a pure crop, so
// all it needs is the source rendition URL (plus the staging assertions that guard it).
type ClipSource = {
  setUrl: string;
};

// Resolve a clip's source set. A recording clip reads the recording's OWNED r2Key; a legacy
// mixtape clip keeps the old `mixtape → setVideoUrl(logId)` path. Both assert the set video
// is actually staged before the cut runs.
async function resolveClipSource(clip: ClipDTO): Promise<ClipSource> {
  if (clip.recordingId) {
    const { recordingGet } = await import("./recordings");
    const recording = await recordingGet(clip.recordingId);

    if (!recording.r2Key) {
      throw new CliError(
        "recording_not_staged",
        `Recording ${clip.recordingId} has no staged set video`,
      );
    }

    return {
      setUrl: `${FOUND_BASE}/${recording.r2Key.split("/").map(encodeURIComponent).join("/")}`,
    };
  }

  // Legacy fallback: an un-backfilled clip still keyed by a published mixtape.
  if (!clip.mixtapeId) {
    throw new CliError(
      "clip_unlinked",
      `Clip ${clip.id} is linked to neither a recording nor a mixtape`,
    );
  }

  const { mixtapeGetCommand } = await import("./mixtapes");
  const mixtape = await mixtapeGetCommand(clip.mixtapeId);

  if (!mixtape.logId) {
    throw new CliError("mixtape_no_log_id", `Mixtape ${clip.mixtapeId} has no committed Log ID`);
  }

  if (!mixtape.setVideoAt) {
    throw new CliError(
      "set_not_staged",
      `Mixtape ${mixtape.logId} has no staged set video — run \`recordings promote <recordingId>\` first`,
    );
  }

  return { setUrl: setVideoUrl(mixtape.logId) };
}

/**
 * Cut one clip end to end: resolve its recording (or, for a legacy clip, its mixtape)
 * staged set rendition → ffmpeg (trim + crop, no overlay) → single-PUT upload to R2
 * (`presign_clip_upload`) → `finalize_clip_cut` (mark done + server-side edge purge).
 * Idempotent: re-cutting the same clipId re-ships `<clipId>/footage.mp4` to the same key
 * and the finalize purges the stale renditions.
 */
export async function clipCutCommand(
  clipId: string,
  onProgress: (message: string) => void = () => {},
): Promise<ClipCutResult> {
  const clips = await clipsListCommand();
  const clip = clips.find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new CliError("clip_not_found", `No clip with id ${clipId}`);
  }

  const source = await resolveClipSource(clip);

  await assertFfmpeg();

  const outputPath = join(tmpdir(), `fluncle-clip-${randomUUID()}.mp4`);

  try {
    onProgress(`Clip ${clipId}: cutting [${clip.inMs}–${clip.outMs}ms]…`);
    await runClipCut({
      inMs: clip.inMs,
      outMs: clip.outMs,
      outputPath,
      setUrl: source.setUrl,
      xOffset: clip.xOffset,
    });

    const sizeBytes = statSync(outputPath).size;

    if (sizeBytes > MAX_CLIP_BYTES) {
      throw new CliError(
        "clip_too_large",
        `The cut is ${(sizeBytes / 1_000_000).toFixed(1)} MB (> 100 MB Cloudflare MT ceiling) — shorten the window or lower the bitrate cap`,
      );
    }

    onProgress(`Clip ${clipId}: uploading ${(sizeBytes / 1_000_000).toFixed(1)} MB…`);
    const presign = await adminApiPost<ClipPresignResponse>(
      `/api/admin/clips/${encodeURIComponent(clipId)}/cut/presign`,
      { contentType: "video/mp4" },
    );

    await putClip(presign.url, presign.contentType, outputPath);

    // Mark the cut done + purge the stale edge renditions (server-side; the box has no
    // Cloudflare creds). A bodyless POST — clipId rides the path.
    await adminApiPost<ClipCutFinalizeResponse>(
      `/api/admin/clips/${encodeURIComponent(clipId)}/cut/finalize`,
    );

    onProgress(`Clip ${clipId}: done → ${FOUND_BASE}/${presign.key}`);

    return {
      clipId,
      key: presign.key,
      sizeBytes,
      url: `${FOUND_BASE}/${presign.key}`,
    };
  } finally {
    rmSync(outputPath, { force: true });
  }
}

// PUT the rendered clip straight to its presigned URL. The Content-Type MUST match the
// signed one byte-for-byte (it is baked into the signature — SignatureDoesNotMatch
// otherwise). `Bun.file()` is a lazy FS-backed Blob, so the body streams.
async function putClip(url: string, contentType: string, path: string): Promise<void> {
  const response = await fetch(url, {
    body: Bun.file(path),
    headers: { "content-type": contentType },
    method: "PUT",
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new CliError(
      "r2_put_failed",
      `R2 rejected the clip upload (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }
}

// Probe ffmpeg before cutting so a missing binary is a clear, actionable message rather
// than an opaque spawn error (CI never reaches this — the cut command isn't run there).
async function assertFfmpeg(): Promise<void> {
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stderr: "ignore", stdout: "ignore" });
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error("ffmpeg -version exited non-zero");
    }
  } catch {
    throw new CliError(
      "ffmpeg_missing",
      "The clip cut needs ffmpeg. Install it on the box (apt-get install -y ffmpeg).",
    );
  }
}

async function runClipCut(options: ClipCutFfmpegOptions): Promise<void> {
  if (!options.setUrl) {
    throw new CliError("missing_set_url", "The clip cut needs the set rendition URL");
  }

  const proc = Bun.spawn(["ffmpeg", ...clipCutFfmpegArgs(options)], {
    stderr: "pipe",
    stdout: "ignore",
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const detail = (await new Response(proc.stderr).text().catch(() => "")).slice(-400);
    throw new CliError(
      "ffmpeg_failed",
      `ffmpeg failed to cut the clip${detail ? `: ${detail}` : ""}`,
    );
  }
}

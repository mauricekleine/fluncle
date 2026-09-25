import {
  type ClipCutFinalizeResponse,
  type ClipDripStateResponse,
  type ClipPresignResponse,
  type ClipScheduleResponse,
  type ClipSocialPost,
  type ClipSocialPostsResponse,
  type ClipsResponse,
  type ClipDTO,
} from "@fluncle/contracts";
import { r2PublicUrl } from "@fluncle/contracts/util";
import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminApiGet, adminApiPatch, adminApiPost, adminApiPut } from "../api";
import { CliError } from "../output";

const FOUND_BASE = "https://found.fluncle.com";

export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;
export const CLIP_CRF = 21;
export const CLIP_MAXRATE = "10M";
export const CLIP_BUFSIZE = "20M";
export const CLIP_AUDIO_BITRATE = "192k";

const MAX_CLIP_BYTES = 100 * 1024 * 1024;

export type ClipCutFilterOptions = {
  xOffset: number;
};

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

export async function clipsListCommand(
  filter: { recordingId?: string; status?: string } = {},
): Promise<ClipDTO[]> {
  const params = new URLSearchParams();

  if (filter.recordingId) {
    params.set("recordingId", filter.recordingId);
  }

  if (filter.status) {
    params.set("status", filter.status);
  }

  const query = params.toString();
  const response = await adminApiGet<ClipsResponse>(
    `/api/v1/admin/clips${query ? `?${query}` : ""}`,
  );

  return response.clips;
}

export async function clipPostsListCommand(): Promise<ClipSocialPost[]> {
  const response = await adminApiGet<ClipSocialPostsResponse>("/api/v1/admin/clips/social");

  return response.posts;
}

export async function clipScheduleCommand(
  clipId: string,
  scheduledFor: string,
): Promise<ClipSocialPost> {
  const response = await adminApiPatch<ClipScheduleResponse>(
    `/api/v1/admin/clips/${encodeURIComponent(clipId)}/schedule`,
    { scheduledFor },
  );

  return response.post;
}

export async function clipDripPauseCommand(paused: boolean): Promise<boolean> {
  const response = await adminApiPut<ClipDripStateResponse>("/api/v1/admin/clips/drip/state", {
    paused,
  });

  return response.paused;
}

export type ClipCutResult = {
  clipId: string;
  key: string;
  sizeBytes: number;
  url: string;
};

type ClipSource = {
  setUrl: string;
};

async function resolveClipSource(clip: ClipDTO): Promise<ClipSource> {
  if (!clip.recordingId) {
    throw new CliError("clip_unlinked", `Clip ${clip.id} is linked to no recording`);
  }

  const { recordingGet } = await import("./recordings");
  const recording = await recordingGet(clip.recordingId);

  if (!recording.r2Key) {
    throw new CliError(
      "recording_not_staged",
      `Recording ${clip.recordingId} has no staged set video`,
    );
  }

  return {
    setUrl: r2PublicUrl(FOUND_BASE, recording.r2Key),
  };
}

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
        `The cut is ${(sizeBytes / 1_000_000).toFixed(1)} MB (> 100 MB Cloudflare MT ceiling). Shorten the window or lower the bitrate cap`,
      );
    }

    onProgress(`Clip ${clipId}: uploading ${(sizeBytes / 1_000_000).toFixed(1)} MB…`);
    const presign = await adminApiPost<ClipPresignResponse>(
      `/api/v1/admin/clips/${encodeURIComponent(clipId)}/cut/presign`,
      { contentType: "video/mp4" },
    );

    await putClip(presign.url, presign.contentType, outputPath);

    await adminApiPost<ClipCutFinalizeResponse>(
      `/api/v1/admin/clips/${encodeURIComponent(clipId)}/cut/finalize`,
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

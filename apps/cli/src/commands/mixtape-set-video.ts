// Fluncle Studio — `distribute --set-video`. Derive ONE 1080p faststart
// rendition of the set with ffmpeg (the operator's Mac), multipart-upload it straight
// to R2 at `<logId>/set.mp4`, and flip `setVideoAt` so the `/log` player + the video
// SEO light up. The raw multi-GB master never goes to R2 — only this rendition does
// (it serves the `/log` player, the editor scrub, and the clip cut).
//
// The bytes move CLI-direct: the rendition is ~1.5GB, past the single-PUT presign
// budget, so the Worker OPENS a multipart upload + presigns the parts (operator-tier
// `presign_set_video_upload`) and the CLI streams each part to R2 and completes the
// upload itself — the same direct-to-R2 constraint as the YouTube/Mixcloud legs.

import { type MixtapeUpdateResponse } from "@fluncle/contracts";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminApiPatch, adminApiPost } from "../api";
import { CliError } from "../output";

// The public read base for stored artifacts (matches the Worker's FOUND_BASE).
const FOUND_BASE = "https://found.fluncle.com";

// The 1080p faststart rendition spec: clip-capable,
// dense-ish GOP for scrubbing, H.264 + AAC. ~CRF 20 lands a 48-min set near 1.5–2 GB.
export const SET_VIDEO_RENDITION = {
  audioBitrate: "192k",
  crf: 20,
  gopSeconds: 2,
  height: 1080,
} as const;

// 100 MB default part — well above R2's 5 MB floor, well under the 10k-part cap for a
// multi-GB set, and a sane chunk to retry on a home line.
export const DEFAULT_PART_SIZE = 100 * 1024 * 1024;

// S3/R2's minimum part size (every part except the last must clear it).
export const MIN_PART_SIZE = 5 * 1024 * 1024;

// S3/R2's hard cap on parts per upload (mirrors the Worker's R2_MAX_PARTS).
export const MAX_PARTS = 10_000;

export type MultipartPlanPart = { end: number; partNumber: number; size: number; start: number };
export type MultipartPlan = { partCount: number; partSize: number; parts: MultipartPlanPart[] };

/**
 * Split a file of `contentLength` bytes into ordered, contiguous multipart chunks.
 * Grows the part size if the default would exceed the 10k-part cap, so any size fits.
 * Pure — the directly testable core of the upload (no ffmpeg, no network).
 */
export function planMultipart(contentLength: number, partSize = DEFAULT_PART_SIZE): MultipartPlan {
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new CliError(
      "invalid_size",
      `The rendition size must be a positive integer (got ${contentLength})`,
    );
  }

  let effective = Math.max(partSize, MIN_PART_SIZE);

  // Grow the part size so the chunk count never exceeds the cap (a huge set still fits
  // in 10k parts). Only the last part may fall below the floor.
  if (Math.ceil(contentLength / effective) > MAX_PARTS) {
    effective = Math.ceil(contentLength / MAX_PARTS);
  }

  const parts: MultipartPlanPart[] = [];
  let start = 0;
  let partNumber = 1;

  while (start < contentLength) {
    const end = Math.min(start + effective, contentLength);
    parts.push({ end, partNumber, size: end - start, start });
    start = end;
    partNumber += 1;
  }

  return { partCount: parts.length, partSize: effective, parts };
}

export type CompletedPart = { etag: string; partNumber: number };

function escapeXml(value: string): string {
  return value.replace(
    /[<>&'"]/g,
    (char) =>
      ({ '"': "&quot;", "&": "&amp;", "'": "&apos;", "<": "&lt;", ">": "&gt;" })[char] ?? char,
  );
}

/**
 * Build the CompleteMultipartUpload XML body S3/R2 expects: every part in ascending
 * partNumber order with its returned ETag. Pure + testable.
 */
export function buildCompleteXml(parts: CompletedPart[]): string {
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const body = ordered
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
    )
    .join("");

  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

/**
 * The ffmpeg argv that derives the 1080p faststart rendition from the master. Pure
 * (a thin shell-out spec), so the arg shape is unit-tested without invoking ffmpeg.
 * `-force_key_frames` keeps a ~2s GOP independent of the source fps (good scrubbing),
 * and `scale=-2:1080` keeps aspect with an even width.
 */
export function renditionFfmpegArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `scale=-2:${SET_VIDEO_RENDITION.height}`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(SET_VIDEO_RENDITION.crf),
    "-force_key_frames",
    `expr:gte(t,n_forced*${SET_VIDEO_RENDITION.gopSeconds})`,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    SET_VIDEO_RENDITION.audioBitrate,
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

export type StageSetVideoResult = { key: string; url: string };

// The presign response shape both set-video presigns share (mixtape's `<logId>/set.mp4`
// and the recording's owned `recordings/<id>/set.mp4`): every leg the CLI drives.
type RenditionPresign = {
  abortUrl: string;
  completeUrl: string;
  key: string;
  parts: { partNumber: number; url: string }[];
};

/**
 * Derive the 1080p faststart rendition (ffmpeg) → multipart-upload it straight to R2 via
 * the given presign endpoint. Shared by the mixtape set-video stage and the RFC recording
 * upload — the only difference is the presign PATH (the mixtape's derived `<logId>/set.mp4`
 * vs the recording's OWNED `recordings/<id>/set.mp4`) and whether the caller flips a
 * `setVideoAt` afterward. Returns the R2 key + public URL.
 */
export async function uploadRenditionMultipart(
  masterPath: string,
  presignPath: string,
  onProgress: (message: string) => void = () => {},
): Promise<StageSetVideoResult> {
  if (!existsSync(masterPath)) {
    throw new CliError("file_not_found", `Set-video master not found: ${masterPath}`);
  }

  await assertFfmpeg();

  const renditionPath = join(tmpdir(), `fluncle-set-${randomUUID()}.mp4`);

  onProgress("Set video: deriving the 1080p faststart rendition (ffmpeg)…");
  await deriveRendition(masterPath, renditionPath);

  try {
    const size = statSync(renditionPath).size;
    const plan = planMultipart(size);

    onProgress(
      `Set video: uploading ${(size / 1_000_000_000).toFixed(2)} GB in ${plan.partCount} part(s)…`,
    );

    const presign = await adminApiPost<{ ok: true } & RenditionPresign>(presignPath, {
      partCount: plan.partCount,
    });

    const urlByPart = new Map(presign.parts.map((part) => [part.partNumber, part.url]));
    const completed: CompletedPart[] = [];

    try {
      for (const part of plan.parts) {
        const url = urlByPart.get(part.partNumber);

        if (!url) {
          throw new CliError(
            "presign_missing",
            `Worker did not sign part ${part.partNumber} of ${plan.partCount}`,
          );
        }

        onProgress(`Set video: part ${part.partNumber}/${plan.partCount}`);
        const etag = await putPart(url, renditionPath, part);
        completed.push({ etag, partNumber: part.partNumber });
      }

      await completeUpload(presign.completeUrl, completed);
    } catch (error) {
      // Best-effort: drop the half-finished upload so orphaned parts don't linger.
      await abortUpload(presign.abortUrl).catch(() => {});
      throw error;
    }

    return { key: presign.key, url: `${FOUND_BASE}/${presign.key}` };
  } finally {
    rmSync(renditionPath, { force: true });
  }
}

/**
 * Stage the set-video rendition end to end: derive → multipart-upload to R2 →
 * flip `setVideoAt`. Idempotent: a re-run on a published mixtape re-stages + re-
 * flips (backfills an older set). Default stages public (distribute = publish); the
 * pre-release embargo (stage private, flip on release) is a documented later hook,
 * not built here.
 */
export async function stageSetVideo(
  mixtapeId: string,
  masterPath: string,
  onProgress: (message: string) => void = () => {},
): Promise<StageSetVideoResult> {
  const result = await uploadRenditionMultipart(
    masterPath,
    `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/set-video/presign`,
    onProgress,
  );

  // Flip `setVideoAt` via the operator-tier update_mixtape (loose passthrough body)
  // → the /log player + the <video:video> sitemap entry + the VideoObject light up.
  await adminApiPatch<MixtapeUpdateResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}`,
    {
      setVideoAt: new Date().toISOString(),
    },
  );

  onProgress("Set video: flipped setVideoAt — the /log player + video SEO are live.");

  return result;
}

// PUT one chunk straight to its presigned URL and return the ETag R2 reports (needed
// to complete the upload). Bun.file().slice() is a lazy, FS-backed Blob, so only the
// part's bytes are read, not the whole rendition.
async function putPart(url: string, path: string, part: MultipartPlanPart): Promise<string> {
  const response = await fetch(url, {
    body: Bun.file(path).slice(part.start, part.end),
    method: "PUT",
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new CliError(
      "r2_part_failed",
      `R2 rejected part ${part.partNumber} (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }

  const etag = response.headers.get("etag");

  if (!etag) {
    throw new CliError("r2_no_etag", `R2 returned no ETag for part ${part.partNumber}`);
  }

  return etag;
}

// POST the completion XML to the presigned complete URL. S3/R2 can return 200 with an
// <Error> in the body, so the body is checked too — a 200 alone is not success.
async function completeUpload(url: string, parts: CompletedPart[]): Promise<void> {
  const response = await fetch(url, {
    body: buildCompleteXml(parts),
    headers: { "content-type": "application/xml" },
    method: "POST",
  });

  const text = await response.text().catch(() => "");

  if (!response.ok || text.includes("<Error>")) {
    throw new CliError(
      "r2_complete_failed",
      `R2 CompleteMultipartUpload failed (${response.status} ${response.statusText})${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
}

async function abortUpload(url: string): Promise<void> {
  await fetch(url, { method: "DELETE" });
}

// Probe ffmpeg before deriving so the failure is a clear, actionable message rather
// than an opaque spawn error (CI never reaches this — the flag isn't exercised there).
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
      "--set-video needs ffmpeg to derive the 1080p rendition. Install it (brew install ffmpeg).",
    );
  }
}

async function deriveRendition(inputPath: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...renditionFfmpegArgs(inputPath, outputPath)], {
    stderr: "pipe",
    stdout: "ignore",
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const detail = (await new Response(proc.stderr).text().catch(() => "")).slice(-400);
    throw new CliError(
      "ffmpeg_failed",
      `ffmpeg failed to derive the set-video rendition${detail ? `: ${detail}` : ""}`,
    );
  }
}

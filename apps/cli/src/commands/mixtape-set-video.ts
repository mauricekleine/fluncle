// Multipart upload helpers for CLI-direct R2 transfers (set-video renditions). The
// rendition is ~1.5GB, past the single-PUT presign budget, so the Worker OPENS a
// multipart upload + presigns the parts and the CLI streams each part to R2 and
// completes the upload itself. Used by the recording upload (`recordings create`)
// via `uploadRenditionMultipart`.

import {
  buildCompleteXml,
  type CompletedPart,
  DEFAULT_PART_SIZE,
  MAX_PARTS,
  MIN_PART_SIZE,
  type MultipartPlanPart,
  planMultipart,
} from "@fluncle/contracts/util/multipart";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminApiPost } from "../api";
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

// The multipart plan + completion XML are the PURE core of the upload — one source of
// truth in `@fluncle/contracts/util/multipart`, shared with the browser recording uploader
// (`apps/web/.../recording-upload.ts`). Re-exported so the CLI's callers + tests keep
// importing them from this module; only the impure transport below (ffmpeg + the R2 PUTs)
// lives in the CLI.
export { buildCompleteXml, DEFAULT_PART_SIZE, MAX_PARTS, MIN_PART_SIZE, planMultipart };

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

// The presign response shape for a set-video upload (the recording's owned
// `recordings/<id>/set.mp4`, or — via promote — the mixtape's `<logId>/set.mp4`).
type RenditionPresign = {
  abortUrl: string;
  completeUrl: string;
  key: string;
  parts: { partNumber: number; url: string }[];
};

/**
 * Derive the 1080p faststart rendition (ffmpeg) → multipart-upload it straight to R2
 * via the given presign endpoint. The presign PATH is the recording's OWNED key
 * (`recordings/<id>/set.mp4`); `promote_recording` server-side copies it to
 * `<logId>/set.mp4` when the recording is promoted. Returns the R2 key + public URL.
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
        const etag = await putPart(url, renditionPath, part, onProgress);
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

// Attempts per part before giving up. R2 PUTs drop the socket ("socket connection was
// closed unexpectedly") intermittently on a home uplink — one flaky part must not abort a
// multi-hundred-part upload, so each part retries with exponential backoff.
export const MAX_PART_ATTEMPTS = 5;

// PUT one chunk to its presigned URL, WITH RETRY, and return the ETag R2 reports (needed to
// complete the upload). `Bun.file().slice()` reads only the part's bytes (not the whole
// rendition), materialized to a concrete ArrayBuffer so fetch sets Content-Length. The
// load-bearing reliability fix is the retry loop: a transient socket drop or 5xx is retried;
// a permanent 4xx / missing ETag is surfaced immediately.
export async function putPart(
  url: string,
  path: string,
  part: MultipartPlanPart,
  onProgress: (message: string) => void = () => {},
): Promise<string> {
  const body = await Bun.file(path).slice(part.start, part.end).arrayBuffer();

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await putPartOnce(url, body, part);
    } catch (error) {
      // A CliError is permanent (bad request/signature, or a missing ETag) — never retried.
      // Anything else (a dropped socket → fetch rejects; a 5xx) is transient.
      if (error instanceof CliError) {
        throw error;
      }

      if (attempt >= MAX_PART_ATTEMPTS) {
        throw new CliError(
          "r2_part_failed",
          `Part ${part.partNumber} failed after ${MAX_PART_ATTEMPTS} attempts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const backoffMs = 500 * 2 ** (attempt - 1);
      onProgress(
        `Set video: part ${part.partNumber} dropped, retry ${attempt}/${MAX_PART_ATTEMPTS - 1} in ${backoffMs}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

// One PUT attempt. A permanent failure (4xx / missing ETag) throws a `CliError` so the retry
// loop stops; a transient one (a dropped socket makes fetch reject; a 5xx) throws a plain
// Error so the caller retries.
async function putPartOnce(
  url: string,
  body: ArrayBuffer,
  part: MultipartPlanPart,
): Promise<string> {
  const response = await fetch(url, { body, method: "PUT" });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);

    if (response.status < 500) {
      throw new CliError(
        "r2_part_failed",
        `R2 rejected part ${part.partNumber} (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
      );
    }

    throw new Error(
      `R2 ${response.status} ${response.statusText} on part ${part.partNumber}${detail ? `: ${detail}` : ""}`,
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

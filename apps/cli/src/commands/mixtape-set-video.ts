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

const FOUND_BASE = "https://found.fluncle.com";

export const SET_VIDEO_RENDITION = {
  audioBitrate: "192k",
  crf: 20,
  gopSeconds: 2,
  height: 1080,
} as const;

export { buildCompleteXml, DEFAULT_PART_SIZE, MAX_PARTS, MIN_PART_SIZE, planMultipart };

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

type RenditionPresign = {
  abortUrl: string;
  completeUrl: string;
  key: string;
  parts: { partNumber: number; url: string }[];
};

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
      await abortUpload(presign.abortUrl).catch(() => {});
      throw error;
    }

    return { key: presign.key, url: `${FOUND_BASE}/${presign.key}` };
  } finally {
    rmSync(renditionPath, { force: true });
  }
}

export const MAX_PART_ATTEMPTS = 5;

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

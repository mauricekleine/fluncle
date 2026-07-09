// YouTube distribution (mixtape video). Mirrors the track-video R2 flow: the
// Worker mints a capability (a resumable session URI + a short-lived access token —
// the YouTube data PUT is NOT self-authorizing), the CLI streams the local bytes
// straight to YouTube (the Worker can't proxy multi-GB media), then the Worker
// records the result. The unlisted→public flip is a separate server-side call (the
// Worker holds the refresh token).

import { statSync } from "node:fs";
import {
  type MixtapeDistributeFinalizeResponse,
  type MixtapesResponse,
  type MixtapeYouTubeInitiateResponse,
  type MixtapeYouTubeResyncResponse,
  type YouTubeAuthStartResponse,
} from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";

export type YoutubeDistributeResult = { url: string; videoId: string };
export type YoutubeResyncResult = { url: string; videoId: string };

// YouTube's resumable session can outlive the access token on a multi-GB upload; a
// fresh token is re-minted on 401 and the upload resumes at the recorded offset.
const MAX_UPLOAD_ATTEMPTS = 6;

type YoutubeVideoResource = { id?: string };

export async function distributeYoutube(
  mixtapeId: string,
  videoPath: string,
  onProgress?: (message: string) => void,
): Promise<YoutubeDistributeResult> {
  const contentLength = fileSize(videoPath);
  const contentType = "video/mp4";

  onProgress?.(`Opening YouTube upload session (${formatBytes(contentLength)})`);
  let session = await initiate(mixtapeId, contentLength, contentType);

  let offset = 0;
  let attempts = 0;
  let videoId: string | undefined;

  while (videoId === undefined) {
    attempts += 1;

    if (attempts > MAX_UPLOAD_ATTEMPTS) {
      throw new CliError(
        "youtube_upload_failed",
        `YouTube upload did not complete after ${MAX_UPLOAD_ATTEMPTS} attempts`,
      );
    }

    onProgress?.(
      offset > 0
        ? `Resuming upload at ${formatBytes(offset)} / ${formatBytes(contentLength)}`
        : `Uploading video → YouTube`,
    );

    const result = await putChunk({
      accessToken: session.accessToken,
      contentLength,
      contentType,
      offset,
      sessionUri: session.sessionUri,
      videoPath,
    });

    if (result.kind === "done") {
      videoId = result.videoId;
      break;
    }

    if (result.kind === "incomplete") {
      offset = result.offset;
      continue;
    }

    if (result.kind === "reauth") {
      // Token expired mid-upload (likely on a slow multi-GB upload that outlived the
      // ~1h token). Re-mint ONLY the access token and KEEP the same session URI — it
      // stays valid for days — then resume at the offset the session already holds.
      // Re-initiating here would open a fresh 0-byte session and waste the upload.
      onProgress?.("Access token expired, re-minting and resuming");
      session = { accessToken: await mintToken(), sessionUri: session.sessionUri };
      offset = await queryOffset(session.sessionUri, session.accessToken, contentLength);
      continue;
    }

    // reinit (410/404): the session is gone — open a brand-new one from the start.
    onProgress?.("Upload session expired, re-initiating");
    session = await initiate(mixtapeId, contentLength, contentType);
    offset = 0;
  }

  onProgress?.("Recording the YouTube link");
  await adminApiPost<MixtapeDistributeFinalizeResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/youtube/finalize`,
    { videoId },
  );

  return { url: `https://youtu.be/${videoId}`, videoId };
}

export async function publishYoutubeCommand(idOrLogId: string): Promise<{ url: string }> {
  const mixtapeId = await resolveMixtapeId(idOrLogId);
  const response = await adminApiPost<{ ok: true; url: string }>(
    `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/youtube/publish`,
  );

  return { url: response.url };
}

/**
 * Re-sync the live YouTube video's description + chapters from the mixtape's CURRENT
 * cues — no re-upload. Fully server-side (the Worker holds the refresh token +
 * runs videos.list/videos.update); the CLI just triggers it and reports the link.
 * The `mixtapeId` is already resolved by the orchestrating resync command.
 */
export async function resyncYoutube(mixtapeId: string): Promise<YoutubeResyncResult> {
  const response = await adminApiPost<MixtapeYouTubeResyncResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/youtube/resync`,
  );

  return { url: response.url, videoId: response.videoId };
}

export async function authYoutubeCommand(): Promise<void> {
  const response = await adminApiGet<YouTubeAuthStartResponse>("/api/admin/youtube/auth/start");

  console.log(`Open this YouTube authorization URL:

${response.authUrl}

After approving access, Google returns to the Fluncle admin callback and stores the refresh token server-side.`);
}

async function initiate(
  mixtapeId: string,
  contentLength: number,
  contentType: string,
): Promise<{ accessToken: string; sessionUri: string }> {
  const response = await adminApiPost<MixtapeYouTubeInitiateResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/youtube/initiate`,
    { contentLength, contentType },
  );

  return { accessToken: response.accessToken, sessionUri: response.sessionUri };
}

// Re-mint a fresh access token without opening a new session (for resume-on-401).
async function mintToken(): Promise<string> {
  const response = await adminApiPost<{ accessToken: string; ok: true }>(
    "/api/admin/youtube/token",
  );

  return response.accessToken;
}

type PutResult =
  | { kind: "done"; videoId: string }
  | { kind: "incomplete"; offset: number }
  | { kind: "reauth" }
  | { kind: "reinit" };

async function putChunk(args: {
  accessToken: string;
  contentLength: number;
  contentType: string;
  offset: number;
  sessionUri: string;
  videoPath: string;
}): Promise<PutResult> {
  const { accessToken, contentLength, contentType, offset, sessionUri, videoPath } = args;
  // Stream from the offset so a resume never rebuffers the whole file.
  const body = offset > 0 ? Bun.file(videoPath).slice(offset) : Bun.file(videoPath);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": contentType,
  };

  if (offset > 0) {
    headers["Content-Range"] = `bytes ${offset}-${contentLength - 1}/${contentLength}`;
  }

  const response = await fetch(sessionUri, { body, headers, method: "PUT" });

  // The terminal response IS the Video resource JSON (incl. id) — no videos.list.
  if (response.status === 200 || response.status === 201) {
    const video = (await response.json().catch(() => ({}))) as YoutubeVideoResource;

    if (!video.id) {
      throw new CliError(
        "youtube_no_video_id",
        "YouTube returned no video id on upload completion",
      );
    }

    return { kind: "done", videoId: video.id };
  }

  // 308 Resume Incomplete: continue from the next byte after the confirmed Range.
  if (response.status === 308) {
    return { kind: "incomplete", offset: nextOffset(response.headers.get("Range"), offset) };
  }

  if (response.status === 401) {
    return { kind: "reauth" };
  }

  if (response.status === 404 || response.status === 410) {
    return { kind: "reinit" };
  }

  const detail = (await response.text().catch(() => "")).slice(0, 400);
  throw new CliError(
    "youtube_put_failed",
    `YouTube upload PUT failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
  );
}

// Query how many bytes the session already holds by PUTting an empty body with a
// Content-Range of `bytes */total`. A 308 carries the confirmed Range; a 200/201
// means the upload already completed.
async function queryOffset(
  sessionUri: string,
  accessToken: string,
  contentLength: number,
): Promise<number> {
  const response = await fetch(sessionUri, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Range": `bytes */${contentLength}`,
    },
    method: "PUT",
  });

  if (response.status === 200 || response.status === 201) {
    return contentLength;
  }

  if (response.status === 308) {
    return nextOffset(response.headers.get("Range"), 0);
  }

  // Anything else (e.g. the session is gone): restart from 0.
  return 0;
}

// A resumable Range header is `bytes=0-<lastByte>`; the next offset is lastByte+1.
// Falls back to the prior offset when the header is missing/unparseable. Exported
// for unit testing the resume-offset math.
export function nextOffset(rangeHeader: string | null, fallback: number): number {
  if (!rangeHeader) {
    return fallback;
  }

  const match = rangeHeader.match(/bytes=0-(\d+)/);

  if (!match) {
    return fallback;
  }

  return Number(match[1]) + 1;
}

async function resolveMixtapeId(idOrLogId: string): Promise<string> {
  const response = await adminApiGet<MixtapesResponse>("/api/admin/mixtapes");
  const match = response.mixtapes.find(
    (mixtape) => mixtape.id === idOrLogId || mixtape.logId === idOrLogId,
  );

  if (!match?.id) {
    throw new CliError("mixtape_not_found", `No mixtape with id or Log ID ${idOrLogId}`);
  }

  return match.id;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    throw new CliError("video_not_found", `Cannot read video file at ${path}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  return `${bytes} B`;
}

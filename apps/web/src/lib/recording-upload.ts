// The BROWSER recording uploader — the web sibling of the CLI's
// `uploadRenditionMultipart` (apps/cli/.../mixtape-set-video.ts). The operator picks a
// set-video master in the admin; this streams it straight to R2 as an S3 multipart upload,
// so the multi-GB bytes never traverse the Worker (Cloudflare's ~100 MB edge-body limit is
// the same wall the CLI hits). The pure core — the part plan + the completion XML — is the
// ONE shared source of truth in `@fluncle/contracts/util/multipart`; only the transport
// differs from the CLI: `File.slice()` instead of `Bun.file().slice()` (memory-safe — the
// browser streams a Blob view of the file from disk, never reading the whole thing into JS
// memory), and `XMLHttpRequest` for the part PUT so `upload.onprogress` drives a true
// byte-level progress bar (fetch cannot report upload progress).
//
// THE CORS CONTRACT (the one thing the CLI never needs, because Node has no CORS): the
// browser PUTs cross-origin to R2 and must READ the ETag response header to complete the
// upload. That requires the `fluncle-videos` bucket CORS to (a) allow PUT/POST/DELETE from
// the admin origin and (b) EXPOSE the ETag header. The policy lives in `apps/web/r2-cors.json`
// (apply with `wrangler r2 bucket cors set fluncle-videos --file apps/web/r2-cors.json`); a
// missing ETag surfaces below as a precise, actionable error rather than a silent hang.

import {
  buildCompleteXml,
  type CompletedPart,
  type MultipartPlanPart,
  planMultipart,
} from "@fluncle/contracts/util/multipart";

// Attempts per part before giving up — mirrors the CLI's `MAX_PART_ATTEMPTS`. R2 PUTs drop
// the socket intermittently on a home uplink, so a transient drop/5xx is retried with
// exponential backoff; a permanent 4xx or an unreadable ETag is surfaced immediately.
export const MAX_PART_ATTEMPTS = 5;

/** The `presign_recording_upload` response shape (see admin-recordings contract). */
export type RecordingPresign = {
  abortUrl: string;
  completeUrl: string;
  key: string;
  parts: { partNumber: number; url: string }[];
  recordingId: string;
  uploadId: string;
};

/** A live snapshot of the upload, emitted on every byte tick + part boundary. */
export type UploadProgress = {
  /** Bytes durably uploaded (completed parts) plus the in-flight part's live `loaded`. */
  uploadedBytes: number;
  totalBytes: number;
  /** Parts fully uploaded so far. */
  completedParts: number;
  totalParts: number;
  /** The part currently uploading (1-based). */
  currentPart: number;
  /** A transient retry notice for the current part, cleared once it succeeds. */
  retry?: { attempt: number; maxAttempts: number; backoffMs: number };
};

/** A permanent, do-not-retry failure (a 4xx, or an unreadable ETag → a CORS misconfig). */
export class PermanentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentUploadError";
  }
}

/** Was this thrown because the operator (or a tab close) aborted the upload? */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Open a multipart upload for a recording's set video (same-origin admin API). */
export async function presignRecordingUpload(
  recordingId: string,
  partCount: number,
  contentType: string | undefined,
): Promise<RecordingPresign> {
  const response = await fetch(
    `/api/v1/admin/recordings/${encodeURIComponent(recordingId)}/set-video/presign`,
    {
      body: JSON.stringify({ contentType, partCount }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as RecordingPresign;
}

/**
 * Stream `file` to R2 across the presigned parts, with per-part retry and live progress.
 * On ANY failure (a permanent error, an exhausted retry, or an abort) the half-finished
 * multipart upload is aborted best-effort so no orphaned parts linger, and the error is
 * rethrown for the caller to clean up the recording row (so a failed upload never leaves a
 * phantom recording). Returns the stored key on success.
 */
export async function uploadFileToPresign(
  file: File,
  presign: RecordingPresign,
  options: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<{ key: string }> {
  const { onProgress, signal } = options;
  const plan = planMultipart(file.size);
  const urlByPart = new Map(presign.parts.map((part) => [part.partNumber, part.url]));
  const completed: CompletedPart[] = [];
  let uploadedBytes = 0;

  try {
    for (const part of plan.parts) {
      const url = urlByPart.get(part.partNumber);

      if (!url) {
        throw new PermanentUploadError(
          `The upload was not signed for part ${part.partNumber} of ${plan.partCount}`,
        );
      }

      const blob = file.slice(part.start, part.end);
      const emit = (partLoaded: number, retry?: UploadProgress["retry"]) =>
        onProgress?.({
          completedParts: completed.length,
          currentPart: part.partNumber,
          retry,
          totalBytes: file.size,
          totalParts: plan.partCount,
          uploadedBytes: uploadedBytes + partLoaded,
        });

      emit(0);
      const etag = await putPartWithRetry(url, blob, part, { emit, signal });
      completed.push({ etag, partNumber: part.partNumber });
      uploadedBytes += part.size;
      emit(0);
    }

    await completeMultipart(presign.completeUrl, completed);

    return { key: presign.key };
  } catch (error) {
    // Best-effort: drop the half-finished upload so orphaned parts don't linger on R2.
    await abortMultipart(presign.abortUrl).catch(() => {});
    throw error;
  }
}

/** DELETE the presigned abort URL — drops any uploaded parts. Best-effort. */
export async function abortMultipart(abortUrl: string): Promise<void> {
  await fetch(abortUrl, { method: "DELETE" });
}

/** POST the completion XML. R2 can answer 200 with an `<Error>` body, so the body is checked. */
async function completeMultipart(completeUrl: string, parts: CompletedPart[]): Promise<void> {
  const response = await fetch(completeUrl, {
    body: buildCompleteXml(parts),
    headers: { "Content-Type": "application/xml" },
    method: "POST",
  });
  const text = await response.text().catch(() => "");

  if (!response.ok || text.includes("<Error>")) {
    throw new Error(
      `R2 could not assemble the upload (${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
}

// PUT one part WITH RETRY, returning the ETag R2 reports. A permanent failure (4xx / no
// readable ETag) or an abort is surfaced at once; a transient drop/5xx retries with
// exponential backoff (mirrors the CLI's `putPart`).
async function putPartWithRetry(
  url: string,
  blob: Blob,
  part: MultipartPlanPart,
  handlers: {
    emit: (partLoaded: number, retry?: UploadProgress["retry"]) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await putPartOnce(url, blob, (loaded) => handlers.emit(loaded), handlers.signal);
    } catch (error) {
      // An abort (operator cancel / tab close) or a permanent error never retries.
      if (isAbortError(error) || error instanceof PermanentUploadError) {
        throw error;
      }

      if (attempt >= MAX_PART_ATTEMPTS) {
        throw new Error(
          `Part ${part.partNumber} failed after ${MAX_PART_ATTEMPTS} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const backoffMs = 500 * 2 ** (attempt - 1);
      handlers.emit(0, { attempt, backoffMs, maxAttempts: MAX_PART_ATTEMPTS - 1 });
      await sleep(backoffMs, handlers.signal);
    }
  }
}

// One PUT attempt via XMLHttpRequest (fetch cannot report upload progress). Resolves the
// ETag; rejects with `PermanentUploadError` on a 4xx or an unreadable ETag, a plain Error on
// a transient network/5xx, or an `AbortError` DOMException when the signal fires.
function putPartOnce(
  url: string,
  blob: Blob,
  onLoaded: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();

    xhr.open("PUT", url);
    // `file.slice()` yields a Blob with an empty type, so XHR sends no Content-Type — the
    // object's type was already baked at CreateMultipartUpload time, and an unsigned header
    // would be ignored by the part signature anyway.
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onLoaded(event.loaded);
      }
    };

    const onAbort = () => xhr.abort();

    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    xhr.onload = () => {
      cleanup();

      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag");

        if (!etag) {
          reject(
            new PermanentUploadError(
              "R2 returned no readable ETag — the fluncle-videos bucket CORS must expose the ETag header (apply apps/web/r2-cors.json)",
            ),
          );
          return;
        }

        resolve(etag);
      } else if (xhr.status < 500) {
        reject(new PermanentUploadError(`R2 rejected the part (${xhr.status} ${xhr.statusText})`));
      } else {
        reject(new Error(`R2 ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => {
      cleanup();
      // A network drop OR a blocked CORS request both land here. Transient → retried.
      reject(new Error("Network error (a dropped connection, or R2 CORS is not configured)"));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    xhr.send(blob);
  });
}

/** A cancellable sleep — rejects with AbortError if the signal fires during the backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }

  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || `Request failed (${response.status})`;
}

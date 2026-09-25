import {
  buildCompleteXml,
  type CompletedPart,
  type MultipartPlanPart,
  planMultipart,
} from "@fluncle/contracts/util/multipart";
import { readError } from "./read-error";

export const MAX_PART_ATTEMPTS = 5;

export type RecordingPresign = {
  abortUrl: string;
  completeUrl: string;
  key: string;
  parts: { partNumber: number; url: string }[];
  recordingId: string;
  uploadId: string;
};

export type UploadProgress = {
  uploadedBytes: number;
  totalBytes: number;

  completedParts: number;
  totalParts: number;

  currentPart: number;

  retry?: { attempt: number; maxAttempts: number; backoffMs: number };
};

export class PermanentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentUploadError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

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
    throw new Error(await readError(response));
  }

  return (await response.json()) as RecordingPresign;
}

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
    await abortMultipart(presign.abortUrl).catch(() => {});
    throw error;
  }
}

export async function abortMultipart(abortUrl: string): Promise<void> {
  await fetch(abortUrl, { method: "DELETE" });
}

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

      reject(new Error("Network error (a dropped connection, or R2 CORS is not configured)"));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    xhr.send(blob);
  });
}

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

// The pure core of a direct-to-R2 multipart upload — the part-splitting plan and the
// CompleteMultipartUpload XML body. ONE source of truth shared by every driver:
//   - the CLI (`apps/cli/.../mixtape-set-video.ts`) streams `Bun.file().slice()` parts, and
//   - the browser (`apps/web/.../recording-upload.ts`) streams `File.slice()` parts.
// Client-safe and dependency-free (no `node:*`, no fetch) — a sibling to `galaxy-slug.ts`:
// only the impure PUT/complete/abort transport differs per driver, so it stays out of here.

// 16 MB default part — small enough that a home uplink reliably completes each PUT (100 MB
// parts dropped the socket intermittently mid-upload), well above R2's 5 MB floor, and well
// under the 10k-part cap for a multi-GB set. Paired with per-part retry in each driver so a
// single transient drop resumes instead of aborting the whole upload.
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;

// S3/R2's minimum part size (every part except the last must clear it).
export const MIN_PART_SIZE = 5 * 1024 * 1024;

// S3/R2's hard cap on parts per upload (mirrors the Worker's R2_MAX_PARTS).
export const MAX_PARTS = 10_000;

export type MultipartPlanPart = { end: number; partNumber: number; size: number; start: number };
export type MultipartPlan = { partCount: number; partSize: number; parts: MultipartPlanPart[] };

/**
 * Split a file of `contentLength` bytes into ordered, contiguous multipart chunks.
 * Grows the part size if the default would exceed the 10k-part cap, so any size fits.
 * Pure — the directly testable core of the upload (no ffmpeg, no network, no `Blob`).
 */
export function planMultipart(contentLength: number, partSize = DEFAULT_PART_SIZE): MultipartPlan {
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new Error(`multipart content length must be a positive integer (got ${contentLength})`);
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

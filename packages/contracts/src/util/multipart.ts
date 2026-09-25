export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;

export const MIN_PART_SIZE = 5 * 1024 * 1024;

export const MAX_PARTS = 10_000;

export type MultipartPlanPart = { end: number; partNumber: number; size: number; start: number };
export type MultipartPlan = { partCount: number; partSize: number; parts: MultipartPlanPart[] };

export function planMultipart(contentLength: number, partSize = DEFAULT_PART_SIZE): MultipartPlan {
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new Error(`multipart content length must be a positive integer (got ${contentLength})`);
  }

  let effective = Math.max(partSize, MIN_PART_SIZE);

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

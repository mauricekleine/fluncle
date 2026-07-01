// Presigned direct-to-R2 uploads for the video bundle.
//
// The single multipart POST through the Worker dies at Cloudflare's ~100MB edge
// body limit — a crf-20 cut is ~99MB and the bundle ships two of them. Instead
// the Worker SIGNS short-lived PUT URLs (SigV4 via aws4fetch) and the CLI PUTs
// each file straight to R2's S3 endpoint, so the bytes never traverse the zone.
//
// The Worker still owns the R2 credentials; the CLI only ever holds the admin
// token + these expiring URLs. R2 speaks the S3 API at
// https://<account>.r2.cloudflarestorage.com with region "auto".
//
// GOTCHA (the classic one): the Content-Type is baked into the signature (it is
// listed in X-Amz-SignedHeaders), so the CLI MUST PUT with the IDENTICAL
// Content-Type header or R2 rejects the request with SignatureDoesNotMatch.

import { AwsClient } from "aws4fetch";

import { readEnvs } from "./env";

// Presigned URLs live ~1h: long enough to push ~200MB on a slow line, short
// enough that a leaked URL is near-useless.
export const PRESIGN_TTL_SECONDS = 60 * 60;

// The R2 bucket name (matches `bucket_name` for the VIDEOS binding in
// wrangler.jsonc). The S3 API addresses the bucket by name in the URL path; the
// VIDEOS binding object itself exposes no name, so it is written down here.
export const VIDEOS_BUCKET = "fluncle-videos";

// The set-video rendition (~1.5GB) uploads in ~100MB multipart chunks over a home
// line, so its presigned URLs live longer than the single-PUT budget — long enough
// that the whole transfer (plus a retry or two) fits inside one signing.
export const MULTIPART_PRESIGN_TTL_SECONDS = 6 * 60 * 60;

// S3/R2's hard cap on parts per multipart upload; the caller's part plan must fit.
export const R2_MAX_PARTS = 10_000;

const R2_REGION = "auto";
const R2_SERVICE = "s3";

export type PresignTarget = { contentType: string; key: string };

// The signed S3 row this module produces — keyed by object key, with NO `field`.
// Distinct from the contract `PresignedUpload` DTO (../../../packages/contracts),
// which is the field-BEARING wire shape: the admin video handler joins each signed
// row back to its artifact `field` before emitting the response. Named apart so the
// two same-named-but-different shapes can't be confused (the field-less row here vs
// the field-bearing DTO on the wire).
export type SignedUpload = {
  /** The exact Content-Type the CLI MUST replay on its PUT (baked into the sig). */
  contentType: string;
  key: string;
  /** A short-lived presigned S3 PUT URL pointing at the R2 bucket. */
  url: string;
};

// Sign one presigned PUT URL per target. The bucket name is the first path
// segment of the S3-endpoint URL; the object key follows.
export async function presignUploads(
  bucket: string,
  targets: readonly PresignTarget[],
): Promise<SignedUpload[]> {
  const { R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_SECRET_ACCESS_KEY } = await readEnvs([
    "R2_ACCESS_KEY_ID",
    "R2_ACCOUNT_ID",
    "R2_SECRET_ACCESS_KEY",
  ]);

  const client = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    region: R2_REGION,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: R2_SERVICE,
  });

  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  return Promise.all(
    targets.map(async (target) => {
      // Encode each path segment so keys with reserved characters still sign and
      // resolve to the exact <bucket>/<key> object.
      const encodedKey = target.key.split("/").map(encodeURIComponent).join("/");
      const url = new URL(`${endpoint}/${bucket}/${encodedKey}`);
      url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));

      // signQuery: true puts the SigV4 params in the query string. By default
      // aws4fetch only signs `host` in query mode, so allHeaders: true is needed
      // to fold Content-Type into X-Amz-SignedHeaders — that binds the URL to the
      // exact content type, and the CLI MUST replay the identical header on its
      // PUT or R2 rejects with SignatureDoesNotMatch (the classic gotcha).
      const signed = await client.sign(url.toString(), {
        aws: { allHeaders: true, signQuery: true },
        headers: { "content-type": target.contentType },
        method: "PUT",
      });

      return { contentType: target.contentType, key: target.key, url: signed.url };
    }),
  );
}

// ── Multipart direct-to-R2 (the mixtape set-video rendition, ~1.5GB) ────────────
//
// A full set rendition is ~10–20× the single-PUT budget, so it goes up as an S3
// multipart upload. The Worker (which holds the R2 creds) OPENS the upload server-
// side (CreateMultipartUpload — that one call bakes the object's content type), then
// PRESIGNS one PUT URL per part plus the complete/abort URLs. The CLI streams each
// part straight to R2 and completes the upload itself, so the multi-GB bytes never
// traverse the zone — the same constraint that drives the single-PUT presign above.
//
// Part PUTs and the complete/abort calls sign with `signQuery` only (host in the
// signature, payload as UNSIGNED-PAYLOAD), so the CLI sends an arbitrary part body /
// completion XML to the exact returned URL — no Content-Type gotcha on the parts
// (the object's type was fixed at create time).

export type MultipartPart = { partNumber: number; url: string };

export type MultipartPresign = {
  /** A presigned DELETE URL that aborts the upload (drops any uploaded parts). */
  abortUrl: string;
  /** A presigned POST URL the CLI hits with the completion XML to assemble the object. */
  completeUrl: string;
  key: string;
  parts: MultipartPart[];
  uploadId: string;
};

async function r2Client(): Promise<{ client: AwsClient; endpoint: string }> {
  const { R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_SECRET_ACCESS_KEY } = await readEnvs([
    "R2_ACCESS_KEY_ID",
    "R2_ACCOUNT_ID",
    "R2_SECRET_ACCESS_KEY",
  ]);

  const client = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    region: R2_REGION,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: R2_SERVICE,
  });

  return { client, endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` };
}

// Per-segment encode so a key with reserved characters resolves to the exact object.
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// Pull the <UploadId> out of a CreateMultipartUpload XML response. Exported so the
// parse is unit-tested independently of the (un-mockable) network call that fetches it.
export function parseUploadId(xml: string): string {
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  const uploadId = match?.[1];

  if (!uploadId) {
    throw new Error("R2 CreateMultipartUpload returned no UploadId");
  }

  return uploadId;
}

// Presign one PUT URL per part (1-based partNumber, the S3 contract). Pure (no
// network): aws4fetch signs locally, so this is the directly testable core.
export async function presignMultipartParts(
  bucket: string,
  key: string,
  uploadId: string,
  partCount: number,
): Promise<MultipartPart[]> {
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > R2_MAX_PARTS) {
    throw new Error(`partCount must be an integer 1..${R2_MAX_PARTS}`);
  }

  const { client, endpoint } = await r2Client();
  const base = `${endpoint}/${bucket}/${encodeKey(key)}`;

  return Promise.all(
    Array.from({ length: partCount }, async (_unused, index) => {
      const partNumber = index + 1;
      const url = new URL(base);
      url.searchParams.set("partNumber", String(partNumber));
      url.searchParams.set("uploadId", uploadId);
      url.searchParams.set("X-Amz-Expires", String(MULTIPART_PRESIGN_TTL_SECONDS));

      const signed = await client.sign(url.toString(), {
        aws: { signQuery: true },
        method: "PUT",
      });

      return { partNumber, url: signed.url };
    }),
  );
}

// Presign the upload-management call (complete = POST, abort = DELETE). Pure.
export async function presignMultipartAction(
  bucket: string,
  key: string,
  uploadId: string,
  method: "DELETE" | "POST",
): Promise<string> {
  const { client, endpoint } = await r2Client();
  const url = new URL(`${endpoint}/${bucket}/${encodeKey(key)}`);
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("X-Amz-Expires", String(MULTIPART_PRESIGN_TTL_SECONDS));

  const signed = await client.sign(url.toString(), { aws: { signQuery: true }, method });

  return signed.url;
}

// Open an S3 multipart upload server-side and presign everything the CLI needs to
// drive it. The single network call here is CreateMultipartUpload; the rest is local
// signing. `contentType` is baked onto the object now (parts carry no type).
export async function presignMultipartUpload(
  bucket: string,
  key: string,
  contentType: string,
  partCount: number,
): Promise<MultipartPresign> {
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > R2_MAX_PARTS) {
    throw new Error(`partCount must be an integer 1..${R2_MAX_PARTS}`);
  }

  const { client, endpoint } = await r2Client();
  const base = `${endpoint}/${bucket}/${encodeKey(key)}`;

  const created = await client.fetch(`${base}?uploads`, {
    headers: { "content-type": contentType },
    method: "POST",
  });

  if (!created.ok) {
    const detail = (await created.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `R2 CreateMultipartUpload failed (${created.status} ${created.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }

  const uploadId = parseUploadId(await created.text());
  const [parts, completeUrl, abortUrl] = await Promise.all([
    presignMultipartParts(bucket, key, uploadId, partCount),
    presignMultipartAction(bucket, key, uploadId, "POST"),
    presignMultipartAction(bucket, key, uploadId, "DELETE"),
  ]);

  return { abortUrl, completeUrl, key, parts, uploadId };
}

// ── Server-side object copy + delete (the RFC recording-primitive promote path) ──
//
// No copy/delete existed in the repo before this — the video pipeline only ever
// PRESIGNED uploads for the CLI. `promote` needs a SAME-bucket (`fluncle-videos`)
// server-side copy (`recordings/<id>/set.mp4` → `<logId>/set.mp4`) plus a delete of
// the old key; both run in the Worker with the R2 creds (no presign, no bytes through
// the Worker — R2 does the copy internally from the `x-amz-copy-source` header).

// R2/S3's single-request CopyObject ceiling. A ~2 GB set rendition is comfortably
// under it; assert the source clears it before copying (a multi-part copy is not built).
const COPY_OBJECT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Server-side copy of one object to another key WITHIN `fluncle-videos` (SigV4 via the
 * same aws4fetch client as the multipart create — no presign, no bytes through the
 * Worker). Asserts the source is ≤ 5 GiB (the single-copy ceiling) via a HEAD first,
 * then issues the `PUT` copy. R2 answers 200 for CopyObject; a `<Error>` in the body is
 * a failure even on 200, so the body is parsed for `<CopyObjectResult>`.
 */
export async function copyObject(srcKey: string, destKey: string): Promise<void> {
  const { client, endpoint } = await r2Client();
  const source = `/${VIDEOS_BUCKET}/${encodeKey(srcKey)}`;
  const srcUrl = `${endpoint}/${VIDEOS_BUCKET}/${encodeKey(srcKey)}`;
  const destUrl = `${endpoint}/${VIDEOS_BUCKET}/${encodeKey(destKey)}`;

  // Assert the source is within the single-copy ceiling before attempting the copy.
  const head = await client.fetch(srcUrl, { method: "HEAD" });

  if (!head.ok) {
    throw new Error(
      `R2 HEAD of copy source failed (${head.status} ${head.statusText}) for ${srcKey}`,
    );
  }

  const contentLength = Number(head.headers.get("content-length") ?? "0");

  if (contentLength > COPY_OBJECT_MAX_BYTES) {
    throw new Error(
      `R2 CopyObject source ${srcKey} is ${contentLength} bytes (> 5 GiB single-copy ceiling)`,
    );
  }

  const copied = await client.fetch(destUrl, {
    headers: { "x-amz-copy-source": source },
    method: "PUT",
  });

  const body = (await copied.text().catch(() => "")).slice(0, 500);

  if (!copied.ok || body.includes("<Error>") || !body.includes("<CopyObjectResult")) {
    throw new Error(
      `R2 CopyObject failed (${copied.status} ${copied.statusText})${body ? `: ${body}` : ""}`,
    );
  }
}

/**
 * Server-side delete of one object in `fluncle-videos` (SigV4 via the same client). S3
 * DELETE is idempotent — it answers 204 whether or not the key existed — so an
 * already-gone key is not an error (the promote's best-effort old-key cleanup relies on
 * this). Any other non-2xx is a genuine failure.
 */
export async function deleteObject(key: string): Promise<void> {
  const { client, endpoint } = await r2Client();
  const url = `${endpoint}/${VIDEOS_BUCKET}/${encodeKey(key)}`;
  const deleted = await client.fetch(url, { method: "DELETE" });

  if (!deleted.ok && deleted.status !== 404) {
    const body = (await deleted.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `R2 DeleteObject failed (${deleted.status} ${deleted.statusText})${body ? `: ${body}` : ""}`,
    );
  }
}

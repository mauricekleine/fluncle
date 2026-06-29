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

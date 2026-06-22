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

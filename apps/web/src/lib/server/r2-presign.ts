import { AwsClient } from "aws4fetch";

import { readEnvs } from "./env";

export const PRESIGN_TTL_SECONDS = 60 * 60;

export const VIDEOS_BUCKET = "fluncle-videos";

export const MULTIPART_PRESIGN_TTL_SECONDS = 6 * 60 * 60;

export const R2_MAX_PARTS = 10_000;

const R2_REGION = "auto";
const R2_SERVICE = "s3";

export type PresignTarget = { contentType: string; key: string };

export type SignedUpload = {
  contentType: string;
  key: string;
  url: string;
};

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
      const encodedKey = target.key.split("/").map(encodeURIComponent).join("/");
      const url = new URL(`${endpoint}/${bucket}/${encodedKey}`);
      url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));

      const signed = await client.sign(url.toString(), {
        aws: { allHeaders: true, signQuery: true },
        headers: { "content-type": target.contentType },
        method: "PUT",
      });

      return { contentType: target.contentType, key: target.key, url: signed.url };
    }),
  );
}

export type MultipartPart = { partNumber: number; url: string };

export type MultipartPresign = {
  abortUrl: string;
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

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function parseUploadId(xml: string): string {
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  const uploadId = match?.[1];

  if (!uploadId) {
    throw new Error("R2 CreateMultipartUpload returned no UploadId");
  }

  return uploadId;
}

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

const COPY_OBJECT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export async function copyObject(srcKey: string, destKey: string): Promise<void> {
  const { client, endpoint } = await r2Client();
  const source = `/${VIDEOS_BUCKET}/${encodeKey(srcKey)}`;
  const srcUrl = `${endpoint}/${VIDEOS_BUCKET}/${encodeKey(srcKey)}`;
  const destUrl = `${endpoint}/${VIDEOS_BUCKET}/${encodeKey(destKey)}`;

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

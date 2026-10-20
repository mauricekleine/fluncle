import { createHmac, timingSafeEqual } from "node:crypto";

import { readImageSize } from "./cover-masters";
import { getDb } from "./db";
import { jsonError } from "./env";
import { type PublicUser } from "./public-auth";
import { avatarDisplayUrl } from "../media";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const AVATAR_MAX_DIMENSION = 512;

export const AVATAR_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const CSRF_WINDOW_MS = 24 * 60 * 60 * 1000;
const CSRF_HEADER = "x-fluncle-csrf";

type AvatarRejection = { code: string; message: string; ok: false; status: number };

export type AvatarValidation = AvatarRejection | { ext: string; ok: true };

const AVATAR_TOO_LARGE: AvatarRejection = {
  code: "too_large",
  message: "That image is too large. Pick one under 2 MB.",
  ok: false,
  status: 413,
};

export async function readAvatarBody(
  request: Request,
): Promise<AvatarRejection | { bytes: ArrayBuffer; ok: true }> {
  if (Number(request.headers.get("content-length")) > AVATAR_MAX_BYTES) {
    return AVATAR_TOO_LARGE;
  }

  if (!request.body) {
    return { bytes: new ArrayBuffer(0), ok: true };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > AVATAR_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return AVATAR_TOO_LARGE;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: body.buffer, ok: true };
}

export function validateAvatarUpload(contentType: string, bytes: ArrayBuffer): AvatarValidation {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = AVATAR_CONTENT_TYPES[mime];

  if (!ext) {
    return {
      code: "unsupported_type",
      message: "Upload a JPEG, PNG, or WebP image.",
      ok: false,
      status: 415,
    };
  }

  if (bytes.byteLength === 0) {
    return { code: "empty_upload", message: "The image was empty.", ok: false, status: 400 };
  }

  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    return AVATAR_TOO_LARGE;
  }

  const size = readImageSize(bytes);

  if (size && (size.width > AVATAR_MAX_DIMENSION || size.height > AVATAR_MAX_DIMENSION)) {
    return {
      code: "dimensions_too_large",
      message: `The image is larger than ${AVATAR_MAX_DIMENSION}px on a side.`,
      ok: false,
      status: 422,
    };
  }

  return { ext, ok: true };
}

export function verifyAvatarMutation(request: Request, user: PublicUser): Response | undefined {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (!origin && !referer) {
    return jsonError(403, "invalid_origin", "Missing request origin");
  }

  if (origin && origin !== requestOrigin) {
    return jsonError(403, "invalid_origin", "Invalid request origin");
  }

  if (!origin && referer) {
    try {
      if (new URL(referer).origin !== requestOrigin) {
        return jsonError(403, "invalid_origin", "Invalid request origin");
      }
    } catch {
      return jsonError(403, "invalid_origin", "Invalid request origin");
    }
  }

  if (!verifyCsrf(user, request.headers.get(CSRF_HEADER))) {
    return jsonError(403, "csrf_required", "Invalid account mutation token");
  }

  return undefined;
}

function verifyCsrf(user: PublicUser, token: string | null): boolean {
  if (!token) {
    return false;
  }

  const now = Date.now();

  return (
    timingSafeMatch(token, csrfFor(user, now)) ||
    timingSafeMatch(token, csrfFor(user, now - CSRF_WINDOW_MS))
  );
}

function csrfFor(user: PublicUser, at: number): string {
  const bucket = Math.floor(at / CSRF_WINDOW_MS);
  const body = `${user.id}.${bucket}`;
  const signature = createHmac("sha256", publicAuthSecret()).update(body).digest("base64url");

  return `${body}.${signature}`;
}

function timingSafeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function publicAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();

  if (secret) {
    return secret;
  }

  if (import.meta.env.DEV) {
    return "fluncle-dev-auth-secret-change-before-production";
  }

  throw new Error("BETTER_AUTH_SECRET is required outside local development");
}

export async function storeAvatar(
  bucket: Pick<R2Bucket, "put">,
  user: PublicUser,
  bytes: ArrayBuffer,
  contentType: string,
  ext: string,
): Promise<{ image: string }> {
  const key = `avatars/${user.id}.${ext}`;
  const version = Date.now();

  await bucket.put(key, bytes, {
    httpMetadata: { cacheControl: "public, max-age=604800", contentType },
  });

  const image = avatarDisplayUrl(user.id, ext, version);

  await (
    await getDb()
  ).execute({
    args: [image, Date.now(), user.id],
    sql: `update "user" set image = ?, updated_at = ? where id = ?`,
  });

  return { image };
}

export async function clearAvatar(user: PublicUser): Promise<{ image: null }> {
  await (
    await getDb()
  ).execute({
    args: [Date.now(), user.id],
    sql: `update "user" set image = null, updated_at = ? where id = ?`,
  });

  return { image: null };
}

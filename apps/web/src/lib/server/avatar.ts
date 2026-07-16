// The account portrait upload core (the /api/me/avatar route's logic, kept out of
// the route so the validation + CSRF gate are unit-testable without a Worker
// runtime). The route is the large-body/direct-upload carve-out (AGENTS.md): the
// browser downscales/crops the picked image to a ≤512² square JPEG and PUTs the
// bytes here; the Worker validates content-type + size + dimensions server-side,
// writes the object to the world-served R2 (`avatars/<userId>.<ext>` on
// found.fluncle.com), then stamps the served (Cloudflare Images) URL onto
// `user.image`. The user is ALWAYS derived from the session — never the body.
//
// Two writes, one key: an upload overwrites `avatars/<userId>.<ext>` in place and
// re-stamps `user.image` with a fresh `?v=<now>` bust; "remove photo" clears
// `user.image` (the object is left to be overwritten by the next upload — a
// dangling private-to-nobody R2 object is cheap and harmless, and R2 has no
// per-object cost pressure like the copyrighted source-audio bucket does).

import { createHmac, timingSafeEqual } from "node:crypto";

import { readImageSize } from "./cover-masters";
import { getDb } from "./db";
import { jsonError } from "./env";
import { type PublicUser } from "./public-auth";
import { avatarDisplayUrl } from "../media";

// A ≤512² JPEG is ~40–120 KB; 2 MB is a generous ceiling that still rejects a
// mis-sized or non-downscaled upload well before it reaches R2 (defense in depth
// behind the client-side canvas downscale).
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// The portrait plate is a 64px square and every served rendition is right-sized by
// Cloudflare Images, so the stored master never needs to exceed the brief's 512²
// cap. Enforced structurally: a larger image is REJECTED, never silently stored.
export const AVATAR_MAX_DIMENSION = 512;

// The upload content-types the client canvas emits (JPEG by default; PNG/WebP
// accepted for a lossless pick). Anything else is refused before any byte is read
// as an image. mime → the extension the R2 key carries.
export const AVATAR_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// The CSRF token window, mirrored from public-auth.ts (`csrfWindowMs`, not exported).
// A token minted at page load stays valid for its window and the one before it.
const CSRF_WINDOW_MS = 24 * 60 * 60 * 1000;
const CSRF_HEADER = "x-fluncle-csrf";

export type AvatarValidation =
  | { code: string; message: string; ok: false; status: number }
  | { ext: string; ok: true };

/**
 * Validate an uploaded avatar's content-type, byte size, and intrinsic dimensions —
 * the pure server-side gate (no R2, no DB), so a bad upload is rejected the same way
 * whether or not the bucket is reachable. The dimension read reuses the cover-master
 * header parser; an unrecognised container (no dims) still passes the type+size gate
 * (the type allow-list already bounds it to a raster image).
 */
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
    return {
      code: "too_large",
      message: "That image is too large. Pick one under 2 MB.",
      ok: false,
      status: 413,
    };
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

/**
 * The mutation guard for the binary upload route: same-origin + a valid CSRF token,
 * the same protection `requireJsonMutation` gives the JSON `/me` mutations — but
 * without its `application/json` content-type demand (this route carries image
 * bytes). Returns a 403 `Response` to block, or `undefined` to proceed. The CSRF
 * token is verified by recomputing it (public-auth's `createCsrfToken`) for the
 * current and previous window and comparing in constant time.
 */
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

// Recompute the account CSRF token for a window, byte-for-byte as public-auth's
// `createCsrfToken` mints it (id.bucket.hmac). Kept private here rather than
// widening public-auth's export surface (which this slice must not edit).
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

// The same secret resolution public-auth uses (dev falls back to the shared dev
// secret; prod requires BETTER_AUTH_SECRET). Duplicated as a tiny read rather than
// exported from public-auth to keep that module's surface unchanged.
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

/**
 * Store a validated avatar: PUT the bytes to the world-served bucket at
 * `avatars/<userId>.<ext>`, then stamp the served Cloudflare Images URL (with a
 * `?v=<now>` bust) onto `user.image`. Returns the stored URL. `bucket` is injected
 * (`env.VIDEOS`) so a test can pass a fake — the cover-masters discipline.
 */
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
    // A week's edge cache; the `?v=<version>` bust on the served URL re-keys the
    // rendition whenever the bytes change, so this never serves a stale face.
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

/** Clear the account portrait: null `user.image` so surfaces fall back to the glyph. */
export async function clearAvatar(user: PublicUser): Promise<{ image: null }> {
  await (
    await getDb()
  ).execute({
    args: [Date.now(), user.id],
    sql: `update "user" set image = null, updated_at = ? where id = ?`,
  });

  return { image: null };
}

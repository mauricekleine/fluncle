import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePublicAuthSecret } from "./public-auth";

export type FollowDigestPurpose = "manage" | "unsubscribe";

function signingKey(): Buffer {
  const secret = resolvePublicAuthSecret(process.env.BETTER_AUTH_SECRET, import.meta.env.DEV);
  return createHmac("sha256", secret).update("follow-digest:v1").digest();
}

function signature(userId: string, purpose: FollowDigestPurpose): string {
  return createHmac("sha256", signingKey())
    .update(`follow-digest:${purpose}:${userId}`)
    .digest("base64url");
}

export function createFollowDigestToken(userId: string, purpose: FollowDigestPurpose): string {
  return `${Buffer.from(userId).toString("base64url")}.${purpose}.${signature(userId, purpose)}`;
}

export function verifyFollowDigestToken(
  token: string,
  purpose: FollowDigestPurpose,
): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] !== purpose || !parts[0] || !parts[2]) {
    return null;
  }
  let userId: string;
  try {
    userId = Buffer.from(parts[0], "base64url").toString();
  } catch {
    return null;
  }
  if (!userId || Buffer.from(userId).toString("base64url") !== parts[0]) {
    return null;
  }
  const expected = Buffer.from(signature(userId, purpose));
  const received = Buffer.from(parts[2]);
  return received.length === expected.length && timingSafeEqual(received, expected) ? userId : null;
}

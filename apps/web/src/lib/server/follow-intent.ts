import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type FollowKind = "artist" | "label";

export type FollowTarget = { entityId: string; kind: FollowKind };

export const FOLLOW_INTENT_PARAM = "follow";

export const FOLLOW_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type IntentPayload = { e: string; h: string; i: string; k: FollowKind };

export function isFollowKind(value: unknown): value is FollowKind {
  return value === "artist" || value === "label";
}

export function parseFollowTarget(value: unknown): FollowTarget | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const entityId = typeof record.entityId === "string" ? record.entityId.trim() : "";

  if (!isFollowKind(record.kind) || !entityId || entityId.length > 200) {
    return undefined;
  }

  return { entityId, kind: record.kind };
}

function emailFingerprint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("base64url").slice(0, 22);
}

function intentSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(`follow-intent:${body}`).digest("base64url");
}

export function signFollowIntent({
  email,
  now = Date.now(),
  secret,
  target,
}: {
  email: string;
  now?: number;
  secret: string;
  target: FollowTarget;
}): string {
  const payload: IntentPayload = {
    e: String(now + FOLLOW_INTENT_TTL_MS),
    h: emailFingerprint(email),
    i: target.entityId,
    k: target.kind,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${body}.${intentSignature(secret, body)}`;
}

export function verifyFollowIntent({
  email,
  now = Date.now(),
  secret,
  token,
}: {
  email: string;
  now?: number;
  secret: string;
  token: string;
}): FollowTarget | undefined {
  const [body, signature, extra] = token.split(".");

  if (!body || !signature || extra !== undefined || token.length > 1000) {
    return undefined;
  }

  const expected = Buffer.from(intentSignature(secret, body));
  const received = Buffer.from(signature);

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return undefined;
  }

  let payload: Partial<IntentPayload>;

  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<IntentPayload>;
  } catch {
    return undefined;
  }

  const expiresAt = Number(payload.e);

  if (!Number.isFinite(expiresAt) || expiresAt < now) {
    return undefined;
  }

  if (payload.h !== emailFingerprint(email)) {
    return undefined;
  }

  return parseFollowTarget({ entityId: payload.i, kind: payload.k });
}

export function attachFollowIntent({
  baseUrl,
  intent,
  magicLinkUrl,
}: {
  baseUrl: string;
  intent: string;
  magicLinkUrl: string;
}): string {
  const url = new URL(magicLinkUrl);
  const callback = new URL(url.searchParams.get("callbackURL") ?? "/", baseUrl);

  if (callback.origin !== new URL(baseUrl).origin) {
    return magicLinkUrl;
  }

  callback.searchParams.set(FOLLOW_INTENT_PARAM, intent);
  url.searchParams.set("callbackURL", `${callback.pathname}${callback.search}`);

  return url.toString();
}

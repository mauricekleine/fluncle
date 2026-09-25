import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { resolvePublicAuthSecret } from "./public-auth";

export type FollowDigestPurpose = "manage" | "unsubscribe";

export class FollowDigestRecipientUnavailableError extends Error {
  constructor() {
    super("Active follow digest recipient not found");
    this.name = "FollowDigestRecipientUnavailableError";
  }
}

function signingKey(): Buffer {
  const secret = resolvePublicAuthSecret(process.env.BETTER_AUTH_SECRET, import.meta.env.DEV);
  return createHmac("sha256", secret).update("follow-digest:v1").digest();
}

const MANAGE_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function signature(body: string): string {
  return createHmac("sha256", signingKey()).update(`follow-digest:${body}`).digest("base64url");
}

function validSignature(body: string, received: string): boolean {
  const expected = Buffer.from(signature(body));
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function activeUserVersion(userId: string): Promise<number | null> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId],
    sql: `select coalesce(d.manage_token_version, 0) as version
      from "user" u left join user_follow_digests d on d.user_id = u.id
      where u.id = ? and u.status = 'active' limit 1`,
  });
  const version = result.rows[0]?.version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0
    ? version
    : null;
}

export async function createFollowDigestToken(
  userId: string,
  purpose: FollowDigestPurpose,
  now: Date = new Date(),
): Promise<string> {
  const version = await activeUserVersion(userId);
  if (version === null) {
    throw new FollowDigestRecipientUnavailableError();
  }
  const encoded = Buffer.from(userId).toString("base64url");
  if (purpose === "unsubscribe") {
    return `${encoded}.${purpose}.${signature(`${purpose}:${userId}`)}`;
  }
  const expiresAt = now.getTime() + MANAGE_TOKEN_LIFETIME_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Invalid follow digest token date");
  }
  return `${encoded}.${purpose}.${expiresAt}.${version}.${signature(`${purpose}:${userId}:${expiresAt}:${version}`)}`;
}

export async function verifyFollowDigestToken(
  token: string,
  purpose: FollowDigestPurpose,
  now: Date = new Date(),
): Promise<string | null> {
  const parts = token.split(".");
  if (parts[1] !== purpose || !parts[0]) {
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
  if (purpose === "unsubscribe") {
    if (parts.length !== 3 || !validSignature(`${purpose}:${userId}`, parts[2] ?? "")) {
      return null;
    }
    return (await activeUserVersion(userId)) === null ? null : userId;
  }
  if (parts.length !== 5) {
    return null;
  }
  const expiry = Number(parts[2]);
  const version = Number(parts[3]);
  if (
    !Number.isSafeInteger(expiry) ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    String(expiry) !== parts[2] ||
    String(version) !== parts[3] ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() >= expiry ||
    !validSignature(`${purpose}:${userId}:${expiry}:${version}`, parts[4] ?? "")
  ) {
    return null;
  }
  return (await activeUserVersion(userId)) === version ? userId : null;
}

export async function revokeFollowDigestManageLinks(userId: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const result = await (
    await getDb()
  ).execute({
    args: [userId, updatedAt, userId],
    sql: `insert into user_follow_digests (user_id, manage_token_version, updated_at)
      select ?, 1, ? where exists (select 1 from "user" where id = ? and status = 'active')
      on conflict(user_id) do update set
        manage_token_version = user_follow_digests.manage_token_version + 1,
        updated_at = excluded.updated_at`,
  });
  if (result.rowsAffected !== 1) {
    throw new FollowDigestRecipientUnavailableError();
  }
}

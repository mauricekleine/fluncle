import { getCookie } from "@tanstack/react-start/server";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_GRANT_MAX_AGE_MS,
  readEnv,
  readOptionalEnv,
  signAdminGrant,
  verifyAdminGrant,
} from "./env";
import { type SpotifyProfile } from "./spotify";

function parseAllowList(value: string, lowercase: boolean): Set<string> {
  return new Set(
    value.split(",").flatMap((entry) => {
      const trimmed = lowercase ? entry.trim().toLowerCase() : entry.trim();
      return trimmed ? [trimmed] : [];
    }),
  );
}

export async function isAllowedSpotifyUser(profile: SpotifyProfile): Promise<boolean> {
  const allowedEmails = parseAllowList(await readEnv("ADMIN_ALLOWED_EMAILS"), true);
  const allowedIds = parseAllowList(
    (await readOptionalEnv("ADMIN_ALLOWED_SPOTIFY_IDS")) ?? "",
    false,
  );
  const email = profile.email?.trim().toLowerCase();

  return (email !== undefined && allowedEmails.has(email)) || allowedIds.has(profile.id);
}

export async function signGrant(): Promise<string> {
  return signAdminGrant();
}

export async function verifyGrant(value: string | null | undefined): Promise<boolean> {
  return verifyAdminGrant(value);
}

export async function isAdminRequest(): Promise<boolean> {
  return verifyGrant(getCookie(ADMIN_COOKIE_NAME));
}

export function grantCookie(value: string): string {
  return [
    `${ADMIN_COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(ADMIN_GRANT_MAX_AGE_MS / 1000)}`,
    ...(import.meta.env.DEV ? [] : ["Secure"]),
  ].join("; ");
}

export function clearedGrantCookie(): string {
  return [
    `${ADMIN_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    ...(import.meta.env.DEV ? [] : ["Secure"]),
  ].join("; ");
}

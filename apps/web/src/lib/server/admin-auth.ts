// Web admin auth — the browser carrier for the single admin identity. The
// operator proves who they are with "Login with
// Spotify" (the existing Spotify app, allow-listed to one account), and we hand
// the browser a SIGNED GRANT COOKIE: `{ role: "admin", iat }` HMAC'd with
// FLUNCLE_API_TOKEN. The token is the signing KEY, never the cookie's value, so
// the secret never reaches the client. requireAdmin (env.ts) accepts this cookie
// OR the CLI's Bearer token — one identity, two carriers.

import { getCookie } from "@tanstack/react-start/server";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_GRANT_MAX_AGE_MS,
  readEnv,
  readOptionalEnv,
  signState,
  verifySignedState,
} from "./env";
import { type SpotifyProfile } from "./spotify";

// The operator allow-list comes from required env, never hardcoded in this public
// repo. ADMIN_ALLOWED_EMAILS is required (comma-separated, case-insensitive — the
// reliable check via user-read-email); ADMIN_ALLOWED_SPOTIFY_IDS is optional
// (comma-separated, exact — a belt-and-suspenders match when the email scope or
// display differs from the stable id).
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
  return signState({ iat: Date.now(), role: "admin" });
}

export async function verifyGrant(value: string | null | undefined): Promise<boolean> {
  if (!value) {
    return false;
  }

  try {
    const payload = await verifySignedState(value, ADMIN_GRANT_MAX_AGE_MS);

    return payload.role === "admin";
  } catch {
    return false;
  }
}

/**
 * Whether the current server request carries a valid admin grant cookie. Use
 * this at the TOP of every admin server function — a route beforeLoad guard only
 * protects the page render, not the RPC endpoint behind a server function, which
 * is directly callable (TanStack Start auth note).
 */
export async function isAdminRequest(): Promise<boolean> {
  return verifyGrant(getCookie(ADMIN_COOKIE_NAME));
}

// Set-Cookie strings for the login/logout responses. Secure is dropped in dev
// (no HTTPS on localhost) but the gate stays active so the flow is testable.
// Path=/ so the cookie reaches BOTH /admin/* (the page) and /api/admin/* (the
// write) — a /admin-scoped cookie would never be sent to the PATCH endpoint.
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

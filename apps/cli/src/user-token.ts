import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The USER-token store — HARD-SEPARATE from the admin `FLUNCLE_API_TOKEN`.
//
// Two identities, two carriers, two stores, no overlap:
//   - The ADMIN grant (`FLUNCLE_API_TOKEN` / `FLUNCLE_AGENT_TOKEN`) lives as an env
//     var, loaded by ./env.ts from `~/.config/fluncle/.env.<profile>`, and is sent
//     by ./api.ts `adminHeaders()`. It is the operator/agent's publishing authority.
//   - The USER token (a better-auth session token minted by `fluncle login`'s
//     device flow) lives HERE, in its own file (`~/.config/fluncle/user.<profile>.json`),
//     and is sent only by the `userHeaders()` path. It is one signed-in listener's
//     own account — their Galaxy progress + saved findings, nothing more.
//
// The boundary is enforced three ways, on purpose:
//   1. Distinct storage: a separate file the admin env-loader never reads, so the
//      user token can never be picked up as `FLUNCLE_API_TOKEN`.
//   2. Distinct read: this module is the ONLY reader of the user token; it never
//      touches `process.env.FLUNCLE_API_TOKEN`.
//   3. Distinct send: ./api.ts keeps `adminHeaders()` and `userHeaders()` apart,
//      so an admin request can never carry the user token and vice versa.

const envProfiles = ["local", "production"] as const;
const defaultEnvProfile = "production";

type UserProfile = (typeof envProfiles)[number];

type StoredUserToken = {
  baseUrl: string;
  token: string;
  // The signed-in identity, cached at login for a friendly `whoami`/logout. Never
  // load-bearing — the server is the source of truth on every authed read.
  user?: {
    id: string;
    name?: string;
    username?: string;
  };
};

function activeProfile(): UserProfile {
  const profile = process.env.FLUNCLE_ENV ?? defaultEnvProfile;

  return (envProfiles as readonly string[]).includes(profile)
    ? (profile as UserProfile)
    : defaultEnvProfile;
}

// The per-profile path. Keyed by profile so a `--env local` login never collides
// with the production token (mirroring `.env.<profile>` in ./env.ts).
function userTokenPath(): string {
  return join(homedir(), ".config", "fluncle", `user.${activeProfile()}.json`);
}

function isStoredUserToken(value: unknown): value is StoredUserToken {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return typeof record.token === "string" && typeof record.baseUrl === "string";
}

/** Read the stored user token for the active profile, or `undefined` if not signed in. */
export function readUserToken(): StoredUserToken | undefined {
  try {
    const parsed = JSON.parse(readFileSync(userTokenPath(), "utf8")) as unknown;

    return isStoredUserToken(parsed) ? parsed : undefined;
  } catch {
    // Missing file (never logged in) or unreadable/corrupt JSON → treated as
    // signed-out. The login flow rewrites it cleanly.
    return undefined;
  }
}

/** Persist the user token for the active profile with `0600` permissions. */
export function writeUserToken(value: StoredUserToken): void {
  const path = userTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Remove the stored user token for the active profile. Idempotent. */
export function clearUserToken(): boolean {
  const path = userTokenPath();

  try {
    readFileSync(path);
  } catch {
    return false;
  }

  rmSync(path, { force: true });

  return true;
}

/** The path the token is stored at, surfaced so the user can find/remove it. */
export function userTokenLocation(): string {
  return userTokenPath();
}

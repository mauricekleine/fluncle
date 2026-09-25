import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const envProfiles = ["local", "production"] as const;
const defaultEnvProfile = "production";

type UserProfile = (typeof envProfiles)[number];

type StoredUserToken = {
  baseUrl: string;
  token: string;

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

export function readUserToken(): StoredUserToken | undefined {
  try {
    const parsed = JSON.parse(readFileSync(userTokenPath(), "utf8")) as unknown;

    return isStoredUserToken(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeUserToken(value: StoredUserToken): void {
  const path = userTokenPath();

  const dir = dirname(path);
  mkdirSync(dir, { mode: 0o700, recursive: true });

  try {
    chmodSync(dir, 0o700);
  } catch {}

  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

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

export function userTokenLocation(): string {
  return userTokenPath();
}

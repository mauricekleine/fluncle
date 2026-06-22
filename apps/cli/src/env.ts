import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

const envProfiles = ["local", "production"] as const;
const defaultEnvProfile = "production";

const optionalKeys = ["FLUNCLE_API_BASE_URL", "FLUNCLE_API_TOKEN"] as const;

type EnvProfile = (typeof envProfiles)[number];
export type EnvKey = (typeof optionalKeys)[number];

let loadedProfile: EnvProfile | undefined;

export function setEnvProfile(profile: string | undefined): void {
  if (!profile) {
    return;
  }

  if (!isEnvProfile(profile)) {
    throw new Error(`Unknown env profile: ${profile}. Expected local or production.`);
  }

  process.env.FLUNCLE_ENV = profile;
}

export function loadEnv(keys: readonly EnvKey[]): Record<EnvKey, string> {
  loadConfig();

  const result = {} as Record<EnvKey, string>;
  const missing: EnvKey[] = [];

  for (const key of keys) {
    const value = process.env[key];

    // Narrow honestly: read once and check, instead of a `!` that lies about the
    // `string | undefined` type. A key cleared between this read and use can't slip
    // through typed as `string`.
    if (value === undefined) {
      missing.push(key);
      continue;
    }

    result[key] = value;
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return result;
}

export function getApiBaseUrl(): string {
  loadConfig();

  return (process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com").replace(/\/+$/, "");
}

function loadConfig(): void {
  const profile = getEnvProfile();

  if (loadedProfile === profile) {
    return;
  }

  config({ path: join(homedir(), `.config/fluncle/.env.${profile}`) });
  loadedProfile = profile;
}

function getEnvProfile(): EnvProfile {
  const profile = process.env.FLUNCLE_ENV ?? defaultEnvProfile;

  if (!isEnvProfile(profile)) {
    throw new Error(`Unknown env profile: ${profile}. Expected local or production.`);
  }

  return profile;
}

function isEnvProfile(value: string): value is EnvProfile {
  return (envProfiles as readonly string[]).includes(value);
}

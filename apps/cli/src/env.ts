import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

const envProfiles = ["local", "production"] as const;
const defaultEnvProfile = "production";

// Mixcloud distribution is CLI-direct (the Worker can't proxy multi-GB media), so
// the operator's own Mixcloud credentials live here, in the CLI env, exactly like
// FLUNCLE_API_TOKEN — they never touch the Worker. Provisioned via
// `fluncle admin auth mixcloud`.
const optionalKeys = [
  "FLUNCLE_API_BASE_URL",
  "FLUNCLE_API_TOKEN",
  "MIXCLOUD_ACCESS_TOKEN",
  "MIXCLOUD_CLIENT_ID",
  "MIXCLOUD_CLIENT_SECRET",
] as const;

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

  const missing = keys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return Object.fromEntries(keys.map((key) => [key, process.env[key]!])) as Record<EnvKey, string>;
}

export function getApiBaseUrl(): string {
  loadConfig();

  return (process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com").replace(/\/+$/, "");
}

/** The dotenv file backing the active profile — where `auth mixcloud` writes the token. */
export function getEnvFilePath(): string {
  return join(homedir(), `.config/fluncle/.env.${getEnvProfile()}`);
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
  return envProfiles.includes(value as EnvProfile);
}

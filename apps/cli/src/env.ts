import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

config({ path: ".env.local" });
config({ path: join(homedir(), ".config/fluncle/.env.local") });
config();

const requiredKeys = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REDIRECT_URI",
  "SPOTIFY_PLAYLIST_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

export type Env = Record<(typeof requiredKeys)[number], string>;
export type EnvKey = (typeof requiredKeys)[number];

export function loadEnv(keys: readonly EnvKey[] = requiredKeys): Record<EnvKey, string> {
  const missing = keys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return Object.fromEntries(keys.map((key) => [key, process.env[key]!])) as Record<EnvKey, string>;
}

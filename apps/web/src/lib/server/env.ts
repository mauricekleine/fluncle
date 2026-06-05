import { createHmac, timingSafeEqual } from "node:crypto";

let didLoadLocalEnv = false;

const envKeys = [
  "FLUNCLE_API_TOKEN",
  "LOOPS_API_KEY",
  "LOOPS_TRANSACTIONAL_ID",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REDIRECT_URI",
  "SPOTIFY_PLAYLIST_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "DISCORD_WEBHOOK_URL",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

export type EnvKey = (typeof envKeys)[number];

export async function loadLocalEnv(): Promise<void> {
  if (!import.meta.env.DEV || didLoadLocalEnv) {
    return;
  }

  const { config } = await import("dotenv");

  config({ path: ".dev.vars" });

  didLoadLocalEnv = true;
}

export async function readEnv(key: EnvKey): Promise<string> {
  await loadLocalEnv();

  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing ${key}`);
  }

  return value;
}

export async function readOptionalEnv(key: EnvKey): Promise<string | undefined> {
  await loadLocalEnv();

  const value = process.env[key];

  return value?.trim() ? value : undefined;
}

export async function readEnvs<const T extends readonly EnvKey[]>(
  keys: T,
): Promise<Record<T[number], string>> {
  await loadLocalEnv();

  return Object.fromEntries(
    keys.map((key) => {
      const value = process.env[key];

      if (!value) {
        throw new Error(`Missing ${key}`);
      }

      return [key, value];
    }),
  ) as Record<T[number], string>;
}

export async function requireAdmin(request: Request): Promise<Response | undefined> {
  const expectedToken = await readEnv("FLUNCLE_API_TOKEN");
  const header = request.headers.get("Authorization");
  const prefix = "Bearer ";

  if (!header?.startsWith(prefix)) {
    return unauthorized();
  }

  const actualToken = header.slice(prefix.length);

  if (!constantTimeEqual(actualToken, expectedToken)) {
    return unauthorized();
  }

  return undefined;
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    {
      code,
      message,
      ok: false,
    },
    { status },
  );
}

export async function signState(payload: Record<string, string | number>): Promise<string> {
  const token = await readEnv("FLUNCLE_API_TOKEN");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", token).update(body).digest("base64url");

  return `${body}.${signature}`;
}

export async function verifyState(state: string): Promise<Record<string, unknown>> {
  const token = await readEnv("FLUNCLE_API_TOKEN");
  const [body, signature] = state.split(".");

  if (!body || !signature) {
    throw new Error("Invalid state");
  }

  const expected = createHmac("sha256", token).update(body).digest("base64url");

  if (!constantTimeEqual(signature, expected)) {
    throw new Error("Invalid state");
  }

  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const issuedAt = typeof parsed.iat === "number" ? parsed.iat : 0;
  const maxAgeMs = 10 * 60 * 1000;

  if (Date.now() - issuedAt > maxAgeMs) {
    throw new Error("Expired state");
  }

  return parsed;
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Missing or invalid admin token");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

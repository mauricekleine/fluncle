#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME ?? homedir() ?? "/opt/data/home";

const WORKER_URL = (process.env.LIVE_WORKER_URL ?? "https://www.fluncle.com").replace(/\/+$/, "");
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? "";
const TWITCH_USER_LOGIN = process.env.TWITCH_USER_LOGIN ?? "flunclelive";
const FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.LIVE_TIMEOUT_MS ?? "", 10) || 5000;

const TOKEN_DIR = join(HOME, ".fluncle-live");
const TOKEN_FILE = join(TOKEN_DIR, "token.json");

const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

type CachedToken = { accessToken: string; expiresAtMs: number };

function log(message: string): void {
  process.stderr.write(`[fluncle-live] ${message}\n`);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readCachedToken(): CachedToken | null {
  if (!existsSync(TOKEN_FILE)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Partial<CachedToken>;

    if (
      typeof parsed.accessToken === "string" &&
      typeof parsed.expiresAtMs === "number" &&
      parsed.expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS
    ) {
      return { accessToken: parsed.accessToken, expiresAtMs: parsed.expiresAtMs };
    }
  } catch (error) {
    log(
      `token cache unreadable, re-minting: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

function writeCachedToken(token: CachedToken): void {
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  } catch (error) {
    log(
      `could not cache token (non-critical): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function mintToken(): Promise<CachedToken> {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const response = await fetchWithTimeout("https://id.twitch.tv/oauth2/token", {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Twitch token mint returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };

  if (!payload.access_token) {
    throw new Error("Twitch token mint response had no access_token");
  }

  const expiresAtMs = Date.now() + (payload.expires_in ?? 3600) * 1000;

  return { accessToken: payload.access_token, expiresAtMs };
}

async function getToken(): Promise<string> {
  const cached = readCachedToken();

  if (cached) {
    return cached.accessToken;
  }

  const minted = await mintToken();
  writeCachedToken(minted);

  return minted.accessToken;
}

type LivePoll = { live: boolean; title: string | null; startedAt: string | null };

export function buildLiveSummary(options: { at: string; poll: LivePoll; posted: boolean }): {
  at: string;
  checked: number;
  errors: number;
  failed: number;
  live: boolean;
  ok: true;
  posted: boolean;
  produced: number;
  queue_depth: number;
  title: string | null;
} {
  return {
    at: options.at,
    checked: 1,
    errors: 0,
    failed: options.posted ? 0 : 1,
    live: options.poll.live,
    ok: true,
    posted: options.posted,
    produced: options.posted ? 1 : 0,

    queue_depth: 0,
    title: options.poll.title,
  };
}

export function buildLiveFailureSummary(): {
  checked: null;
  errors: 1;
  failed: null;
  ok: false;
  produced: null;
  queue_depth: 0;
  reason: "poller_error";
} {
  return {
    checked: null,
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    queue_depth: 0,
    reason: "poller_error",
  };
}

async function pollTwitch(): Promise<LivePoll> {
  const url = `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(TWITCH_USER_LOGIN)}`;

  const read = async (token: string): Promise<Response> =>
    fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
      method: "GET",
    });

  let token = await getToken();
  let response = await read(token);

  if (response.status === 401) {
    log("Twitch returned 401 — re-minting the app token and retrying");
    const minted = await mintToken();
    writeCachedToken(minted);
    token = minted.accessToken;
    response = await read(token);
  }

  if (!response.ok) {
    throw new Error(`Twitch Get Streams returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ type?: string; title?: string; started_at?: string }>;
  };

  const stream = payload.data?.[0];

  if (!stream || (stream.type && stream.type !== "live")) {
    return { live: false, startedAt: null, title: null };
  }

  return { live: true, startedAt: stream.started_at ?? null, title: stream.title ?? null };
}

async function postLiveState(at: string, poll: LivePoll): Promise<boolean> {
  if (!WORKER_URL) {
    log("no LIVE_WORKER_URL — cannot POST the live state");

    return false;
  }

  if (!FLUNCLE_API_TOKEN) {
    log("no FLUNCLE_API_TOKEN in the cron env — cannot POST the live state");

    return false;
  }

  const body = JSON.stringify({
    at,
    live: poll.live,
    startedAt: poll.startedAt,
    title: poll.title,
  });

  const response = await fetchWithTimeout(`${WORKER_URL}/api/v1/admin/twitch/live`, {
    body,
    headers: {
      Authorization: `Bearer ${FLUNCLE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`record_live_state POST returned HTTP ${response.status}`);
  }

  return true;
}

export async function main(): Promise<void> {
  const at = new Date().toISOString();

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error(
      "missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET (populate ~/.fluncle-secrets.env)",
    );
  }

  const poll = await pollTwitch();
  const posted = await postLiveState(at, poll);

  console.log(JSON.stringify(buildLiveSummary({ at, poll, posted })));
}

if (import.meta.main) {
  main().catch(async (error) => {
    log(`poll failed, retrying once: ${error instanceof Error ? error.message : String(error)}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await main().catch((second) => {
      log(`fatal: ${second instanceof Error ? (second.stack ?? second.message) : String(second)}`);
      console.log(JSON.stringify(buildLiveFailureSummary()));
      process.exit(1);
    });
  });
}

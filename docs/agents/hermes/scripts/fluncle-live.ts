#!/usr/bin/env bun
// fluncle-live.ts — the bun orchestrator behind the `fluncle-live` `--no-agent`
// Hermes cron. The poller for Fluncle's cross-surface live-set callout.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (fluncle-live.sh) the
// cron runner execs every ~1m — see that file's header for the env keys + the
// `hermes cron create` wire-up, and ../cron/README.md § The live cron.
//
// THE TICK (all deterministic — no model time):
//   1. TOKEN: mint a Twitch client-credentials app token (public Helix reads, no app
//      review), cached to ${HOME}/.fluncle-live/token.json by its expiry so we don't
//      mint on every tick (app tokens last ~60 days).
//   2. POLL: GET https://api.twitch.tv/helix/streams?user_login=<login> with the
//      Client-Id + Bearer headers. A non-empty `data[]` ⇒ live (read `title` +
//      `started_at`); empty ⇒ offline.
//   3. POST the raw live state to ${LIVE_WORKER_URL}/api/admin/twitch/live
//      (record_live_state, Authorization: Bearer ${FLUNCLE_API_TOKEN}). The Worker
//      stores it, detects the transition, and owns the crew Telegram callout. This
//      poller is intentionally dumb: it reports state every minute, idempotently.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — the Twitch credentials + Worker origin come from the file-sourced env
// (the .sh sources ${HOME}/.live.env before exec'ing us); FLUNCLE_API_TOKEN rides
// the cron env. NO hostnames/tokens are hard-coded — public-safe by construction.
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? homedir() ?? "/opt/data/home";

const WORKER_URL = (process.env.LIVE_WORKER_URL ?? "").replace(/\/+$/, "");
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? "";
const TWITCH_USER_LOGIN = process.env.TWITCH_USER_LOGIN ?? "flunclelive";
const FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// Per-request network timeout. Short on purpose: a hung Twitch endpoint degrades to
// a clean failure well inside the runner's ~120s kill.
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.LIVE_TIMEOUT_MS ?? "", 10) || 5000;

// The app token is cached in the mounted, writable HOME so we don't mint per tick.
const TOKEN_DIR = join(HOME, ".fluncle-live");
const TOKEN_FILE = join(TOKEN_DIR, "token.json");

// Re-mint when the cached token has less than this left, so a tick never races the
// expiry. App tokens last ~60 days, so this is generous.
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

type CachedToken = { accessToken: string; expiresAtMs: number };

/** Diagnostics go to stderr so stdout stays the single JSON summary line. */
function log(message: string): void {
  process.stderr.write(`[fluncle-live] ${message}\n`);
}

/** A `fetch` with a hard AbortController timeout — resolves or throws, never hangs. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read the cached app token if present and still comfortably valid. */
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

/** Persist the freshly-minted token for the next tick (best-effort). */
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

/** Mint a client-credentials app token from Twitch (public-read scope, no review). */
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

  // expires_in is seconds; fall back to a conservative hour if absent.
  const expiresAtMs = Date.now() + (payload.expires_in ?? 3600) * 1000;

  return { accessToken: payload.access_token, expiresAtMs };
}

/** A valid app token: the cached one when fresh, otherwise a freshly minted one. */
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

/** One Helix `Get Streams` read for the channel. Retries once on a 401 (stale token). */
async function pollTwitch(): Promise<LivePoll> {
  const url = `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(TWITCH_USER_LOGIN)}`;

  const read = async (token: string): Promise<Response> =>
    fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
      method: "GET",
    });

  let token = await getToken();
  let response = await read(token);

  // A 401 means the cached token went stale (revoked/expired early) — mint a fresh
  // one once and retry, so a single bad token never wedges the poller.
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

  // A populated `data[]` with type "live" is the live signal; empty ⇒ offline.
  if (!stream || (stream.type && stream.type !== "live")) {
    return { live: false, startedAt: null, title: null };
  }

  return { live: true, startedAt: stream.started_at ?? null, title: stream.title ?? null };
}

/** POST the raw live state to the Worker (record_live_state). Returns whether it landed. */
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

  const response = await fetchWithTimeout(`${WORKER_URL}/api/admin/twitch/live`, {
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

// ---------------------------------------------------------------------------
// Main — mint/reuse the token, poll Twitch, POST the state.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const at = new Date().toISOString();

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error("missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET (populate ~/.live.env)");
  }

  const poll = await pollTwitch();
  const posted = await postLiveState(at, poll);

  // One JSON summary line — the cron run output. `ok` reflects the POLLER run, not
  // whether Fluncle is live (an offline channel is a normal, successful tick).
  console.log(
    JSON.stringify({
      at,
      live: poll.live,
      ok: true as const,
      posted,
      title: poll.title,
    }),
  );
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  console.log(JSON.stringify({ ok: false, reason: "poller_error" }));
  process.exit(1);
});

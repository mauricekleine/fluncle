import { createHash } from "node:crypto";
import { Data, Duration, Effect } from "effect";
import { runServerEffect } from "./effect/runtime";
import { readEnvs, readOptionalEnv } from "./env";
import { logEvent } from "./log";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";

const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const SIGNATURE_EXCLUDED = new Set(["api_sig", "callback", "format"]);

type LastfmError = { error?: number; message?: string };

const LASTFM_RETRYABLE_ERRORS = new Set([11, 16, 29]);

const LASTFM_REQUEST_TIMEOUT = Duration.millis(10_000);

export type LastfmLoveOutcome =
  | { ok: true }
  | { error: string; ok: false; rateLimited: boolean; retryAfterMs?: number };

class LastfmFailed extends Data.TaggedError("LastfmFailed")<{ message: string }> {}

class LastfmRateLimited extends Data.TaggedError("LastfmRateLimited")<{
  message: string;
  retryAfterMs?: number;
}> {}

class LastfmUnreachable extends Data.TaggedError("LastfmUnreachable")<{
  cause: unknown;
  message: string;
}> {}

export function signLastfmParams(params: Record<string, string>, sharedSecret: string): string {
  const concatenated = Object.keys(params)
    .filter((key) => !SIGNATURE_EXCLUDED.has(key))
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  return createHash("md5").update(`${concatenated}${sharedSecret}`, "utf8").digest("hex");
}

function callLastfm(
  params: Record<string, string>,
  sharedSecret: string,
): Effect.Effect<unknown, LastfmFailed | LastfmRateLimited | LastfmUnreachable> {
  const apiSig = signLastfmParams(params, sharedSecret);
  const body = new URLSearchParams({ ...params, api_sig: apiSig, format: "json" });

  return Effect.gen(function* () {
    const { json, response } = yield* Effect.tryPromise({
      catch: (cause) => new LastfmUnreachable({ cause, message: messageOf(cause) }),
      try: async (signal) => {
        const response = await fetch(API_ROOT, {
          body,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          method: "POST",
          signal,
        });

        return {
          json: (await response.json().catch(() => ({}))) as LastfmError,
          response,
        };
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: LASTFM_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new LastfmUnreachable({
              cause: new Error("Last.fm request timed out"),
              message: "Last.fm request timed out",
            }),
          ),
      }),
    );

    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));

    if (response.status === 429) {
      return yield* new LastfmRateLimited({
        message: `Last.fm request failed: 429 ${response.statusText}`,
        retryAfterMs,
      });
    }

    if (typeof json.error === "number") {
      if (LASTFM_RETRYABLE_ERRORS.has(json.error)) {
        return yield* new LastfmRateLimited({
          message: `Last.fm error ${json.error}: ${json.message ?? "unknown"}`,
          retryAfterMs,
        });
      }

      return yield* new LastfmFailed({
        message: `Last.fm error ${json.error}: ${json.message ?? "unknown"}`,
      });
    }

    if (!response.ok) {
      return yield* new LastfmFailed({
        message: `Last.fm request failed: ${response.status} ${response.statusText}`,
      });
    }

    return json;
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export async function lastfmLove(artist: string, track: string): Promise<LastfmLoveOutcome> {
  const cleanArtist = artist.trim();
  const cleanTrack = track.trim();

  if (!cleanArtist || !cleanTrack) {
    return { ok: true };
  }

  try {
    const sessionKey = await readOptionalEnv("LASTFM_SESSION_KEY");

    if (!sessionKey) {
      return { ok: true };
    }

    const env = await readEnvs(["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"]);

    await runServerEffect(
      callLastfm(
        {
          api_key: env.LASTFM_API_KEY,
          artist: cleanArtist,
          method: "track.love",
          sk: sessionKey,
          track: cleanTrack,
        },
        env.LASTFM_SHARED_SECRET,
      ),
    );

    return { ok: true };
  } catch (error) {
    const message = messageOf(error);
    logEvent("error", "lastfm.love-failed", { artist, error, track });

    if (error instanceof LastfmRateLimited) {
      return { error: message, ok: false, rateLimited: true, retryAfterMs: error.retryAfterMs };
    }

    return { error: message, ok: false, rateLimited: false };
  }
}

export async function lastfmGetToken(): Promise<{ authUrl: string; token: string }> {
  const env = await readEnvs(["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"]);
  const result = (await runServerEffect(
    callLastfm({ api_key: env.LASTFM_API_KEY, method: "auth.getToken" }, env.LASTFM_SHARED_SECRET),
  )) as { token?: string };

  if (!result.token) {
    throw new Error("Last.fm auth.getToken returned no token");
  }

  const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(
    env.LASTFM_API_KEY,
  )}&token=${encodeURIComponent(result.token)}`;

  return { authUrl, token: result.token };
}

export async function lastfmGetSession(
  token: string,
): Promise<{ name: string; sessionKey: string }> {
  const env = await readEnvs(["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"]);
  const result = (await runServerEffect(
    callLastfm(
      { api_key: env.LASTFM_API_KEY, method: "auth.getSession", token: token.trim() },
      env.LASTFM_SHARED_SECRET,
    ),
  )) as { session?: { key?: string; name?: string } };

  if (!result.session?.key) {
    throw new Error("Last.fm auth.getSession returned no session key");
  }

  return { name: result.session.name ?? "", sessionKey: result.session.key };
}

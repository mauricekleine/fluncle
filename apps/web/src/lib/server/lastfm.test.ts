import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastfmLove, signLastfmParams } from "@/lib/server/lastfm";

describe("signLastfmParams", () => {
  const secret = "MY_SHARED_SECRET";

  it("alphabetizes params, concatenates name+value, appends the secret, MD5s", () => {
    const params = {
      api_key: "KEY",
      method: "auth.getToken",
    };

    const expected = createHash("md5")
      .update("api_keyKEYmethodauth.getToken" + secret, "utf8")
      .digest("hex");

    expect(signLastfmParams(params, secret)).toBe(expected);
  });

  it("matches the spec's worked example (auth.getMobileSession)", () => {
    const params = {
      api_key: "YOUR_API_KEY",
      method: "auth.getMobileSession",
      password: "YOUR_PASSWORD",
      username: "YOUR_USERNAME",
    };
    const expected = createHash("md5")
      .update(
        "api_keyYOUR_API_KEYmethodauth.getMobileSessionpasswordYOUR_PASSWORDusernameYOUR_USERNAMEMY_SHARED_SECRET",
        "utf8",
      )
      .digest("hex");

    expect(signLastfmParams(params, secret)).toBe(expected);
  });

  it("excludes format, callback, and api_sig from the signature", () => {
    const signed = { api_key: "KEY", method: "track.love" };
    const withExcluded = {
      ...signed,
      api_sig: "stale",
      callback: "cb",
      format: "json",
    };

    expect(signLastfmParams(withExcluded, secret)).toBe(signLastfmParams(signed, secret));
  });

  it("orders sk/track/artist deterministically for track.love regardless of input order", () => {
    const a = {
      api_key: "KEY",
      artist: "Teddy Killerz",
      method: "track.love",
      sk: "SESSION",
      track: "Gate",
    };
    const b = {
      api_key: "KEY",
      artist: "Teddy Killerz",
      method: "track.love",
      sk: "SESSION",
      track: "Gate",
    };

    const expected = createHash("md5")
      .update("api_keyKEYartistTeddy Killerzmethodtrack.loveskSESSIONtrackGate" + secret, "utf8")
      .digest("hex");

    expect(signLastfmParams(a, secret)).toBe(expected);
    expect(signLastfmParams(b, secret)).toBe(expected);
  });
});

describe("lastfmLove", () => {
  beforeEach(() => {
    process.env.LASTFM_API_KEY = "KEY";
    process.env.LASTFM_SESSION_KEY = "SESSION";
    process.env.LASTFM_SHARED_SECRET = "SECRET";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.LASTFM_API_KEY;
    delete process.env.LASTFM_SESSION_KEY;
    delete process.env.LASTFM_SHARED_SECRET;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("completes the love when the endpoint answers 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ loved: true }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the network entirely when no session key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.LASTFM_SESSION_KEY;

    expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 429 to a rate-limited outcome carrying Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("slow down", {
          headers: { "Retry-After": "2" },
          status: 429,
          statusText: "Too Many Requests",
        }),
      ),
    );

    expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({
      error: "Last.fm request failed: 429 Too Many Requests",
      ok: false,
      rateLimited: true,
      retryAfterMs: 2_000,
    });
    expect(vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artist: "Calibre",
          event: "lastfm.love-failed",
          track: "Mr Right On",
        }),
      ]),
    );
  });

  it.each([11, 16, 29])(
    "maps retryable API error %i to a rate-limited outcome carrying Retry-After",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ error: code, message: "Service temporarily unavailable" }),
            {
              headers: { "Retry-After": "5" },
              status: 200,
            },
          ),
        ),
      );

      expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({
        error: `Last.fm error ${code}: Service temporarily unavailable`,
        ok: false,
        rateLimited: true,
        retryAfterMs: 5_000,
      });
    },
  );

  it("maps a non-retryable API error to a plain failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: 8, message: "Operation failed" })),
    );

    expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({
      error: "Last.fm error 8: Operation failed",
      ok: false,
      rateLimited: false,
    });
  });

  it("maps a thrown fetch to a plain failure carrying its message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({
      error: "network down",
      ok: false,
      rateLimited: false,
    });
  });

  it("treats an unparseable 200 body as a completed love", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));

    expect(await lastfmLove("Calibre", "Mr Right On")).toEqual({ ok: true });
  });

  it("bounds the call with a 10 second deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise<Response>(() => {})),
    );

    const pending = lastfmLove("Calibre", "Mr Right On");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toEqual({
      error: "Last.fm request timed out",
      ok: false,
      rateLimited: false,
    });
  });

  it("aborts a stalled response body within the same 10 second deadline", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () => {
                  aborted = true;
                  controller.error(new DOMException("aborted", "AbortError"));
                });
              },
            }),
          ),
        ),
      ),
    );

    const pending = lastfmLove("Calibre", "Mr Right On");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toEqual({
      error: "Last.fm request timed out",
      ok: false,
      rateLimited: false,
    });
    expect(aborted).toBe(true);
  });
});
